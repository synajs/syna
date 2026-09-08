# Endings decided by the garbage collector

## Why this probe exists

The `--release` gate on `e80440d` was PARTIAL: one step, `rebuild-examples`, failed inside the
copy unpacked from the source archive, while the very same program had passed in the workspace
minutes earlier in the same run.

```
07-failure-modes: bounded close: dispose() returned within the grace: false; env state: disposed;
  unsettled attempts on the runtime: 0 (); attempt-abandoned phase=- dependencies=[];
  runtime-attempts-outstanding: 0
AssertionError [ERR_ASSERTION]: close took 2 ms
    at …/syna-v1.0.0-rc.5-source/apps/07-failure-modes/dist/index.js:136:12
```

`unsettled attempts: 0` and no `attempt-abandoned` say what happened: nothing was abandoned,
because by the time the close began there was no attempt left. The scene's hung setup parked on
`new Promise<never>(() => undefined)` — a Promise nothing referred to any more. A collection in
that window lets the Runtime prove the attempt can never settle, so it closes it as
`attempt-unreachable` (`docs/API_REFERENCE.md`, `packages/core/src/internal/attempt-ledger.ts`),
the ledger empties and the close has nothing to wait for. Both endings are real behaviour; the
scene asserted one of them and left the choice to the collector.

Reproduction of both endings on the rc.5 build, same program, one forced collection apart:

```
$ node repro07.mjs               {"closeMs":52,"ledger":["abandoned"],"events":["attempt-overdue","attempt-abandoned"]}
$ node --expose-gc repro07.mjs --gc  {"closeMs":1,"ledger":[],"events":["attempt-overdue","attempt-unreachable"]}
```

## The probe

`--import` a module that forces a full collection every 10 ms, so every WeakRef- and
FinalizationRegistry-driven diagnosis fires wherever it legitimately can:

```js
// gc-pressure.mjs
let n = 0
const timer = setInterval(() => { try { globalThis.gc(); n++ } catch { /* no --expose-gc */ } }, 10)
timer.unref()
process.on('exit', () => { if (process.env.GC_REPORT) process._rawDebug(`[gc-pressure] ${n} collections`) })
```

```sh
node --expose-gc --import file://<path>/gc-pressure.mjs --test --test-reporter=tap <files>
NODE_OPTIONS='--expose-gc --import file://<path>/gc-pressure.mjs' npm run demo
```

## Before

Four core suites (of the 24 lifecycle files probed) asserted an ending their fixture left to the
collector. Each failure is the `attempt-unreachable` ending arriving where the case had written
down the abandoned one:

| suite | case | assertion under GC |
|---|---|---|
| `disposal/bounded-close.test.mjs` | F-PL-01 `loadTimeoutMs: Infinity` cannot turn a stuck setup into a hanging dispose(), enter() or run() | `the plain Env, the rolled-back eager Env and the run() Env each left one attempt`: actual 1, expected 3 |
| `disposal/state-and-ledger.test.mjs` | 2. the state does not depend on the setup Promise … the ledger keeps the entry until settlement | `unsettledAttempts.length`: actual 1, expected 2 |
| `materialization/waiters-and-cancellation.test.mjs` | K08 disposal abandons an attempt that never settles | events: actual `['attempt-overdue','attempt-unreachable']`, expected `['attempt-overdue','attempt-abandoned']` |
| `errors/env-state.test.mjs` | site 6 `SLOT_NOT_LOADABLE { slot, revision, state }` | message: actual `… is disposed.`, expected `… is abandoned.` |

`disposal/state-and-ledger.test.mjs` also carried the claim in its file header: *“No test here
uses `--expose-gc`: the state never depends on garbage collection.”* Its case 2 did.

## After

Each case now keeps the resolver of its hung setup, so the attempt can always still settle and the
asserted ending is the one the fixture actually creates. The other ending keeps its own
deterministic case (`materialization/waiter-deadline.test.mjs`, a `--expose-gc` child process that
forces the collection and asserts `attempt-unreachable`, the ledger shrinking and the failure path).
`apps/07-failure-modes` scene 4 parks on a wake-up the program keeps and never sends; its printed
line, and the gate's expectation of it, are unchanged.

Under the same probe:

| what | result |
|---|---|
| `packages/core/tests/**/*.test.mjs` | `# tests 338 # pass 338 # fail 0` |
| `audit-app`, `review-app`, `rc3-close-paths`, `rc4-acquire-deadline`, `site-manager`, `preflight` | `# tests 65 # pass 65 # fail 0` |
| the seven examples (`npm run demo`) | `01-basics: OK` … `07-failure-modes: OK` |
| the blog demo (`npm run demo:multitenant-blog`) | `demo: OK`, three `: 200` cells |

The probe is a check, not a gate step: forcing a collection every 10 ms is not a condition any
release has to hold. What the release gate holds is the repaired cases themselves.
