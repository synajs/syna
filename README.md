# Syna

[![CI](https://github.com/synajs/syna/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/synajs/syna/actions/workflows/ci.yml)

A runtime for composing stateful TypeScript services with explicit lifetimes.

English | [简体中文](https://github.com/synajs/syna/blob/main/README.zh-CN.md)

Most programs own things that must be created before they are used and released afterwards: a database pool, an API
client carrying one tenant's credential, a cache that belongs to a single request. Creating them by hand works until the
same thing is needed in two places at once, or until one of them has to differ per tenant, per request or per customer's
configuration. The wiring then starts to answer questions it was never written for — who creates this, who may share it,
when is it safe to close — and the answers end up spread over factory functions, module-level singletons and `finally`
blocks.

Syna moves those questions into the declarations. A Service says what it needs, how it starts and how it is released. A
call opens a world for a context you have — the program, a tenant, one request. Inside a world a Service exists at most
once, and only if something asks for it; a child world reuses what its parent already has and creates its own copy of
whatever depends on a fact the child changed. When a world ends, everything it created is released in dependency order,
whether the code left normally or through an exception.

## Install

```sh
npm install syna@rc
```

- Node.js ≥ 22.
- TypeScript is recommended. Dependencies are typed descriptors, so a missing or mistyped one is a compile error; the
  package ships its own declarations and needs nothing else at runtime.

## Quick start

Three files. The program opens a connection pool when the first query needs it, and closes it when the world ends.

`package.json`

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "type": "module",
  "imports": { "#syna/package": "./package.json" }
}
```

`tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "resolveJsonModule": true,
    "strict": true,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

`src/main.ts`

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage } from 'syna'

const define = definePackage(packageJson)

const DatabaseConfig = define.input<{ url: string; poolSize: number }>('database-config')

interface Database {
  query(sql: string): Promise<string>
}

const Database = define.service('database', {
  requires: { config: DatabaseConfig },
  async setup({ config }, { onDispose }): Promise<Database> {
    const { url, poolSize } = config.read()
    const pool = await openPool(url, poolSize)
    onDispose(() => pool.close())
    return { query: sql => pool.run(sql) }
  },
})

const App = define.entry('app', {
  requires: { database: Database },
  parameters: { config: DatabaseConfig },
})

const runtime = createRuntime({ services: [Database] })

await runtime.run(App, { config: { url: 'postgres://localhost/app', poolSize: 4 } }, async ({ database }) => {
  const db = await database.load()
  console.log(await db.query('select 1'))
})

await runtime.dispose()

// Stands in for a real driver: what matters is where it is opened and who closes it.
async function openPool(url: string, poolSize: number) {
  console.log(`opened ${url} (${poolSize} connections)`)
  return {
    run: async (sql: string) => `${sql} -> 1 row`,
    close: async () => console.log(`closed ${url}`),
  }
}
```

Install TypeScript (`npm install -D typescript @types/node`), then `npx tsc && node dist/main.js` prints:

```
opened postgres://localhost/app (4 connections)
select 1 -> 1 row
closed postgres://localhost/app
```

Reading it from the bottom up: `runtime.run()` opened a world, handed the callback the dependencies the Entry declares,
and closed the world when the callback returned — which is when the pool was closed, by the cleanup its own `setup()`
registered. `database.load()` is what created the pool; had the callback never called it, no pool would have been
opened. The `{ url, poolSize }` record is a fact of that world: the Service read it synchronously, and a world entered
with a different record gets a different pool.

Nothing above registers a shutdown hook, closes a pool from a `finally` block, or passes a `db` argument through the
call stack.

## Runtime, Entry, Env, Service, Input

**Runtime.** A Runtime knows which Service definitions the program may use. Creating it starts nothing: it admits
definitions, and everything else is a consequence of entering a world.

**Entry.** An Entry describes what a world offers to the code that enters it (`requires`) and what the caller has to
supply to open one (`parameters`). It is the door of a world, and it is typed: `env.deps` has exactly the shape the
Entry declares.

**Env.** An Env is one execution world — one program, one tenant, one request. A child world reuses the Services its
parent already has as long as they still fit; when an Input or an implementation choice changes, the parts that depend
on the change are created again in the child and the rest stays shared. Closing an Env releases what that world created.

**Service.** A managed component with an identity, dependencies and a lifecycle. `setup()` acquires the resource and
returns the instance; the cleanups it registers with `onDispose()` release it when the world that owns the slot ends. A
Service never closes a dependency it did not create.

**Input.** An external fact of a world, provided by the caller and read synchronously — a tenant record, a request, a
configuration. An Input has no lifecycle of its own; what it changes is which Services a world has to create.

**Contract and Binding** come later, when an implementation is chosen rather than fixed.

The formal model is [docs/SEMANTIC_MODEL.md][semantic-model], the vocabulary [docs/GLOSSARY.md][glossary], and the
complete surface [docs/API_REFERENCE.md][api-reference].

## A world for each tenant

The Quick Start had one world. The useful shape is a tree of them: shared infrastructure above, one world per tenant
below.

```
app world                      pool #1
├── tenant world "acme"        mail client of acme    ─┐ same pool,
└── tenant world "globex"      mail client of globex  ─┘ separate clients
```

`src/tenants.ts`

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage } from 'syna'

const define = definePackage(packageJson)

const CurrentTenant = define.input<{ id: string; apiKey: string }>('current-tenant')

interface Pool {
  readonly id: number
  run(sql: string): Promise<string>
}

let pools = 0

const Pool = define.service('pool', {
  async setup(_deps, { onDispose }): Promise<Pool> {
    const id = ++pools
    console.log(`pool #${id} opened`)
    onDispose(() => console.log(`pool #${id} closed`))
    return { id, run: async sql => `${sql}: ok` }
  },
})

