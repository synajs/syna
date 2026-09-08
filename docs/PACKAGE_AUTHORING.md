# Package authoring

## Package metadata

```json
{
  "name": "@example/storage-s3",
  "version": "0.4.2",
  "type": "module",
  "imports": {
    "#syna/package": "./package.json"
  },
  "syna": {
    "id": "example.storage.s3"
  }
}
```

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { definePackage } from '@syna/core'

export const define = definePackage(packageJson)
```

Use `@syna/tsconfig/node-library.json` or equivalent NodeNext settings with JSON modules enabled.

## Stable exports

Do not put the package version in exported variable names:

```ts
export const S3Storage = define.service({ /* ... */ })
```

The descriptor carries exact package version `0.4.2`. An application that intentionally admits two installed versions can use npm aliases and local import aliases.

## Independent API generations

Service revision identity follows package semver. Contract, Input, Binding, and Entry identity follows descriptor-local `apiVersion`:

```ts
const CurrentRequest = define.input<Request>('current-request', {
  apiVersion: 1,
})
```

Increase `apiVersion` only when that descriptor’s own semantics or TypeScript API break. Do not couple it to unrelated package major changes.

## Public versus private Services

A Runtime admits explicit top-level revisions. Their exact transitive dependencies are known internally, but are not automatically exposed as public Entry roots or Contract implementations. Packages may therefore use private helper Services without leaking them into host provider collections (`C.all`, `auto(C)`).

## Inputs versus Services

Use Input for a lifecycle-free external fact fixed for one Env world:

- request object;
- tenant/blog identity;
- locale;
- configuration snapshot;
- repository path.

Use Service for an owned resource or ongoing capability:

- connection pool;
- rotating credential provider;
- watcher;
- scheduler;
- transaction;
- mutable cache.

Service instance state is opaque to Syna and may use closures or classes. Anything that changes whether an instance can be safely reused must appear as an explicit dependency.

## Dependency access

```ts
setup({ database }) {
  return {
    async read() {
      return (await database.load()).query('select ...')
    },
  }
}
```

Do not store a loaded instance beyond the lifetime of its Env. A `ServiceRef` may be stored safely; loading it after owner disposal fails.

## Structural cycles

Use `forward()` only to solve JavaScript declaration order:

```ts
let A
let B
A = define.service('a', {
  requires: { b: forward(() => B) },
  setup: ({ b }) => ({ callB: async () => (await b.load()).name }),
})
B = define.service('b', {
  requires: { a: forward(() => A) },
  setup: ({ a }) => ({ callA: async () => (await a.load()).name }),
})
```

Runtime method cycles are legal after setup. Setup-time waits are ordinary Promises: `load()` returns a plain Promise, only what you `await` blocks your setup, and an un-awaited `load()` is a background operation the Runtime neither waits for nor tracks (K07, `packages/core/tests/refs/refs-and-payloads.test.mjs`). Do not form a cycle of awaited setup loads: it cannot complete; each awaited `load()` inside it times out at its waiter's load timeout (`LOAD_TIMEOUT`, with the observed `load()` cycle named in the diagnostic) and the setups of the cycle fail on those rejections.

## Failure and cleanup

Sticky failure is the default. Opt into retries only when repeating setup is safe:

```ts
failure: {
  attempts: 3,
  delayMs: 100,
  afterExhaustion: 'retry-on-next-load',
  cooldownMs: 500,
}
```

Register cleanup during setup:

```ts
setup(_deps, { onDispose, signal }) {
  const resource = openResource({ signal })
  onDispose(() => resource.close())
  return resource
}
```

## Slow starts and the load timeout

A `load()` waits `loadTimeoutMs` on the current setup attempt — the Service's own option, else `limits.loadTimeoutMs`, default 30_000 — and then rejects with `LOAD_TIMEOUT`. The timeout is the waiter's report, not a verdict on the Service: the attempt keeps running, the slot stays `starting` (`env.inspect()` shows `overdueMs` for it), a later `load()` joins the same attempt with a window of its own, and a success that arrives late is adopted while the owner Env is ready. A Service with a long cold start — a warm-up, a large index, a remote handshake — declares a larger `loadTimeoutMs` instead of teaching its callers to retry: a retry never starts a second attempt while the first is still running, and `Infinity` disables the wait bound altogether.

```ts
const Index = define.service('index', {
  loadTimeoutMs: 120_000,          // a cold start of a minute or two is expected, not a failure
  async setup(_deps, { signal }) { return buildIndex({ signal }) },
})
```

A caller that wants to wait less than the timeout passes its own signal — `load({ signal: AbortSignal.timeout(ms) })` rejects that caller with `LOAD_CANCELLED` and leaves the attempt alone.

## Testing

Unit-test setup factories with controlled dependency refs. For integrated graph tests, use immutable Runtime-construction override:

```ts
const runtime = createRuntime({
  services: [Application, Database],
  overrides: [override(Database, FakeDatabase)],
})
```

The replacement must preserve the source instance API. The source keeps its nominal admission and Contract identity; the replacement need not be separately admitted.
