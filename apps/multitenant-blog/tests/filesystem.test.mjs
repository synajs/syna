import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createRuntime } from 'syna'
import {
  BlogLayout,
  ContentLayoutChoice,
  ContentRoot,
  DefaultLayout,
  FilesystemContentStore,
  KeyedMutex,
  SiteConfigError,
  UnsafePathError,
  define,
  readFrontMatter,
  safeJoin,
  seedTenantContent,
  serializePost,
  siteConfigInputFromFixture,
  writeFileAtomic,
  writeFrontMatter,
} from '../dist/index.js'
import { fixture, repositoryConformance, sampleExtras } from './helpers/repository-conformance.mjs'

const StoreEntry = define.entry('test-filesystem-store', {
  requires: { store: FilesystemContentStore },
  parameters: { root: ContentRoot, layout: ContentLayoutChoice },
})

const runtime = createRuntime({ services: [FilesystemContentStore, DefaultLayout, BlogLayout] })
const tempDirs = []

async function makeTempDir(prefix = 'hyla-fs-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function makeStore(layout) {
  const rootDir = await makeTempDir()
  const env = await runtime.enter(StoreEntry, { root: { rootDir }, layout: ContentLayoutChoice.to(layout) })
  const store = await env.deps.store.load()
  return { store, rootDir, env, dispose: () => env.dispose() }
}

const exists = async target => stat(target).then(() => true, error => {
  if (error.code === 'ENOENT') return false
  throw error
})