interface MailClient {
  send(to: string): Promise<string>
}

const MailClient = define.service('mail-client', {
  requires: { tenant: CurrentTenant, pool: Pool },
  async setup({ tenant, pool }, { onDispose }): Promise<MailClient> {
    const { id, apiKey } = tenant.read()
    const db = await pool.load()
    console.log(`mail client of ${id} opened on pool #${db.id}`)
    onDispose(() => console.log(`mail client of ${id} closed`))
    return {
      send: async to => `${id}: mail to ${to} accepted with ${apiKey} (${await db.run('insert into outbox')})`,
    }
  },
})

const App = define.entry('app', { requires: { pool: Pool } })

const TenantEntry = define.entry('tenant', {
  requires: { mail: MailClient },
  parameters: { tenant: CurrentTenant },
  reuse: { share: [Pool] },
})

const runtime = createRuntime({ services: [Pool, MailClient] })
const app = await runtime.enter(App)

for (const tenant of [{ id: 'acme', apiKey: 'key-acme' }, { id: 'globex', apiKey: 'key-globex' }]) {
  await app.run(TenantEntry, { tenant }, async ({ mail }) => {
    console.log(await (await mail.load()).send('owner@example.test'))
  })
}

await app.dispose()
await runtime.dispose()
```

`node dist/tenants.js` prints:

```
pool #1 opened
mail client of acme opened on pool #1
acme: mail to owner@example.test accepted with key-acme (insert into outbox: ok)
mail client of acme closed
mail client of globex opened on pool #1
globex: mail to owner@example.test accepted with key-globex (insert into outbox: ok)
mail client of globex closed
pool #1 closed
```

`MailClient` never mentions a tenant world. It requires `CurrentTenant`, and that is enough: each tenant world provides
its own tenant, so each gets a client of its own. `Pool` requires nothing contextual, so both tenant worlds use the one
the app world holds — and it stays open after the first tenant world has closed. `reuse: { share: [Pool] }` states that
as a requirement rather than a hope: a caller that asked for a fresh pool under this Entry would be refused, not quietly
given a second one.

The same shape covers work that ends: a request, a build, a scheduled job. Enter a world when the work starts, let the
Services that belong to it be created there, and close it when the work is done — `env.derive()` opens a child world
without an Entry of its own when all you need is a boundary.

## Choosing an implementation

When a Service is one of several possible implementations, declare a Contract for the shape and let the Services provide
it. A Binding carries the choice, as a value a caller can store:

```ts
export interface Mailer {
  send(to: string, text: string): Promise<string>
}

export const Mailer = define.contract<Mailer>('mailer')
export const Preferred = define.binding('preferred-mailer', Mailer)

const SmtpMailer = define.service('smtp-mailer', { provides: [Mailer], setup: () => ({ send: async () => 'sent' }) })
const ApiMailer = define.service('api-mailer', { provides: [Mailer], setup: () => ({ send: async () => 'sent' }) })

const TenantEntry = define.entry('tenant', {
  requires: { mail: Preferred },
  parameters: { tenant: CurrentTenant, mail: Preferred },
})

// what a tenant's settings row can hold: { "kind": "implementation-ref", "contractId": …, "familyId": …, "range": … }
const stored = JSON.stringify(Preferred.to(ApiMailer))

await runtime.run(TenantEntry, { tenant, mail: Preferred.parse(JSON.parse(stored)) }, async ({ mail }) => {
  await (await mail.load()).send('owner@example.test', 'hello')
})
```

`Preferred.to(service)` writes a JSON-safe reference and `Preferred.parse(value)` reads one back, refusing anything that
is not a reference to that Contract. The choice is a parameter of the world, so two tenants with different choices are
two worlds, each with its own client — and the Services that depend on the mailer are created separately in each, while
everything above the choice stays shared.

Revisions of one Service family work the same way: a reference asks for a semver range, so a tenant that chose a
provider under `1.x` keeps a 1.x client while new tenants get the 2.x one, in the same program.

## Testing

An override replaces a Service's implementation at Runtime construction, without touching the code under test. The
overridden Service keeps its identity, its Contracts and its place in every plan:

```ts
import { createRuntime, override } from 'syna'

