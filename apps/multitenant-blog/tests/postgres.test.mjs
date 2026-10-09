import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { createRuntime } from 'synajs'
import {
  DatabaseConfig,
  DatabasePool,
  PoolClosedError,
  PostgresContentStore,
  SiteConfigError,
  TransactionAbortedError,
  applyMigrations,
  define,
  siteConfigInputFromFixture,
} from '../dist/index.js'
import { fixture, repositoryConformance, sampleExtras } from './helpers/repository-conformance.mjs'

const connectionString = process.env.SYNA_TEST_PG_URL
if (!connectionString) {
  throw new Error(
    'SYNA_TEST_PG_URL is not set. The PostgreSQL tests never skip: run them through '
    + '`node scripts/pg-test-cluster.mjs with -- node --test apps/multitenant-blog/tests/postgres.test.mjs` '
    + 'or export SYNA_TEST_PG_URL=postgres://user@host:port/db.',
  )
}

const schema = `hyla_test_${randomBytes(4).toString('hex')}`
const max = 4
const config = { connectionString, schema, max }

const StoreEntry = define.entry('test-postgres-store', {
  requires: { store: PostgresContentStore, pool: DatabasePool },
  parameters: { config: DatabaseConfig },
})
const ChildEntry = define.entry('test-postgres-child', {
  requires: { store: PostgresContentStore, pool: DatabasePool },
})

const runtime = createRuntime({ services: [DatabasePool, PostgresContentStore] })

after(async () => {
  await runtime.dispose()
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    await client.query(`drop schema if exists ${pg.escapeIdentifier(schema)} cascade`)
  }
  finally {
    await client.end()
  }
})

repositoryConformance('postgres', async () => {
  const env = await runtime.enter(StoreEntry, { config })
  return { store: await env.deps.store.load(), dispose: () => env.dispose() }
})

const draft = (id, extra = {}) => ({
  id, slug: id, locale: 'en', title: id, body: `${id}\n`, status: 'draft', categories: [], tags: [], ...extra,
})

