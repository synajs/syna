# Syna

Dependency and lifetime management for stateful TypeScript services.

[![CI](https://github.com/synajs/syna/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/synajs/syna/actions/workflows/ci.yml)

English | [简体中文](https://github.com/synajs/syna/blob/main/README.zh-CN.md)

A connection pool lives until the application shuts down. An API client carries one tenant's credentials. A request cache should disappear with its request. These are easy enough to manage by hand at first. As more code shares the same resources, deciding who creates them and when they can close starts to spread across factories, module-level singletons and `finally` blocks.

Syna makes those relationships part of the service declarations. A Service declares its dependencies, creates an instance in `setup()` and registers its cleanup. An Entry opens an environment (Env) for a context such as a tenant or a request. Child environments reuse parent services whose dependencies still match and create instances where different dependencies are needed. Closing an environment runs the cleanups of the services it owns in dependency order.

## Install

The first public RC is being prepared. Once it is published under the npm `rc` tag:

```sh
npm install syna@rc
```

Requires Node.js ≥ 22 and ESM. TypeScript is recommended. Syna ships its own type declarations; no other Syna package or custom tsconfig preset is required. Your package manager installs the runtime dependencies automatically.

## Quick start

Three files. This program opens a pool when `Database` is first loaded and closes it when the call finishes. `openPool()` is a stand-in for a driver; it does not connect to a database.

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
try {
  await runtime.run(App, {
    config: { url: 'postgres://localhost/app', poolSize: 4 },
  }, async ({ database }) => {
    const db = await database.load()
    console.log(await db.query('select 1'))
  })
} finally {
  await runtime.dispose()
}

// A stand-in for a database driver; no database connection is made.
async function openPool(url: string, poolSize: number) {
  console.log(`opened ${url} (${poolSize} connections)`)
  return {
    run: async (sql: string) => `${sql} -> 1 row`,
    close: async () => console.log(`closed ${url}`),
  }
}
```

After creating the files, install the dependencies in the project directory:

```sh
npm install syna@rc
npm install -D typescript @types/node
```

Running `npx tsc && node dist/main.js` prints:

```
opened postgres://localhost/app (4 connections)
select 1 -> 1 row
closed postgres://localhost/app
```

`runtime.run()` creates an environment, passes the Entry's declared dependencies to the callback and closes the environment when the callback completes or throws. The pool's cleanup is registered once in `Database.setup()`. Code that uses the pool does not need to know which driver method closes it. The outer `finally` closes the Runtime.

`database.load()` starts the pool. This Service is not eager, so without that call no pool would be opened. `config.read()` reads the supplied configuration synchronously.

`definePackage(packageJson)` uses your application's own package name and version to identify its definitions. `#syna/package` is the local import alias configured above, not another package to install.

## The basic model

**Runtime** holds the service definitions the program may use. Constructing one starts no services. Environments are planned and created when an Entry is called.

**Entry** declares the parameters needed to open an environment and the capabilities available inside it. `parameters` lists Input values and Binding assignments; `requires` determines the dependency references passed to the callback and exposed on `env.deps`.

**Env** is an execution environment. Your application can create them for tenants, requests or builds; Syna has no built-in names for those lifetimes. A child reuses compatible parent services whether or not the parent has loaded them yet.

**Service** is a managed component with an identity, dependencies and a lifecycle. Within one environment, references to the same service revision resolve to the same instance; different revisions can coexist. Services start on the first `load()` by default. A Service declared with `eager: true` must start before its environment becomes ready. Use `onDispose()` for resources your setup created, not for closing shared dependencies.

**Input** is context supplied by the caller, such as a tenant record, request or configuration. Read it synchronously with `read()`. Explicitly supplying an Input in a child gives it a new context identity, even when the value is the same object. Services that depend on it fork accordingly; Syna does not compare configuration objects for deep equality.

The [semantic model][semantic-model] gives the precise rules. The [API reference][api-reference] covers the complete types and methods.

## A world for each tenant

Keep shared infrastructure in an application environment and tenant-specific services in its children:

```
app Env                        Pool
├── tenant Env: acme            MailClient(acme)   ─┐
└── tenant Env: globex          MailClient(globex) ─┴─ shared Pool
```

Use the same `package.json` and `tsconfig.json` and add this file. The pool and mail clients are still stand-ins, with no database or real credentials required.

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
  setup(_deps, { onDispose }): Pool {
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
    const { id } = tenant.read()
    const db = await pool.load()
    console.log(`mail client of ${id} opened on pool #${db.id}`)
    onDispose(() => console.log(`mail client of ${id} closed`))
    return {
      send: async to => `${id}: mail to ${to} accepted (${await db.run('insert into outbox')})`,
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
try {
  const app = await runtime.enter(App)
  for (const tenant of [{ id: 'acme', apiKey: 'key-acme' }, { id: 'globex', apiKey: 'key-globex' }]) {
    await app.run(TenantEntry, { tenant }, async ({ mail }) => {
      const client = await mail.load()
      console.log(await client.send('owner@example.test'))
    })
  }
} finally {
  await runtime.dispose()
}
```

Running `npx tsc && node dist/tenants.js` prints:

```
pool #1 opened
mail client of acme opened on pool #1
acme: mail to owner@example.test accepted (insert into outbox: ok)
mail client of acme closed
mail client of globex opened on pool #1
globex: mail to owner@example.test accepted (insert into outbox: ok)
mail client of globex closed
pool #1 closed
```

`MailClient` declares no scope named “tenant.” It depends on `CurrentTenant`, and each call to `TenantEntry` supplies its own tenant value, so each child gets its own client. `Pool` is already planned in the application environment and has no tenant dependency. Both children share it, and it closes when the Runtime closes the application environment.

`reuse: { share: [Pool] }` makes sharing a requirement: entering fails rather than silently creating another pool when the parent's cannot be reused. Without the constraint, Syna still tries to reuse compatible parent services by default.

Requests, builds and scheduled jobs can use the same structure. `env.derive()` creates a child when all you need is a boundary, without declaring additional dependencies on its public surface.

Not every configuration needs an environment of its own. A Markdown pipeline factory can create one processor for posts and another for comments through two ordinary method calls. Separate environments are useful when the managed dependency identities or lifetimes need to differ.

## Choosing an implementation

A Contract describes a capability. Services declare that they provide it, and a Binding names a place where an implementation can be chosen. The choice can be stored in user settings and read back for a later call.

The following three blocks form one example: put them in order in `src/mailers.ts`, using the Quick Start's project configuration. The two providers return demonstration results; they do not send email.

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage } from 'syna'

const define = definePackage(packageJson)
interface Mailer {
  send(to: string, text: string): Promise<string>
}

const Mailer = define.contract<Mailer>('mailer')
const Preferred = define.binding('preferred-mailer', Mailer)
const CurrentTenant = define.input<{ id: string }>('mail-tenant')

const SmtpMailer = define.service('smtp-mailer', {
  provides: [Mailer],
  requires: { tenant: CurrentTenant },
  setup: ({ tenant }): Mailer => ({
    send: async (to, text) => `${tenant.read().id}: SMTP -> ${to}: ${text}`,
  }),
})
const ApiMailer = define.service('api-mailer', {
  provides: [Mailer],
  requires: { tenant: CurrentTenant },
  setup: ({ tenant }): Mailer => ({
    send: async (to, text) => `${tenant.read().id}: API -> ${to}: ${text}`,
  }),
})

const MailEntry = define.entry('send-mail', {
  requires: { mail: Preferred },
  parameters: { tenant: CurrentTenant, mail: Preferred },
})

const services = [SmtpMailer, ApiMailer]
const stored = JSON.stringify(Preferred.to(ApiMailer))
const parameters = {
  tenant: { id: 'acme' },
  mail: Preferred.parse(JSON.parse(stored)),
}

const runtime = createRuntime({ services })
try {
  const result = await runtime.run(MailEntry, parameters, async ({ mail }) =>
    (await mail.load()).send('owner@example.test', 'hello'))
  console.log(result)
} finally {
  await runtime.dispose()
}
```

This call returns `acme: API -> owner@example.test: hello`. Both implementations are explicitly passed to `createRuntime()`. Importing a Service alone does not make it a publicly selectable implementation.

`Preferred.to(ApiMailer)` produces a JSON-safe implementation reference. `Preferred.parse()` validates its format and Contract identity. Entry planning then resolves a revision from the Runtime's admitted implementations. Reading a reference neither downloads a package nor grants permission to use it.

A reference stores a service identity and version range, not a live client. When both revisions are admitted, existing 1.x choices can continue to use 1.x while new choices explicitly select 2.x. See [package authoring][package-authoring] for versioning and configuration migration.

## Testing

Continuing the example, replace `SmtpMailer` in a test Runtime. The `services` list still contains the original service; the replacement does not need separate public admission:

```ts
import { override } from 'syna'

const recorded: string[] = []
const RecordingMailer = define.service('recording-mailer', {
  provides: [Mailer],
  setup: (): Mailer => ({
    send: async (to, text) => {
      recorded.push(`${to}: ${text}`)
      return 'recorded'
    },
  }),
})

const testRuntime = createRuntime({
  services,
  overrides: [override(SmtpMailer, RecordingMailer)],
})
try {
  await testRuntime.run(MailEntry, {
    tenant: parameters.tenant,
    mail: Preferred.to(SmtpMailer),
  }, async ({ mail }) => {
    await (await mail.load()).send('owner@example.test', 'hello')
  })
  console.log(recorded)
} finally {
  await testRuntime.dispose()
}
```

`recorded` now contains `['owner@example.test: hello']`. The call still selects `SmtpMailer`, but the replacement handles it. The original keeps its identity and Contract membership; the executable dependencies, setup and registered cleanups come from the replacement.

## Planning and inspection

Finally, inspect the same Entry using another Runtime. `parameters` supplies both of its declared parameters: `tenant` and `mail`.

```ts
const diagnosticRuntime = createRuntime({ services })
try {
  const check = await diagnosticRuntime.check(MailEntry, parameters)
  if (!check.ok) console.log(check.error.code)

  const plan = await diagnosticRuntime.explain(MailEntry, parameters)
  if (plan.ok) console.log(plan.services, plan.forks.map(fork => fork.label))

  const env = await diagnosticRuntime.enter(MailEntry, parameters)
  console.log(env.inspect().nodes)
} finally {
  await diagnosticRuntime.dispose()
}
```

`check()` tells you whether a call can be planned. `explain()` shows which nodes would be created, reused or forked, and why. Neither runs setup nor creates an Env. TypeScript catches incorrect parameter types and dependency usage; composition errors such as missing implementations or unsatisfied version ranges still require planning checks.

`env.inspect()` describes an environment that already exists, including each slot's state. Entering an environment does not mean every lazy service has started; this example never calls `mail.load()`. Runtime errors carry codes and structured details. `isSynaError(error, 'MISSING_INPUT')` tests and narrows an error. The [API reference][api-reference] documents these result shapes.

## What Syna does not do

- **Sandboxing or hot installation.** Services are ordinary JavaScript running with the process's privileges. A Runtime's public service set is fixed at construction; Syna does not install or uninstall packages while it runs.
- **Process-global or distributed singletons.** Instance identity and reuse belong to one Runtime's environment trees. They do not coordinate separate processes.
- **Forced termination.** Closing waits within the configured grace periods and reports setup or cleanup work still running. It cannot kill JavaScript that ignores its `AbortSignal`. The waiting is bounded, not the release of the resource.
- **Database transactions.** Running cleanup functions is not a substitute for the commit and rollback protocol implemented by your data layer.

The [semantic model][semantic-model] and [deferred features][deferred] cover the remaining boundaries.

## Documentation

**Start here:** [Examples][examples] · [API reference][api-reference] · [Semantic model][semantic-model] · [Glossary][glossary]

**Building modules:** [Package authoring][package-authoring] · [Reference application plugin protocol][plugin-authoring]

**Compatibility:** [API stability][api-stability] · [History and migrations][history]

**Contributing:** [Contributor guide][contributing] · [Architecture][architecture] · [Validation][validation] · [Audit][audit]

## Status and license

This repository is preparing the first public release, `syna@1.0.0-rc.1`. The public API is frozen; earlier development names and candidate versions are recorded in the [history][history]. Release validation includes rebuilding a source archive and testing an independently installed package. See the [validation record][validation] for the results.

MIT licensed. Source and issues: [synajs/syna](https://github.com/synajs/syna).

[examples]: https://github.com/synajs/syna/blob/main/docs/EXAMPLES.md
[api-reference]: https://github.com/synajs/syna/blob/main/docs/API_REFERENCE.md
[semantic-model]: https://github.com/synajs/syna/blob/main/docs/SEMANTIC_MODEL.md
[glossary]: https://github.com/synajs/syna/blob/main/docs/GLOSSARY.md
[package-authoring]: https://github.com/synajs/syna/blob/main/docs/PACKAGE_AUTHORING.md
[plugin-authoring]: https://github.com/synajs/syna/blob/main/docs/PLUGIN_AUTHORING.md
[api-stability]: https://github.com/synajs/syna/blob/main/docs/API_STABILITY.md
[history]: https://github.com/synajs/syna/blob/main/docs/HISTORY.md
[architecture]: https://github.com/synajs/syna/blob/main/docs/ARCHITECTURE.md
[validation]: https://github.com/synajs/syna/blob/main/docs/VALIDATION.md
[audit]: https://github.com/synajs/syna/blob/main/docs/AUDIT.md
[contributing]: https://github.com/synajs/syna/blob/main/CONTRIBUTING.md
[deferred]: https://github.com/synajs/syna/blob/main/docs/DEFERRED.md