const RecordingMailer = define.service('recording-mailer', {
  provides: [Mailer],
  setup: () => ({ send: async (to: string) => `recorded ${to}` }),
})

const runtime = createRuntime({
  services: [Pool, MailClient],
  overrides: [override(SmtpMailer, RecordingMailer)],
})
```

Nothing else changes: the same Entries, the same worlds, the same cleanups.

## Diagnostics

Two questions can be answered before anything is created, and one about a world that already exists:

```ts
const check = await runtime.check(TenantEntry, { tenant })          // would this world plan?
if (!check.ok) console.log(check.error.code)                        // and if not, which code says why

const plan = await runtime.explain(TenantEntry, { tenant })         // what it would create, reuse or fork, and why
if (plan.ok) console.log(plan.services, plan.forks.map(fork => `${fork.placement} ${fork.label}`))

const env = await runtime.enter(App)
console.log(env.inspect().nodes)                                    // what a world actually has, slot by slot
```

`check()` and `explain()` only plan — no Service is created and no world is opened. `explain()` names every node it
would create, reuse or fork and the cause of each fork, which is the first thing to read when a world creates more than
you expected. Failures are `SynaError`s with a `code` and structured `details`; `isSynaError(error, 'MISSING_INPUT')`
narrows one. The shapes are in [docs/API_REFERENCE.md][api-reference].

## What Syna does not do

- It does not sandbox untrusted code. A Service's `setup()` is ordinary JavaScript with the privileges of the process.
- It does not install or uninstall packages while the program runs. A Runtime's admission set is fixed when it is
  created.
- It is not a distributed or process-global singleton registry. Identity and reuse are per Runtime, inside one process.
- It does not turn arbitrary configuration equality into reuse. What forks a world is a declared Input, a Binding, or a
  structural difference — not the deep equality of two option objects.
- It cannot terminate JavaScript that ignores its `AbortSignal`. A close waits for a bounded time and then reports what
  outlived it; what is bounded is the waiting, not the release of the resource.
- It offers no domain-specific transaction guarantees. Ordering cleanups is not the same as committing or rolling back
  your database work.

[docs/SEMANTIC_MODEL.md][semantic-model] states the guarantees precisely, and [docs/DEFERRED.md][deferred] what was
looked at and deliberately left alone.

## Documentation

Start here

- [Examples][examples] — seven progressive programs, one question each, all of them run by the release gate
- [API reference][api-reference] — the complete public surface, with the details of every error code
- [Semantic model][semantic-model] — worlds, slots, reuse, materialization and closing, stated precisely
- [Glossary][glossary] — the vocabulary, English and Chinese

Building packages

- [Package authoring][package-authoring] — how a package declares its Services, Contracts, Inputs and Bindings
- [Plugin authoring][plugin-authoring] — the plugin protocol of the reference application

Compatibility

- [API stability][api-stability] — the frozen public surface and the naming rules
- [History][history] — the releases, their task books and their migration notes

Internals

- [Architecture][architecture] — module boundaries as implemented
- [Validation][validation] — the recorded release run
- [Audit][audit] — independent audit findings
- [Working in this repository][contributing] — building, testing and releasing Syna itself

## Status

`syna@1.0.0-rc.1` is a release candidate: the public API has been frozen since 0.8.0 and no name or semantic of it
changes before 1.0. Releases are validated from a rebuilt source archive, including packed-package consumer tests;
[docs/VALIDATION.md][validation] records the run.

MIT licensed. Source, issues and discussion: [github.com/synajs/syna](https://github.com/synajs/syna).

[api-reference]: https://github.com/synajs/syna/blob/main/docs/API_REFERENCE.md
[api-stability]: https://github.com/synajs/syna/blob/main/docs/API_STABILITY.md
[architecture]: https://github.com/synajs/syna/blob/main/docs/ARCHITECTURE.md
[audit]: https://github.com/synajs/syna/blob/main/docs/AUDIT.md
[contributing]: https://github.com/synajs/syna/blob/main/CONTRIBUTING.md
[deferred]: https://github.com/synajs/syna/blob/main/docs/DEFERRED.md
[examples]: https://github.com/synajs/syna/blob/main/docs/EXAMPLES.md
[glossary]: https://github.com/synajs/syna/blob/main/docs/GLOSSARY.md
[history]: https://github.com/synajs/syna/blob/main/docs/HISTORY.md
[package-authoring]: https://github.com/synajs/syna/blob/main/docs/PACKAGE_AUTHORING.md
[plugin-authoring]: https://github.com/synajs/syna/blob/main/docs/PLUGIN_AUTHORING.md
[semantic-model]: https://github.com/synajs/syna/blob/main/docs/SEMANTIC_MODEL.md
[validation]: https://github.com/synajs/syna/blob/main/docs/VALIDATION.md