describe('postgres: transactions, pool sharing and disposal', () => {
  let env
  let store
  let pool

  before(async () => {
    env = await runtime.enter(StoreEntry, { config })
    store = await env.deps.store.load()
    pool = await env.deps.pool.load()
  })

  it('uses the isolated schema for every table and pins search_path', async () => {
    assert.equal(store.backend, 'postgres')
    assert.equal(pool.schema, schema)
    const tables = await pool.query(
      'select table_name from information_schema.tables where table_schema = $1 order by table_name',
      [schema],
    )
    assert.deepEqual(tables.rows.map(row => row.table_name), ['categories', 'content_versions', 'domains', 'posts', 'sites', 'tags'])
    const postKey = await pool.query(
      `select array_agg(a.attname::text order by k.ordinality) as columns
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         cross join lateral unnest(c.conkey) with ordinality as k(attnum, ordinality)
         join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
        where n.nspname = $1 and t.relname = 'posts' and c.contype = 'p'`,
      [schema],
    )
    assert.deepEqual(postKey.rows[0].columns, ['tenant_id', 'id'], 'posts are identified by (tenant_id, id)')
    const searchPath = await pool.withClient(client => client.query('show search_path'))
    assert.equal(searchPath.rows[0].search_path, schema)
    const inTransaction = await pool.withTransaction(client => client.query('show search_path'))
    assert.equal(inTransaction.rows[0].search_path, schema)
    const publicTables = await pool.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name in ('posts', 'sites', 'categories', 'tags', 'content_versions')",
    )
    assert.deepEqual(publicTables.rows, [], 'nothing leaked into public')
  })

  it('a raw update that leaves an invalid document is a SiteConfigError on read for that tenant, never a page (R4/B5)', async () => {
    const delta = store.forTenant('delta')
    await delta.saveSiteConfig({ ...siteConfigInputFromFixture('delta', fixture.tenants.alpha, sampleExtras), domains: ['delta.test'] })
    assert.equal((await delta.getSiteConfig()).configRevision, 1)
    await pool.query(`update sites set config = '{"title": 1, "theme": "dark"}'::jsonb where tenant_id = $1`, ['delta'])
    await assert.rejects(delta.getSiteConfig(), error => error instanceof SiteConfigError && error.code === 'INVALID_SITE_CONFIG' && error.mode === 'stored' && error.tenantId === 'delta')
    await store.deleteTenant('delta')
  })

  it('migrating a schema whose posts were keyed by id alone moves them to (tenant_id, id) and back-fills domain ownership (B1/B2)', async () => {
    const legacy = `${schema}_legacy`
    const legacyRuntime = createRuntime({ services: [DatabasePool, PostgresContentStore] })
    try {
      await pool.query(`create schema ${legacy}`)
      await pool.query(`create table ${legacy}.posts (id text primary key, tenant_id text not null, slug text not null, locale text not null, title text not null, body text not null, status text not null, categories text[] not null, primary_category text null, tags text[] not null, revision integer not null, created_at timestamptz not null, updated_at timestamptz not null, unique (tenant_id, slug))`)
      await pool.query(`create table ${legacy}.sites (tenant_id text primary key, config jsonb not null, config_revision integer not null)`)
      await pool.query(`insert into ${legacy}.sites (tenant_id, config, config_revision) values ('old-a', '{"domains": ["Old-A.test.", "shared.test:8080"]}', 3), ('old-b', '{"domains": ["old-b.test", "SHARED.TEST"]}', 1)`)
      const legacyEnv = await legacyRuntime.enter(StoreEntry, { config: { ...config, schema: legacy } })
      try {
        const legacyStore = await legacyEnv.deps.store.load()
        const key = await pool.query(
          `select array_agg(a.attname::text order by k.ordinality) as columns from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace cross join lateral unnest(c.conkey) with ordinality as k(attnum, ordinality) join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum where n.nspname = $1 and t.relname = 'posts' and c.contype = 'p'`,
          [legacy],
        )
        assert.deepEqual(key.rows[0].columns, ['tenant_id', 'id'])
        const domains = await pool.query(`select normalized_host, tenant_id from ${legacy}.domains order by normalized_host`)
        assert.deepEqual(domains.rows, [
          { normalized_host: 'old-a.test', tenant_id: 'old-a' },
          { normalized_host: 'old-b.test', tenant_id: 'old-b' },
          { normalized_host: 'shared.test', tenant_id: 'old-a' },
        ], 'one owner per normalized host; a host two stored configurations claim goes to the first tenant')
        // The migration is idempotent: running it again changes nothing.
        await applyMigrations(await legacyEnv.deps.pool.load())
        assert.deepEqual((await pool.query(`select count(*)::int as n from ${legacy}.domains`)).rows[0].n, 3)
        // And the same id now lives in two tenants.
        await legacyStore.forTenant('old-a').savePost(draft('same-id'))
        await legacyStore.forTenant('old-b').savePost(draft('same-id'))
        assert.equal((await pool.query(`select count(*)::int as n from ${legacy}.posts where id = 'same-id'`)).rows[0].n, 2)
      }
      finally {
        await legacyEnv.dispose()
      }
    }
    finally {
      await legacyRuntime.dispose()
      await pool.query(`drop schema if exists ${legacy} cascade`)
    }
  })

  it('a mutation and its content-version bump are one transaction on the public path: when the bump fails nothing is written (B3)', async () => {
    const epsilon = store.forTenant('epsilon')
    await epsilon.savePost(draft('eps-1'))
    const versionBefore = await epsilon.contentVersion()
    const removedBefore = pool.stats().removed
    await pool.query(`create or replace function ${schema}.refuse_bump() returns trigger language plpgsql as $$ begin raise exception 'bump refused'; end $$`)
    await pool.query(`create trigger refuse_bump before insert or update on ${schema}.content_versions for each row when (new.tenant_id = 'epsilon') execute function ${schema}.refuse_bump()`)
    try {
      await assert.rejects(epsilon.savePost(draft('eps-2')), /bump refused/)
      assert.equal(await epsilon.getPostById('eps-2'), undefined, 'the post write was rolled back with the bump')
      await assert.rejects(epsilon.deletePost('eps-1'), /bump refused/)
      assert.ok(await epsilon.getPostById('eps-1'), 'the delete was rolled back')
      await assert.rejects(epsilon.saveCategory({ slug: 'c', name: 'C' }), /bump refused/)
      assert.deepEqual(await epsilon.listCategories(), [])
      await assert.rejects(epsilon.saveTag({ slug: 't', name: 'T' }), /bump refused/)
      assert.deepEqual(await epsilon.listTags(), [])
      await assert.rejects(epsilon.saveSiteConfig({ ...siteConfigInputFromFixture('epsilon', fixture.tenants.alpha, sampleExtras), domains: ['epsilon.test'] }), /bump refused/)
      assert.equal(await epsilon.getSiteConfig(), undefined, 'the configuration write was rolled back')
      assert.deepEqual((await pool.query('select tenant_id from domains where normalized_host = $1', ['epsilon.test'])).rows, [], 'and so was its domain claim')
      assert.equal(await epsilon.contentVersion(), versionBefore)
      assert.equal(pool.stats().removed, removedBefore, 'a raised exception inside a transaction costs no connection')
    }
    finally {
      await pool.query(`drop trigger if exists refuse_bump on ${schema}.content_versions`)
      await pool.query(`drop function if exists ${schema}.refuse_bump()`)
    }
    // Control: without the trigger the same mutations commit.
    await epsilon.savePost(draft('eps-2'))
    assert.ok(await epsilon.getPostById('eps-2'))
    assert.notEqual(await epsilon.contentVersion(), versionBefore)
    await store.deleteTenant('epsilon')
  })

  it('pool: business errors hand the connection back, only connection-level errors destroy it (B4)', async () => {
    const removedBefore = pool.stats().removed
    const race = store.forTenant('pool-race')
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => race.savePost(draft(`pool-race-${index}`, { slug: 'contested' }))))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'exactly one writer owns the slug')
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.name === 'SlugConflictError').length, 19)
    assert.equal(pool.stats().removed, removedBefore, 'nineteen rejected transactions destroyed no connection')
    assert.ok(pool.stats().total <= max)
    await assert.rejects(pool.withTransaction(client => client.query('select 1/0')), error => error.code === '22012')
    assert.equal(pool.stats().removed, removedBefore, 'a failed statement is rolled back on a healthy connection')
    // The backend goes away under the lease: the query fails with a connection error and only that connection is dropped.
    await assert.rejects(pool.withClient(client => client.query('select pg_terminate_backend(pg_backend_pid())')), error => error.code === '57P01' || /terminat/i.test(error.message))
    assert.equal(pool.stats().removed, removedBefore + 1)
    assert.equal((await pool.query('select 1 as ok')).rows[0].ok, 1, 'the pool is still usable')
    assert.equal(pool.stats().waiting, 0)
    await store.deleteTenant('pool-race')
  })

  it('rolls back the whole transaction when work throws', async () => {
    const gamma = store.forTenant('gamma')
    await assert.rejects(
      store.transaction('gamma', async repository => {
        await repository.saveCategory({ slug: 'c', name: 'C' })
        await repository.saveTag({ slug: 't', name: 'T' })
        await repository.savePost(draft('gamma-1'))
        await repository.savePost(draft('gamma-2'))
        assert.equal((await repository.listPosts({ visibility: 'all' })).length, 2, 'visible inside the transaction')
        throw new Error('boom')
      }),
      /boom/,
    )
    assert.deepEqual(await gamma.listPosts({ visibility: 'all' }), [])
    assert.deepEqual(await gamma.listCategories(), [])
    assert.deepEqual(await gamma.listTags(), [])
    assert.ok(!(await store.listTenants()).includes('gamma'))
    const rows = await pool.query('select count(*)::int as n from posts where tenant_id = $1', ['gamma'])
    assert.equal(rows.rows[0].n, 0)
    assert.equal(pool.stats().waiting, 0)

    // A slug conflict inside a transaction rolls back the earlier writes too.
    await assert.rejects(store.transaction('gamma', async repository => {
      await repository.savePost(draft('gamma-3'))
      await repository.savePost(draft('gamma-4', { slug: 'gamma-3' }))
    }))
    assert.equal(await gamma.getPostById('gamma-3'), undefined)
  })

  it('keeps concurrent transactions on different tenants from interleaving state', async () => {
    const count = 12
    const insertAll = tenantId => store.transaction(tenantId, async repository => {
      for (let index = 0; index < count; index += 1) {
        await repository.savePost(draft(`${tenantId}-${index}`, { createdAt: `2026-04-${String(index + 1).padStart(2, '0')}T00:00:00.000Z` }))
        // Yield so the two transactions really interleave on the event loop.
        await new Promise(resolve => setImmediate(resolve))
      }
      const seen = await repository.listPosts({ visibility: 'all' })
      return seen.map(post => post.id)
    })
    const [c1, c2] = await Promise.all([insertAll('c1'), insertAll('c2')])
    assert.equal(c1.length, count)
    assert.equal(c2.length, count)
    assert.ok(c1.every(id => id.startsWith('c1-')))
    assert.ok(c2.every(id => id.startsWith('c2-')))
    assert.equal((await store.forTenant('c1').listPosts({ visibility: 'all' })).length, count)
    assert.equal((await store.forTenant('c2').listPosts({ visibility: 'all' })).length, count)
    assert.deepEqual((await store.listTenants()).filter(id => id.startsWith('c')), ['c1', 'c2'])
  })

  it('serializes conflicting writers on the unique (tenant_id, slug) constraint', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => store.transaction('race', repository => repository.savePost(draft(`race-${index}`, { slug: 'same' })))),
    )
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    assert.equal(fulfilled.length, 1, 'exactly one writer owns the slug')
    for (const result of results.filter(result => result.status === 'rejected')) {
      assert.equal(result.reason.name, 'SlugConflictError')
    }
    assert.equal((await store.forTenant('race').listPosts({ visibility: 'all' })).length, 1)
  })

  it('shares one pool across repositories and child Envs and stays within max', async () => {
    const child = await env.enter(ChildEntry)
    try {
      assert.strictEqual(await child.deps.pool.load(), pool, 'child Env loads the same pool instance')
      assert.strictEqual(await child.deps.store.load(), store, 'child Env loads the same store instance')
      const poolNodes = inspection => inspection.nodes.filter(node => node.label.startsWith(`${DatabasePool.family.id}@`))
      assert.equal(poolNodes(child.inspect()).length, 1)
      assert.equal(poolNodes(child.inspect())[0].slotId, poolNodes(env.inspect())[0].slotId)

      const alpha = store.forTenant('pool-a')
      const beta = store.forTenant('pool-b')
      let peak = 0
      const observe = () => { peak = Math.max(peak, pool.stats().total) }
      const timer = setInterval(observe, 1)
      try {
        await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? alpha : beta)
          .savePost(draft(`pool-${index}`))
          .then(observe)))
      }
      finally {
        clearInterval(timer)
      }
      observe()
      assert.ok(peak >= 2, `the pool did open several connections (peak ${peak})`)
      assert.ok(peak <= max, `pool total ${peak} must stay within max ${max}`)
      assert.equal(pool.stats().waiting, 0)
      assert.equal((await alpha.listPosts({ visibility: 'all' })).length, 20)
      assert.equal((await beta.listPosts({ visibility: 'all' })).length, 20)
    }
    finally {
      await child.dispose()
    }
    assert.ok(pool.stats().total >= 1, 'disposing the child does not close the shared pool')
    assert.equal((await pool.query('select 1 as ok')).rows[0].ok, 1)
  })

  it('ends the pool on runtime.dispose()', async () => {
    await runtime.dispose()
    await assert.rejects(pool.query('select 1'), /after calling end|ended|closed/i)
    await assert.rejects(store.forTenant('alpha').listPosts({ visibility: 'all' }))
    assert.equal(pool.stats().total, 0)
  })
})