after(async () => {
  await runtime.dispose()
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

repositoryConformance('filesystem/default layout', () => makeStore(DefaultLayout))
repositoryConformance('filesystem/blog layout', () => makeStore(BlogLayout))

describe('filesystem: layouts and renames', () => {
  let byDefault
  let byBlog

  before(async () => {
    byDefault = await makeStore(DefaultLayout)
    byBlog = await makeStore(BlogLayout)
    await seedTenantContent(byDefault.store, 'alpha', fixture.tenants.alpha)
    await seedTenantContent(byBlog.store, 'alpha', fixture.tenants.alpha)
  })

  after(async () => {
    await byDefault.dispose()
    await byBlog.dispose()
  })

  it('reports the filesystem backend', () => {
    assert.equal(byDefault.store.backend, 'filesystem')
    assert.equal(byBlog.store.backend, 'filesystem')
  })

  it('DefaultLayout stores posts/<slug>.md and BlogLayout posts/<primaryCategory>/<slug>.md', async () => {
    assert.ok(await exists(path.join(byDefault.rootDir, 'alpha', 'posts', 'hello-world.md')))
    assert.ok(!(await exists(path.join(byDefault.rootDir, 'alpha', 'posts', 'engineering'))))
    assert.ok(await exists(path.join(byBlog.rootDir, 'alpha', 'posts', 'engineering', 'hello-world.md')))
    assert.ok(await exists(path.join(byBlog.rootDir, 'alpha', 'posts', 'notes', 'shared-slug.md')), 'first category is the primary one')
    assert.ok(!(await exists(path.join(byBlog.rootDir, 'alpha', 'posts', 'hello-world.md'))))
    assert.ok(await exists(path.join(byBlog.rootDir, 'alpha', 'categories.json')))
    assert.ok(await exists(path.join(byBlog.rootDir, 'alpha', 'tags.json')))

    const text = await readFile(path.join(byBlog.rootDir, 'alpha', 'posts', 'engineering', 'hello-world.md'), 'utf8')
    const { data, body } = readFrontMatter(text)
    assert.equal(data.id, 'alpha-p1')
    assert.equal(data.slug, 'hello-world')
    assert.equal(data.primaryCategory, 'engineering')
    assert.deepEqual(data.categories, ['engineering', 'notes'])
    assert.equal(data.revision, 1)
    assert.equal(data.createdAt, '2026-01-10T08:00:00.000Z')
    assert.equal(body, fixture.tenants.alpha.posts[0].body)
  })

  it('renaming slug and primary category moves the file and keeps the id', async () => {
    const repo = byBlog.store.forTenant('alpha')
    const original = fixture.tenants.alpha.posts.find(post => post.id === 'alpha-p1')
    const { createdAt, updatedAt, ...rest } = original
    const saved = await repo.savePost({ ...rest, slug: 'hello-again', categories: ['notes', 'engineering'], primaryCategory: 'notes' })
    assert.equal(saved.id, 'alpha-p1')
    assert.equal(saved.revision, 2)
    assert.equal(saved.createdAt, createdAt)

    const oldPath = path.join(byBlog.rootDir, 'alpha', 'posts', 'engineering', 'hello-world.md')
    const newPath = path.join(byBlog.rootDir, 'alpha', 'posts', 'notes', 'hello-again.md')
    assert.ok(!(await exists(oldPath)), 'old path is gone')
    assert.ok(await exists(newPath), 'new path exists')
    assert.equal(readFrontMatter(await readFile(newPath, 'utf8')).data.id, 'alpha-p1')

    assert.equal((await repo.getPostById('alpha-p1'))?.slug, 'hello-again')
    assert.equal((await repo.getPost('hello-again', { visibility: 'public' }))?.id, 'alpha-p1')
    assert.equal(await repo.getPost('hello-world', { visibility: 'all' }), undefined)
    assert.equal((await repo.listPosts({ visibility: 'all' })).length, 4, 'no duplicate left behind')

    // Same for the flat layout: only the slug can move the file there.
    const flat = byDefault.store.forTenant('alpha')
    await flat.savePost({ ...rest, slug: 'hello-again' })
    assert.ok(!(await exists(path.join(byDefault.rootDir, 'alpha', 'posts', 'hello-world.md'))))
    assert.ok(await exists(path.join(byDefault.rootDir, 'alpha', 'posts', 'hello-again.md')))
    assert.equal((await flat.getPostById('alpha-p1'))?.revision, 2)
  })

  it('identity comes from the front matter, not the file name', async () => {
    const repo = byDefault.store.forTenant('alpha')
    const misnamed = path.join(byDefault.rootDir, 'alpha', 'posts', 'not-the-slug.md')
    await writeFile(misnamed, writeFrontMatter({
      id: 'manual-1', slug: 'manual-slug', locale: 'en', title: 'Manual', status: 'published',
      categories: [], primaryCategory: null, tags: [], revision: 7,
      createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
    }, 'hand written\n'))
    await writeFile(path.join(byDefault.rootDir, 'alpha', 'posts', 'README.txt'), 'ignored\n')
    const post = await repo.getPost('manual-slug', { visibility: 'public' })
    assert.equal(post?.id, 'manual-1')
    assert.equal(post?.revision, 7)
    assert.equal(post?.body, 'hand written\n')
    // Saving it moves the file to its layout path and removes the misnamed one.
    const saved = await repo.savePost({ id: 'manual-1', slug: 'manual-slug', locale: 'en', title: 'Manual', body: 'edited\n', status: 'published', categories: [], tags: [] })
    assert.equal(saved.revision, 8)
    assert.ok(!(await exists(misnamed)))
    assert.ok(await exists(path.join(byDefault.rootDir, 'alpha', 'posts', 'manual-slug.md')))
  })
})

describe('filesystem: path safety', () => {
  let handle

  before(async () => {
    handle = await makeStore(DefaultLayout)
    await seedTenantContent(handle.store, 'alpha', fixture.tenants.alpha)
  })

  after(async () => {
    await handle.dispose()
  })

  it('safeJoin rejects traversal, absolute segments and escapes', () => {
    const root = handle.rootDir
    assert.equal(safeJoin(root, 'alpha', 'posts/x.md'), path.join(root, 'alpha', 'posts', 'x.md'))
    assert.throws(() => safeJoin(root, '../x'), UnsafePathError)
    assert.throws(() => safeJoin(root, 'alpha', '../../x'), UnsafePathError)
    assert.throws(() => safeJoin(root, 'posts/../../x.md'), UnsafePathError)
    assert.throws(() => safeJoin(root, '/etc/passwd'), UnsafePathError)
    assert.throws(() => safeJoin(root, 'a\0b'), UnsafePathError)
    assert.throws(() => safeJoin(root, ''), UnsafePathError)
    assert.throws(() => safeJoin('relative/root', 'a'), UnsafePathError)
  })

  it('a stored site.json that is not a site configuration is a SiteConfigError for that tenant, never a page (R4/B5)', async () => {
    const { store, rootDir } = handle
    const alpha = store.forTenant('alpha')
    await alpha.saveSiteConfig({ ...siteConfigInputFromFixture('alpha', fixture.tenants.alpha, sampleExtras) })
    const file = path.join(rootDir, 'alpha', 'site.json')
    const good = await readFile(file, 'utf8')
    // Edited behind the store's back: a string where the theme should be, a script href.
    const broken = { ...JSON.parse(good), theme: 'dark', navigation: [{ label: 'x', href: 'javascript:alert(1)' }] }
    await writeFile(file, JSON.stringify(broken))
    await assert.rejects(alpha.getSiteConfig(), error => error instanceof SiteConfigError && error.code === 'INVALID_SITE_CONFIG' && error.mode === 'stored' && error.tenantId === 'alpha' && error.problems.length >= 1)
    await writeFile(file, '{"title": 1}')
    await assert.rejects(alpha.getSiteConfig(), SiteConfigError)
    await writeFile(file, good)
    assert.equal((await alpha.getSiteConfig()).title, fixture.tenants.alpha.site.title, 'restored')
  })

  it('rejects path traversal in tenant ids and slugs', async () => {
    const { store } = handle
    assert.throws(() => store.forTenant('../x'), TypeError)
    assert.throws(() => store.forTenant('a/b'), TypeError)
    assert.throws(() => store.forTenant('..'), TypeError)
    await assert.rejects(store.deleteTenant('../x'), TypeError)
    await assert.rejects(store.deleteTenant('a/b'), TypeError)
    await assert.rejects(store.transaction('../x', async () => {}), TypeError)
    const repo = store.forTenant('alpha')
    const base = { id: 'trav', locale: 'en', title: 't', body: '', status: 'published', categories: [], tags: [] }
    await assert.rejects(repo.savePost({ ...base, slug: '../x' }), TypeError)
    await assert.rejects(repo.savePost({ ...base, slug: 'a/b' }), TypeError)
    await assert.rejects(repo.savePost({ ...base, slug: 'ok', categories: ['../x'] }), TypeError)
    await assert.rejects(repo.savePost({ ...base, id: '../escape', slug: 'ok' }), TypeError)
    assert.ok(!(await exists(path.join(handle.rootDir, 'x.md'))))
    assert.ok(!(await exists(path.join(path.dirname(handle.rootDir), 'x.md'))))
    // Nothing outside the tenant directory was created.
    assert.deepEqual((await readdir(handle.rootDir)).sort(), ['alpha'])
  })

  it('refuses symlinked post files and symlinked tenant directories', async () => {
    const { store, rootDir } = handle
    const outside = await makeTempDir('hyla-outside-')
    const outsidePost = path.join(outside, 'secret.md')
    await writeFile(outsidePost, writeFrontMatter({
      id: 'outside-1', slug: 'outside', locale: 'en', title: 'Outside', status: 'published',
      categories: [], primaryCategory: null, tags: [], revision: 1,
      createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
    }, 'OUTSIDE-SECRET\n'))

    const alpha = store.forTenant('alpha')
    const link = path.join(rootDir, 'alpha', 'posts', 'evil.md')
    await symlink(outsidePost, link)
    await assert.rejects(alpha.listPosts({ visibility: 'all' }), /symbolic link/)
    await assert.rejects(alpha.getPost('outside', { visibility: 'all' }), /symbolic link/)
    await assert.rejects(alpha.savePost({ id: 'x', slug: 'x', locale: 'en', title: 'x', body: '', status: 'draft', categories: [], tags: [] }), /symbolic link/)
    await rm(link)
    assert.equal((await alpha.listPosts({ visibility: 'all' })).length, 4)

    // A symlinked tenant directory pointing outside the root.
    const outsideTenant = await makeTempDir('hyla-outside-tenant-')
    await mkdir(path.join(outsideTenant, 'posts'))
    await writeFile(path.join(outsideTenant, 'categories.json'), '[]\n')
    await symlink(outsideTenant, path.join(rootDir, 'zeta'))
    const zeta = store.forTenant('zeta')
    await assert.rejects(zeta.listPosts({ visibility: 'all' }), /symbolic link/)
    await assert.rejects(zeta.listCategories(), /symbolic link/)
    await assert.rejects(zeta.saveCategory({ slug: 'c', name: 'C' }), /symbolic link/)
    await assert.rejects(zeta.saveSiteConfig({ ...siteConfigInputFromFixture('zeta', fixture.tenants.alpha, sampleExtras), domains: ['zeta.test'] }), /symbolic link/)
    await assert.rejects(store.deleteTenant('zeta'), /symbolic link|not a real directory/)
    assert.ok(await exists(outsideTenant), 'the link target was not deleted')
    assert.ok(await exists(path.join(outsideTenant, 'categories.json')))
    assert.ok(!(await exists(path.join(outsideTenant, 'site.json'))), 'nothing was written through the link')
    assert.ok(!(await store.listTenants()).includes('zeta'))

    // A symlinked sub-directory inside a tenant is refused as well.
    await symlink(outsideTenant, path.join(rootDir, 'alpha', 'posts', 'linked'))
    const blog = await makeStore(BlogLayout)
    try {
      await seedTenantContent(blog.store, 'alpha', fixture.tenants.alpha)
      await symlink(outsideTenant, path.join(blog.rootDir, 'alpha', 'posts', 'linked'))
      await assert.rejects(blog.store.forTenant('alpha').listPosts({ visibility: 'all' }), /symbolic link/)
    }
    finally {
      await blog.dispose()
    }
  })
})

describe('filesystem: atomic writes and per-tenant serialization', () => {
  it('writeFileAtomic replaces content fully and leaves no temp files', async () => {
    const dir = await makeTempDir('hyla-atomic-')
    const target = path.join(dir, 'nested', 'file.txt')
    await writeFileAtomic(target, 'first version, quite long so a partial write would be visible\n')
    await writeFileAtomic(target, 'second\n')
    assert.equal(await readFile(target, 'utf8'), 'second\n')
    assert.deepEqual(await readdir(path.join(dir, 'nested')), ['file.txt'])
    assert.deepEqual(await readdir(dir), ['nested'])

    // Many concurrent writers: the file always ends up with exactly one complete payload.
    await Promise.all(Array.from({ length: 30 }, (_, index) => writeFileAtomic(target, `payload-${index}\n`.repeat(200))))
    const content = await readFile(target, 'utf8')
    const lines = content.split('\n').filter(Boolean)
    assert.equal(lines.length, 200)
    assert.equal(new Set(lines).size, 1, 'no interleaving of payloads')
    assert.deepEqual(await readdir(path.join(dir, 'nested')), ['file.txt'])
  })

  it('KeyedMutex serializes same-key work and lets different keys run concurrently', async () => {
    const mutex = new KeyedMutex()
    const log = []
    let inside = 0
    const work = (key, label, ms) => mutex.withLock(key, async () => {
      inside += 1
      assert.ok(inside <= 2, 'at most one holder per key (two keys in flight)')
      log.push(`${label}:start`)
      await new Promise(resolve => setTimeout(resolve, ms))
      log.push(`${label}:end`)
      inside -= 1
    })
    await Promise.all([work('a', 'a1', 20), work('a', 'a2', 1), work('b', 'b1', 5)])
    assert.deepEqual(log.filter(item => item.startsWith('a')), ['a1:start', 'a1:end', 'a2:start', 'a2:end'])
    assert.ok(log.indexOf('b1:end') < log.indexOf('a1:end'), 'b did not wait for a')
    await assert.rejects(mutex.withLock('a', async () => { throw new Error('boom') }), /boom/)
    assert.equal(await mutex.withLock('a', async () => 'still usable after a failure'), 'still usable after a failure')
  })

  it('concurrent savePost calls for one tenant serialize without lost updates', async () => {
    const handle = await makeStore(BlogLayout)
    try {
      const repo = handle.store.forTenant('load')
      const base = { locale: 'en', title: 'Load', body: 'body\n', status: 'published', categories: ['load'], tags: ['t'] }
      const saved = await Promise.all(Array.from({ length: 20 }, (_, index) => repo.savePost({ ...base, id: `load-${index}`, slug: `load-${index}` })))
      assert.deepEqual(saved.map(post => post.revision), Array(20).fill(1))
      const all = await repo.listPosts({ visibility: 'all' })
      assert.deepEqual(all.map(post => post.id).sort(), Array.from({ length: 20 }, (_, index) => `load-${index}`).sort())

      // Twenty concurrent updates of ONE post: every save observes the previous one.
      const updates = await Promise.all(Array.from({ length: 20 }, (_, index) => repo.savePost({ ...base, id: 'load-0', slug: 'load-0', body: `update ${index}\n` })))
      assert.deepEqual(updates.map(post => post.revision).sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 2))
      assert.equal((await repo.getPostById('load-0'))?.revision, 21)

      // Read-modify-write JSON files are the classic lost-update case.
      await Promise.all(Array.from({ length: 20 }, (_, index) => repo.saveCategory({ slug: `cat-${index}`, name: `Category ${index}` })))
      assert.equal((await repo.listCategories()).length, 20)
      await Promise.all(Array.from({ length: 20 }, (_, index) => repo.saveTag({ slug: `tag-${index}`, name: `Tag ${index}` })))
      assert.equal((await repo.listTags()).length, 20)
      const files = await readdir(path.join(handle.rootDir, 'load', 'posts', 'load'))
      assert.equal(files.filter(name => name.endsWith('.tmp')).length, 0, 'no temp files left behind')
      assert.equal(files.length, 20)
    }
    finally {
      await handle.dispose()
    }
  })

  it('a content-version marker left by a crashed mutation bumps the version once on the next read, so caches drop what that mutation may have written (B3)', async () => {
    const handle = await makeStore(DefaultLayout)
    try {
      const repo = handle.store.forTenant('crashy')
      await repo.savePost({ id: 'c-1', slug: 'c-1', locale: 'en', title: 'c', body: 'b\n', status: 'published', categories: [], tags: [] })
      const version = Number(await repo.contentVersion())
      const marker = path.join(handle.rootDir, 'crashy', 'content.version.pending')
      assert.equal(await exists(marker), false, 'a completed mutation leaves no marker')
      await writeFile(marker, `${new Date().toISOString()}\n`)
      assert.equal(Number(await repo.contentVersion()), version + 1, 'the leftover marker bumps the version once')
      assert.equal(await exists(marker), false, 'and is cleared')
      assert.equal(Number(await repo.contentVersion()), version + 1, 'only once')
      await repo.saveCategory({ slug: 'x', name: 'X' })
      assert.equal(Number(await repo.contentVersion()), version + 2)
      assert.equal(await exists(marker), false)
      // Inside transaction() the marker belongs to the running work: reads there never settle it.
      await handle.store.transaction('crashy', async tx => {
        await writeFile(marker, 'mine\n')
        assert.equal(Number(await tx.contentVersion()), version + 2)
        assert.equal(await exists(marker), true)
        await rm(marker)
      })
      assert.equal(Number(await repo.contentVersion()), version + 2)
    }
    finally {
      await handle.dispose()
    }
  })

  it('transaction() serializes with other mutations of the same tenant', async () => {
    const handle = await makeStore(DefaultLayout)
    try {
      const { store } = handle
      const order = []
      const slow = store.transaction('tx', async repo => {
        await repo.savePost({ id: 'tx-1', slug: 'tx-1', locale: 'en', title: 't', body: '', status: 'draft', categories: [], tags: [] })
        await new Promise(resolve => setTimeout(resolve, 30))
        order.push('transaction-done')
        return (await repo.listPosts({ visibility: 'all' })).length
      })
      const outside = store.forTenant('tx').savePost({ id: 'tx-2', slug: 'tx-2', locale: 'en', title: 't', body: '', status: 'draft', categories: [], tags: [] })
        .then(() => order.push('outside-done'))
      assert.equal(await slow, 1, 'the outside write waited for the transaction')
      await outside
      assert.deepEqual(order, ['transaction-done', 'outside-done'])
      assert.equal((await store.forTenant('tx').listPosts({ visibility: 'all' })).length, 2)
    }
    finally {
      await handle.dispose()
    }
  })
})

describe('filesystem: audit-3 regressions', () => {
  const draft = (id, extra = {}) => ({ id, slug: id, locale: 'en', title: id, body: `${id}\n`, status: 'published', categories: [], tags: [], ...extra })

  it('two files carrying one id (a crash inside a rename) are one post: the copy at the layout path wins, reads ignore the other, the next save or delete removes it (F-BD3-09)', async () => {
    const handle = await makeStore(DefaultLayout)
    try {
      const repository = handle.store.forTenant('crash')
      await repository.savePost(draft('dup', { slug: 'z-old', body: 'old body\n' }))
      const before = Number(await repository.contentVersion())
      // The crash window of a rename z-old → a-new: marker set, new file written, old file not yet removed.
      const renamed = { ...(await repository.getPostById('dup')), slug: 'a-new', body: 'new body\n', revision: 2 }
      await writeFile(path.join(handle.rootDir, 'crash', 'posts', 'a-new.md'), serializePost(renamed))
      await writeFile(path.join(handle.rootDir, 'crash', 'content.version.pending'), `${new Date().toISOString()}\n`)
      assert.equal(Number(await repository.contentVersion()), before + 1, 'the leftover marker bumps the version once')
      const listed = await repository.listPosts({ visibility: 'public' })
      assert.deepEqual(listed.map(post => `${post.id}@${post.slug}`), ['dup@a-new'], 'one post; the copy at the layout path wins')
      assert.equal(await repository.getPost('z-old', { visibility: 'public' }), undefined, 'the stale copy is not readable')
      assert.equal((await repository.getPost('a-new', { visibility: 'public' })).body, 'new body\n')
      // A new post may take the stale copy's slug.
      await repository.savePost(draft('other', { slug: 'z-old', body: 'other\n' }))
      assert.equal((await repository.getPost('z-old', { visibility: 'public' })).id, 'other')
      await repository.deletePost('other')
      // Re-saving the post removes the stale copy.
      const saved = await repository.savePost(draft('dup', { slug: 'a-new', body: 'new body 2\n' }))
      assert.equal(saved.revision, 3)
      assert.deepEqual((await readdir(path.join(handle.rootDir, 'crash', 'posts'))).sort(), ['a-new.md'])
      // A second stale copy, then deletePost removes every file of the id.
      await writeFile(path.join(handle.rootDir, 'crash', 'posts', 'b-stale.md'), serializePost({ ...saved, slug: 'b-stale', revision: 1 }))
      assert.equal((await repository.listPosts({ visibility: 'all' })).length, 1)
      assert.equal(await repository.deletePost('dup'), true)
      assert.equal(await repository.getPostById('dup'), undefined)
      assert.deepEqual(await readdir(path.join(handle.rootDir, 'crash', 'posts')), [])
    }
    finally {
      await handle.dispose()
    }
  })

  it('when no copy sits at the layout path the highest revision wins, then the first path (F-BD3-09)', async () => {
    const handle = await makeStore(BlogLayout)
    try {
      const repository = handle.store.forTenant('crash2')
      const base = await repository.savePost(draft('dup', { slug: 'first', categories: ['news'], body: 'r1\n' }))
      await rm(path.join(handle.rootDir, 'crash2', 'posts', 'news', 'first.md'))
      await mkdir(path.join(handle.rootDir, 'crash2', 'posts', 'misc'), { recursive: true })
      const copy = (slug, revision, body) => serializePost({ ...base, slug, primaryCategory: 'misc', categories: ['misc'], revision, body })
      await writeFile(path.join(handle.rootDir, 'crash2', 'posts', 'misc', 'b.md'), copy('b', 3, 'r3\n'))
      await writeFile(path.join(handle.rootDir, 'crash2', 'posts', 'misc', 'a.md'), copy('a', 3, 'r3a\n'))
      await writeFile(path.join(handle.rootDir, 'crash2', 'posts', 'misc', 'c.md'), copy('c', 2, 'r2\n'))
      const post = await repository.getPostById('dup')
      assert.deepEqual([post.slug, post.revision], ['a', 3], 'highest revision, first path')
      assert.equal((await repository.listPosts({ visibility: 'all' })).length, 1)
    }
    finally {
      await handle.dispose()
    }
  })
})