// Regressions for the third re-audit's backend findings (F-BD3-01, 04, 06, 07, 08); the
// cases both backends share live in the conformance suite.
describe('postgres: audit-3 regressions', () => {
  const auditSchema = `${schema}_a3`
  const auditConfig = { connectionString, schema: auditSchema, max: 4, lockTimeoutMs: 500 }
  const PoolEntry = define.entry('test-postgres-pool-only', { requires: { pool: DatabasePool }, parameters: { config: DatabaseConfig } })
  const auditRuntime = createRuntime({ services: [DatabasePool, PostgresContentStore] })
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const codesOf = error => (error instanceof AggregateError ? error.errors.flatMap(codesOf) : [error?.code])
  const extraSchemas = []
  let env
  let store
  let pool

  before(async () => {
    env = await auditRuntime.enter(StoreEntry, { config: auditConfig })
    store = await env.deps.store.load()
    pool = await env.deps.pool.load()
  })

  after(async () => {
    await auditRuntime.dispose().catch(() => undefined)
    const client = new pg.Client({ connectionString })
    await client.connect()
    try {
      for (const name of [auditSchema, ...extraSchemas]) await client.query(`drop schema if exists ${pg.escapeIdentifier(name)} cascade`)
    }
    finally {
      await client.end()
    }
  })

  it('a unit of work that continues past a failed statement is TransactionAbortedError, and nothing of it is written (F-BD3-01)', async () => {
    await assert.rejects(
      pool.withTransaction(async client => { await client.query('select 1/0').catch(() => undefined); return 'resolved' }),
      error => error instanceof TransactionAbortedError && error.code === 'TRANSACTION_ABORTED',
    )
    assert.equal(pool.stats().removed, 0, 'the connection is healthy after the rollback')
    // Through the store: a trigger makes one statement of the unit of work fail; the work handles it and goes on.
    await pool.query(`create or replace function boom_category() returns trigger language plpgsql as $$ begin if new.slug = 'boom' then raise exception 'boom'; end if; return new; end $$`)
    await pool.query('create trigger boom before insert on categories for each row execute function boom_category()')
    const tenant = 'aborted'
    const repository = store.forTenant(tenant)
    await repository.saveCategory({ slug: 'existing', name: 'Existing' })
    const before = await repository.contentVersion()
    try {
      await assert.rejects(store.transaction(tenant, async work => {
        await work.saveCategory({ slug: 'kept', name: 'Kept' })
        const failed = await work.saveCategory({ slug: 'boom', name: 'Boom' }).then(() => 'saved', error => error)
        assert.equal(failed.message, 'boom')
        return 'resolved anyway'
      }), error => error instanceof TransactionAbortedError)
      assert.deepEqual((await repository.listCategories()).map(item => item.slug), ['existing'], 'the earlier write of the unit of work was rolled back with it')
      assert.equal(await repository.contentVersion(), before, 'and so was its version bump')
      assert.equal(pool.stats().removed, 0)
    }
    finally {
      await pool.query('drop trigger boom on categories')
      await store.deleteTenant(tenant)
    }
  })

  it('a mutation that waits for a lock another session holds fails with SQLSTATE 55P03 after lockTimeoutMs, keeping the connection (F-BD3-04)', async () => {
    assert.equal((await pool.query("select current_setting('lock_timeout') as value")).rows[0].value, '500ms')
    const tenant = 'locked'
    let release
    const held = new Promise(resolve => { release = resolve })
    const holder = store.transaction(tenant, async repository => {
      await repository.saveCategory({ slug: 'held', name: 'Held' })
      await held
      return 'done'
    })
    await sleep(50)
    const started = Date.now()
    await assert.rejects(store.forTenant(tenant).saveTag({ slug: 'waiting', name: 'Waiting' }), error => error.code === '55P03')
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 400 && elapsed < 3_000, `waited ${elapsed} ms for the lock`)
    release()
    assert.equal(await holder, 'done')
    assert.equal(pool.stats().removed, 0, 'a lock timeout is a business error: the connection is kept')
    // Once the unit of work ended, the same write goes through.
    await store.forTenant(tenant).saveTag({ slug: 'waiting', name: 'Waiting' })
    await store.deleteTenant(tenant)
  })

  it('two units of work on one tenant that touch the same posts in a different order serialize on the tenant lock: no deadlock (F-BD3-07)', async () => {
    const tenant = 'order'
    const repository = store.forTenant(tenant)
    await repository.savePost(draft('a'))
    await repository.savePost(draft('b'))
    const first = store.transaction(tenant, async work => {
      await work.savePost(draft('a', { title: 'a1' }))
      await sleep(100)
      await work.savePost(draft('b', { title: 'b1' }))
      return 'first'
    })
    await sleep(20)
    const second = store.transaction(tenant, async work => {
      await work.savePost(draft('b', { title: 'b2' }))
      await work.savePost(draft('a', { title: 'a2' }))
      return 'second'
    })
    assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
    assert.deepEqual([(await repository.getPostById('a')).title, (await repository.getPostById('b')).title], ['a2', 'b2'], 'the second unit of work ran after the first')
    assert.equal(pool.stats().removed, 0)
    await store.deleteTenant(tenant)
  })

  it('starting on a schema whose stored configuration has a malformed domains value succeeds, and the back-fill runs once (F-BD3-06)', async () => {
    const legacy = `${auditSchema}_legacy`
    extraSchemas.push(legacy)
    await pool.query(`create schema ${legacy}`)
    await pool.query(`create table ${legacy}.sites (tenant_id text primary key, config jsonb not null, config_revision integer not null)`)
    await pool.query(`insert into ${legacy}.sites (tenant_id, config, config_revision) values
      ('good', '{"domains": ["Good.test"]}', 1),
      ('scalar', '{"domains": "not-a-list"}', 1),
      ('object', '{"domains": {"a": 1}}', 1),
      ('mixed', '{"domains": ["Mixed.test:8080", 5, null, {"x": 1}]}', 1)`)
    const legacyRuntime = createRuntime({ services: [DatabasePool, PostgresContentStore] })
    try {
      const legacyEnv = await legacyRuntime.enter(StoreEntry, { config: { ...auditConfig, schema: legacy } })
      const legacyStore = await legacyEnv.deps.store.load()
      const rows = await pool.query(`select normalized_host, tenant_id from ${legacy}.domains order by 1`)
      assert.deepEqual(rows.rows, [{ normalized_host: 'good.test', tenant_id: 'good' }, { normalized_host: 'mixed.test', tenant_id: 'mixed' }])
      await assert.rejects(legacyStore.forTenant('scalar').getSiteConfig(), SiteConfigError)
      await assert.rejects(legacyStore.forTenant('object').getSiteConfig(), SiteConfigError)
      // The back-fill belongs to the creation of the table: a later start does not re-fill it.
      await pool.query(`insert into ${legacy}.sites (tenant_id, config, config_revision) values ('later', '{"domains": ["later.test"]}', 1)`)
      await pool.query(`delete from ${legacy}.domains where tenant_id = 'good'`)
      await applyMigrations(await legacyEnv.deps.pool.load())
      assert.deepEqual((await pool.query(`select normalized_host from ${legacy}.domains order by 1`)).rows.map(row => row.normalized_host), ['mixed.test'])
    }
    finally {
      await legacyRuntime.dispose()
    }
  })

  it('closing the pool rejects queued leases at once, waits closeTimeoutMs for leased connections, and terminates and reports one that never comes back (F-BD3-08)', async () => {
    const small = createRuntime({ services: [DatabasePool] })
    const smallEnv = await small.enter(PoolEntry, { config: { ...auditConfig, max: 1, closeTimeoutMs: 300 } })
    const smallPool = await smallEnv.deps.pool.load()
    let releaseHold
    const hold = new Promise(resolve => { releaseHold = resolve })
    const holder = smallPool.withClient(async () => { await hold; return 'held' })
    await sleep(50)
    const waiter = smallPool.withClient(async () => 'served').then(value => value, error => error)
    await sleep(50)
    assert.deepEqual([smallPool.stats().waiting, smallPool.stats().leased], [1, 1])
    const disposing = small.dispose()
    const refused = await waiter
    assert.ok(refused instanceof PoolClosedError, `queued lease: ${refused}`)
    assert.equal(smallPool.stats().waiting, 0)
    await sleep(100)
    releaseHold() // the holder comes back inside closeTimeoutMs
    assert.equal(await holder, 'held')
    await disposing
    await assert.rejects(smallPool.withClient(async () => 'late'), PoolClosedError)

    const stuck = createRuntime({ services: [DatabasePool] })
    const stuckEnv = await stuck.enter(PoolEntry, { config: { ...auditConfig, max: 1, closeTimeoutMs: 100 } })
    const stuckPool = await stuckEnv.deps.pool.load()
    const never = stuckPool.withClient(client => client.query('select pg_sleep(30)')).then(() => 'finished', error => error)
    await sleep(50)
    const started = Date.now()
    await assert.rejects(stuck.dispose(), error => codesOf(error).includes('POOL_CLOSE_TIMEOUT'))
    assert.ok(Date.now() - started < 2_000, 'the disposal is bounded by closeTimeoutMs')
    const outcome = await never
    assert.ok(outcome instanceof Error, 'the terminated lease fails instead of running on')
    assert.deepEqual([stuckPool.stats().leased, stuckPool.stats().removed, stuckPool.stats().total], [0, 1, 0])
  })
})
