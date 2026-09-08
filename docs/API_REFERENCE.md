# `@syna/core` v0.8 API reference

Syna exposes immutable nominal descriptors and Entry-driven Env construction. Graph solving is global to the Runtime; TypeScript checks local shapes and descriptor compatibility. Every example below type-checks against `packages/core/src` (see `packages/core/type-tests/api.ts`). 0.8.0 is the last rename before 1.0: the names in this document are frozen (`docs/API_STABILITY.md`); `docs/GLOSSARY.md` fixes the vocabulary.

## Package definition scope

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { definePackage } from '@syna/core'

export const define = definePackage(packageJson)
```

`package.json#version` (a complete semver) is the exact version of every Service revision created by this scope. Contract, Input, Binding and Entry identities use an independent `apiVersion` (default `1`). `package.json` needs `"imports": { "#syna/package": "./package.json" }` and NodeNext module settings (`@syna/tsconfig/node-library.json`).

## Contract

```ts
interface Storage { read(key: string): Promise<Uint8Array> }
const Storage = define.contract<Storage>('storage', { apiVersion: 1, metadata: { displayName: 'Object Storage' } })
```

Dependency forms:

```ts
requires: {
  strict: Storage,          // exactly one implementation family, else AMBIGUOUS_IMPLEMENTATION
  automatic: auto(Storage), // Runtime policy chooses; MISSING_AUTO_POLICY without a policy
  all: Storage.all,         // every admitted implementation revision coexists in this Env
}
```

## Input

```ts
const CurrentRequest = define.input<Request>('current-request')
```

An Input is an external, lifecycle-free fact. An Entry parameter creates a new Input slot; omission inherits the nearest ancestor slot; explicitly providing the same payload again still creates a new slot; `undefined` is a value, a missing key is `MISSING_INPUT`. `InputValue<I>` is the value type of an Input descriptor.

### `InputRef<T>`

```ts
interface InputRef<T> {
  read(): T                          // synchronous; payload returned exactly as provided
}
```

`read()` never clones, freezes or awaits the payload: a Promise, thenable, function or `undefined` comes back by identity.

## Binding

```ts
const PreferredNotifier = define.binding('preferred-notifier', Notifier)
const ref = PreferredNotifier.to(AcmeNotify)             // default range: ^<exact version> (0.2.0 → ^0.2.0, 0.0.5 → ^0.0.5)
const bounded = PreferredNotifier.to(AcmeNotify, '>=2.4.0 <3 || 4.x')
const parsed = PreferredNotifier.parse(json)              // validates shape and Contract id
```

`to(service, range?)`/`parse(input)` produce an `ImplementationRef`, a JSON-safe preference with exactly one serialized shape: `{ kind: 'implementation-ref', contractId, familyId, range }`. `familyId` is the implementation family (`ServiceFamily.id`), `range` the semver range the reference asks for, `kind` the stable on-disk discriminator. `parse()` and every Runtime read path (`catalog.resolve()`, a Binding assignment, `set.resolve()` / `set.load(ref)`) accept that shape and nothing else: a non-object, another `kind` (the pre-0.8 kind included), another Contract, a missing or empty `familyId` or `range`, or a range that does not parse is refused with `INVALID_DESCRIPTOR` (`details.problem`: `not-an-object`, `wrong-kind` or `malformed-implementation-ref`). No older serialized form is read; a stored reference written by an earlier line is rewritten before it is read again (`docs/MIGRATION_V07_TO_V08.md`, F9). A ref never points at an Env-local slot.

Ranges are validated at definition time (`TypeError` for invalid ranges). Reassigning the same exact revision is a no-op; a different revision creates a new choice slot and forks its dependants.

## Service

```ts
const Repository = define.service('repository', {
  requires: { database: Database, request: CurrentRequest },
  provides: [RepositoryContract],
  eager: false,
  uniqueWithin: 'lineage',
  failure: { attempts: 3, delayMs: 100, afterExhaustion: 'retry-on-next-load', cooldownMs: 500 },
  loadTimeoutMs: 10_000,
  familyMetadata: { displayName: 'Repository' },
  revisionMetadata: { tags: ['stable'] },
  async setup({ database, request }, { signal, onDispose }) {
    const db = await database.load()
    const current = request.read()
    onDispose(() => db.releaseSomethingThisSetupCreated())   // never close a shared dependency
    return { /* opaque instance; must not be thenable */ }
  },
})
```

Options: `requires`, `provides`, `eager`, `uniqueWithin: 'lineage'` (a lineage-unique Family; undeclared means no uniqueness policy, `family.uniqueWithin` is then `undefined`), `failure`, `loadTimeoutMs` (how long one `load()` waits on the current setup attempt before `LOAD_TIMEOUT`, overriding the Runtime default; the attempt keeps running; `Infinity` disables), `familyMetadata` (the Family's metadata, `family.metadata`), `revisionMetadata` (this revision's, `revision.revisionMetadata`), `setup`.

### `ServiceRef<T>`

```ts
interface ServiceRef<T> {
  load(options?: { signal?: AbortSignal }): Promise<T>
}
```

`load()` materializes the already-planned slot and returns a **plain Promise**. The Runtime attaches no barrier, no completion tracking and no obligation to the caller: `catch` for degraded mode, `Promise.race` fallbacks and un-awaited background loads behave as JavaScript defines. `signal` ends only this caller's wait (`LOAD_CANCELLED`); the shared attempt continues for other waiters. A background start is an un-awaited `load()` (`void ref.load().catch(() => undefined)`): it starts the real slot, its failure follows the slot's failure policy and is visible to later `load()` calls. A ref is never thenable: `Promise.resolve(ref)` yields the ref.

```ts
const { database, logger } = await loadAll({ database, logger })   // Service refs only; a catchable batch
```

### `ServiceRevision`

`id` (`family@version`, the revision's identity), `family` (`family.id` is the stable export identity, `family.metadata` the Family-level metadata, `family.uniqueWithin` the uniqueness policy), `version`, `package`, `requires`, `provides`, `eager`, `failure`, `loadTimeoutMs`, `revisionMetadata`, `setup`, `range(range = '*')`.

`Revision.range(range)` is a compatible-revision reference that carries its **origin**, the revision it was taken from. The Runtime chooses among the revisions of the Family it knows at the site — the admitted ones and, when the site resolves in a private realm (a Service-owned Entry, a private closure), the consumer's private closure and the origin itself; in the public realm only admitted revisions are candidates, so an internal origin referenced from a public root site is `MISSING_SERVICE` (D35) — that satisfy the range and provide every Contract the origin provides; when compatible revisions exist but none provides them the plan fails with `INCOMPATIBLE_IMPLEMENTATION` (`details.required`, `details.candidates`). Because another revision may be chosen, the ref types as the origin's **Contract view** (`ProvidedShape<Provides>`, `unknown` without `provides`), not as its instance type; an exact reference keeps the full instance type.

## Entry

```ts
const RequestEntry = define.entry('request', {
  requires: { handler: RequestHandler },
  parameters: { request: CurrentRequest, notifier: PreferredNotifier },
  reuse: { fresh: [RequestCache.family], share: [Database] },
})
```

`define.entry()` returns an `Entry` (the definition record is `EntryDefinition`). `requires` is the typed surface the caller receives (`env.deps`). `parameters` are Input provisions and Binding assignments. Types: `EntryParameters<E>` is the declared parameter map (`E['parameters']`), `EntryArguments<E>` the call-time values record (one value per declared parameter), `EntryDependencies<E>` the `env.deps` shape and `EntryCallback<E, Result>` the `run` callback; `LoadedDependencies<Refs>` is the result of `loadAll`. `reuse.fresh`/`share` accept exact revisions or families (`ReuseTarget`); the planner computes the reverse dependency closure. The same constraints can be given per call as the separate options argument (`EntryOptions`) — `env.enter(RequestEntry, { request, provider }, { reuse: { fresh: [RequestCache.family] } })` — and definition-time and call-time targets are merged. Conflicts fail explicitly (`SHARE_CONSTRAINT_FAILED`; a target that is not active in the parent world is `INACTIVE_REUSE_TARGET`). `reuse` and `scope` are reserved parameter names: `reuse` is never a parameter key, and `scope` — the 0.5 form, as a definition option, on the descriptor and as a key inside the parameter record — was removed in 0.7.0. Giving either is a `TypeError` that names the current form, never silently ignored (`docs/MIGRATION_V06_TO_V07.md` §1).

## Runtime

```ts
const runtime = createRuntime({
  services: [Application, AcmeNotify, GlobexNotify],
  policy: { orderAutoCandidates(contract, candidates, context) { /* total order */ }, orderVersionCandidates(family, candidates, context) { /* ... */ } },
  overrides: [override(Database, FakeDatabase)],
  limits: { loadTimeoutMs: 30_000, disposalGraceMs: 2_000, planningBudget: 10_000, planCacheEntries: 512 },
  diagnostics: { onEvent: event => log(event) },
})
```

`createRuntime(options)` returns a `Runtime` (the 0.5 type name `SynaRuntime` was removed in 0.7.0).

- `services`: the immutable public admission set. Exact transitive dependencies form private definition realms.
- `override(source, fake)`: construction-time definition override. Source keeps nominal identity, Contract membership, eagerness and metadata; the fake supplies `requires`/`setup`/`failure`/`loadTimeoutMs`. All resolution paths use the compiled view. Duplicate source, self and cycles are errors.
- `policy`: `orderAutoCandidates(contract, candidates, context)` and `orderVersionCandidates(family, candidates, context)` receive `ServiceRevision`s and return them in preference order (a total order of the given list). `context.dependencySite` is the dependency site being resolved (`…/dependency:<name>` for a declared requirement, `…/persistent:<familyId>` for a resolved reference); `context.parentActiveRevisionIds` is the set of revision ids active in the parent lineage. (The 0.5 name `context.site` was removed in 0.7.0.)
- `limits.loadTimeoutMs`: the default wait of one `load()` on the current setup attempt (per waiter; re-armed when a retry starts a new attempt, not counted during the `delayMs` backoff) → `LOAD_TIMEOUT` with `details.attemptStillRunning: true`, `details.pendingLoads` and an optional `details.suspectedWaitCycle` (an observation, not a proof). The timeout ends the wait, not the attempt: the slot stays `starting` (`env.inspect()` reports `overdueMs` for it), `attempt-overdue` is reported once per attempt, later `load()`s join the attempt with their own windows, a late success is adopted while the owner Env is `ready` (`attempt-succeeded-late` with `adopted: true`; nothing is cleaned up) and discarded only by a close (`adopted: false`, cleanups run), a late failure follows the failure policy (`attempt-failed-late`). A timeout consumes no `failure.attempts` and triggers no `delayMs`. `enter()` is the waiter of each eager attempt: an eager setup that outlasts the timeout fails the activation (`ENTRY_ACTIVATION_FAILED`, `causeCode: 'LOAD_TIMEOUT'`, `causeDetails.slot` names the overdue slot) and the rollback close discards its late result. An attempt is not over when its setup Promise settles but when the cleanup phase that settlement started has ended (the rollback of a failed setup, or of a result a close discards), so the wait runs to there: a `load()` that joins while a rollback is still running is armed like any other, and a wait ended during a rollback ends only that wait — the attempt is *not* overdue, nothing is listed, `attempt-overdue` is not reported, the cleanups keep running and the slot accepts no overlapping attempt until they end (`details.note` says so). To wait less than the timeout use `load({ signal: AbortSignal.timeout(ms) })` (`LOAD_CANCELLED`); there is no other option. The timeout is the waiter's report, not a verdict on the Service.
- `limits.disposalGraceMs`: how long disposal waits, for one thing at a time — after broadcasting the stop signal, for each in-flight setup attempt of the closing Env (running or already overdue) to settle, and then for the cleanup phase of each owned Ready slot it disposes. The attempts of one Env wait concurrently, so that step is bounded by one grace period regardless of `loadTimeoutMs` (even `Infinity`); the slots are then disposed dependant-first over the SCC condensation with independent components at once, so that step costs one grace per slot of the longest dependency chain, not one per slot. Descendants close first, so a tree closes in at most one grace per level for that level's attempts plus that level's cleanup step. When a budget passes the close moves on whatever is still pending: at the end the Env leaves the tree and the `inspect()` counts and its `state` is `'disposed'`. What a budget bounds is a whole cleanup *phase*, and a phase runs its cleanups one after another: the failures it had already determined when the budget passed are still failures the close waited for and are reported by `dispose()`; only the undecided part — cleanups still running, and cleanups an earlier one has not let start — passes to the ledger, and the late report then lists what failed after that point and nothing else. What outlived its own budget is *abandoned*, not an error of the close in itself: `dispose()` fulfils when the phase had determined nothing, `attempt-abandoned` is reported once (`phase` is `'setup'` while the raw Promise is pending, `'rollback'` when the setup had settled and its cleanups outlived the grace, and `'cleanup'` when the slot was Ready and the cleanups of its instance did — the slot is then `'abandoned'` until they end; `dependencies` names the dependency slots it may still use — they are closed in the normal order regardless), and it is listed in `runtime.inspect().unsettledAttempts` and in `env.inspect().abandonedAttempts` until it settles late (discarded, cleaned up, `attempt-succeeded-late` / `attempt-failed-late`), until an abandoned cleanup ends (a failure then reported by `attempt-failed-late`), or until the setup Promise is found unreachable (`attempt-unreachable`). **What is bounded is the waiting, not the release of resources**: an abandoned cleanup keeps running and keeps holding what it holds.
- `limits.planningBudget`: candidate expansions per plan before `PLANNING_BUDGET_EXCEEDED`.
- `limits.planCacheEntries`: plan template cache capacity (`inspect().planCache` reports `hits`, `misses`, `entries`, `evictions`, `limit`). The values shown above are the defaults. The 0.5 nested option records (`planCache`, `initialization`, `disposal`, `planning`) were removed in 0.7.0: giving one is a `TypeError` naming the limit to use, with or without `limits`.
- `diagnostics.onEvent` (`RuntimeEvent`): `attempt-overdue` (`{ slot, revision, env, attemptNumber, deadlineMs, elapsedMs }`: the first waiter on a setup attempt timed out; once per attempt), `attempt-succeeded-late` (`adopted: true` when a late success became the instance under a ready owner, `false` when a close discarded it and its cleanups ran; `cleanupErrors`), `attempt-failed-late` (`error`, `cleanupErrors`), `attempt-abandoned` (`{ phase, slot, revision, env, elapsedMs, dependencies }`: the close of the owner Env stopped waiting — `phase` `'setup'` while the raw Promise was pending, `'rollback'` while its cleanups were, `'cleanup'` for the cleanup phase of a Ready slot the close was disposing; `dependencies` lists the Service slots it may still use, each with its `SlotState` at that moment), `runtime-attempts-outstanding` (`{ attempts }`: reported once at the end of `runtime.dispose()` when the ledger is not empty; `attempts` is the `inspect().unsettledAttempts` view at that moment), `attempt-unreachable` (an overdue or abandoned attempt whose setup Promise was garbage-collected: nothing can settle it any more, so its cleanups ran and the attempt is closed; an overdue attempt's sequence then follows its failure policy), `setup-returned-thenable` (`{ slot, revision, env }`: a setup returned a thenable instance). Exceptions in the handler are ignored; diagnostics never change outcomes.

Methods:

```ts
runtime.enter(entry, parameters?, options?)          // Promise<Env>; options: EntryOptions = { reuse?: ReuseConstraints }
runtime.run(entry, parameters?, options?, callback)  // the callback is always the last argument
runtime.check(entry, parameters?, options?)          // Promise<EntryCheck>  (plan only)
runtime.explain(entry, parameters?, options?)        // Promise<EntryExplanation> (plan only)
runtime.inspect()                     // admitted/private/overridden services, definition counts, root/live env counts, plan cache stats, warnings,
                                      // unsettledAttempts: attempts overdue (`overdue`: still running under a live owner), abandoned, rolling back or settling late, held until they settle
                                      // (the ledger, not env.state, is where an outstanding attempt shows; retention is bounded by the caller's own setup Promise, whose collection closes the attempt as unreachable)
runtime.catalog.implementations(C) / resolve(ref) / revisions(family)   // read-only metadata: ImplementationRecord[] / ImplementationRecord / version strings, highest first
runtime.dispose(); await runtime[Symbol.asyncDispose]()
```

`ImplementationRecord` (`{ contractId, familyId, version, eager, familyMetadata, revisionMetadata, implementationRef }`) is what the catalog returns for one revision of one Contract: `implementationRef` is the reference `Binding.to(revision)` would write for it (`range` = the default range of its version). `catalog.revisions()` takes the `ServiceFamily` descriptor (`revision.family`); a family id or any other descriptor is refused with `INVALID_DESCRIPTOR` (`{ descriptor: 'ServiceFamily', problem: 'not-an-object' | 'wrong-kind' }`), and an unknown Family is an empty list.

## Env

```ts
env.id; env.deps; env.state            // EnvState: 'activating' | 'ready' | 'disposing' | 'disposed'
                                       // 'disposed' at the end of the bounded close, whatever it stopped waiting for
                                       // (an abandoned attempt or cleanup lives on in the ledger, never in the state)
env.enter(entry, parameters?, options?); env.run(...); env.check(...); env.explain(...)
env.derive(options?)                   // a child Env with no Entry of its own; options: EntryOptions ({ reuse: { fresh, share } }) as for enter()
env.anchor(entry)                      // AnchoredEntry anchored at this Env, public authority
env.inspect()                          // nodes with slot ids, owners and slot states (SlotState); abandonedAttempts: the ledger entries this Env's close left behind
env.dispose(); await env[Symbol.asyncDispose]()
```

`SlotState` is `'dormant' | 'starting' | 'ready' | 'failed' | 'disposing' | 'disposed' | 'abandoned'`: the state of one Service slot as `env.inspect().nodes[].state`, `attempt-abandoned.dependencies[].state` and `SLOT_NOT_LOADABLE.details.state` report it.

Entering from an Env that is still `activating` rejects with `OWNER_NOT_READY`; from a closing or closed Env with `ENV_CLOSED`; on a disposed Runtime with `RUNTIME_CLOSED`. Activation failures are always `ENTRY_ACTIVATION_FAILED` with the underlying error as `cause` (and `details.causeCode` for SynaErrors).

### Ready and closing

An Env is Ready when every eager slot it owns is Ready; reused eager slots are already Ready in their owner. Closing: refuse new work and abort the owner signal, wait for descendants, wait for registered attempts (up to the disposal grace), then dispose owned Ready slots dependant-first over the SCC condensation — independent components at once, each slot's cleanup phase with a disposal grace of its own. Business and cleanup errors are both kept (`AggregateError`, or `error.suppressed` for `run()`); when the callback of `run()` succeeded and only the close reports, the close error carries the callback's result as a non-enumerable `result` property. Every cleanup failure the close waited for is in there exactly once, whatever became of the waiter that was loading the slot. The close is bounded by one grace period per level of the tree plus one per slot of the longest dependency chain of that level; when it ends the Env has left the tree whatever is still outstanding (see the lifecycle notes). `runtime.dispose()` waits up to `limits.disposalGraceMs` for attempts whose late cleanup is in progress (`settling`) and for abandoned cleanups, and reports the rest.

## AnchoredEntry

A Service that requires an Entry receives an `AnchoredEntry` anchored at the **owner Env of the Service slot** (not at any caller). Its roots resolve in the owner's private realm (exact and range alike); Contract discovery stays public. `enter()`/`run()` need a Ready anchor; `check()`/`explain()` only plan (no setup, no Env, no anchor, no Env id or slot id consumed — their plans are numbered `check-slot-N` / `check-choice-N`; they register the descriptors they meet, diagnose a drifted copy of a definition as `DUPLICATE_DEFINITION` exactly as `enter()` would whether the plan is solved or taken from the cache, and may fill the plan cache, all bounded by the static definition set, see `inspect().definitions`) and may run while the anchor activates.

```ts
const UnitOfWork = define.service('unit-of-work', {
  requires: { transaction: TransactionEntry },
  setup({ transaction }) {
    return { run: async (input, fn) => (await transaction.load()).run(input, async ({ tx }) => fn(await tx.load())) }
  },
})
```

## Lifecycle notes

- `ref.load()` returns a Promise of its own for every caller (all callers share one attempt). A rejected Promise nobody handles is an ordinary unhandled rejection. `load({ signal })` with an already-aborted signal rejects with `LOAD_CANCELLED` and starts nothing.
- `onDispose(cleanup)` is accepted for as long as the setup attempt is still executing, including after a waiter's timeout passed (the resource then belongs to the adopted instance and is released by disposal) or after its owner started closing (the late-settlement cleanup then runs it). A lifecycle whose setup Promise already settled is stale and refused (`LIFECYCLE_MISUSE`).
- Closing an Env moves the whole subtree to `disposing` **and only then** aborts the signals of it (abort listeners run synchronously, so the close set already refuses `enter()`, `derive()`, `load()` and recovery when the first of them runs: no listener can start a dormant Service inside the set being closed, and none can add a grace period to the bound). The close is entered before any of it runs, so `dispose()` called again from such a listener — on the same Env, on an ancestor, on the Runtime — joins the close in progress rather than starting a second one, and settles with it. The close then waits for descendants (sibling subtrees concurrently), then gives owned attempts `limits.disposalGraceMs`, then disposes owned Ready slots dependant-first (through never-started intermediates as well). `ServiceRef`s are bound to slots: a ref obtained from a child Env keeps working after that child is disposed as long as the slot's owner Env is alive.
- `env.state` is advanced only by Runtime actions — `activating → ready → disposing → disposed` — and is `'disposed'` at the end of the bounded close whatever is still pending. An attempt that ignores the signal past the grace is abandoned and reported (`attempt-abandoned`, `phase` `'setup'` or `'rollback'`); so is the cleanup phase of a Ready slot that outlives its own budget (`phase: 'cleanup'`, the slot then `'abandoned'` until the cleanup ends). Their dependencies are closed in the normal order anyway (the Runtime cannot revoke an instance it handed out) and the event names them. **What is bounded is the waiting, not the release**: an abandoned cleanup keeps running and keeps holding what it holds. The Env leaves the tree and the Runtime's registries, so its parent no longer waits for it and `inspect()` no longer counts it. The entry stays in `runtime.inspect().unsettledAttempts` and in `env.inspect().abandonedAttempts` until the attempt settles late (discarded, cleaned up, `attempt-succeeded-late` / `attempt-failed-late`), until an abandoned cleanup ends (a failure reported by `attempt-failed-late`), or until the setup Promise becomes unreachable (`attempt-unreachable`); an attempt whose setup Promise is still pending lives exactly as long as that Promise, never longer because of the Runtime, and once the setup has settled what remains is the cleanup work itself and the minimal record it needs; none of them holds anything of the Env it belonged to — a closed Env whose handle was dropped is collectable while its attempt, its rollback or its late close is still pending. `dispose()` rejects only for the cleanup failures the close waited for, each exactly once and independently of what the waiters got; a failure of what it stopped waiting for is reported by an event. `runtime.dispose()` waits up to the grace for settling attempts and abandoned cleanups and then reports the rest once as `runtime-attempts-outstanding`.
- A failed rollback is final. When a cleanup throws (inside a retry sequence, or while a late result is cleaned up) the slot stays `failed` and every later `load()` rejects with `ROLLBACK_FAILED` (`cause`: the original error), even under `afterExhaustion: 'retry-on-next-load'`: the resources of that attempt are outside Syna's control and a new attempt would stack on top of them.
- A `load({ signal })` whose signal fires rejects the caller's own Promise with `LOAD_CANCELLED`; a later failure of the attempt it was waiting for is not turned into an unhandled rejection on that caller's behalf. `AbortSignal.timeout(ms)` is the way to wait less than `loadTimeoutMs`; the attempt is unaffected either way, and a cancelled waiter takes its timeout with it.

## explain()

```ts
const explanation = await siteEnv.explain(RequestEntry, { request })
if (explanation.ok) {
  explanation.parameters // { inputsProvided, inputsInherited, bindingsAssigned, bindingsInherited }
  explanation.services   // { reused, new, forked, eagerToStart, eagerReused }
  explanation.inputs     // { inherited, provided }
  explanation.synthetic  // { reused, new, forked }  (binding projections, collections, anchored entries)
  explanation.choices    // site → revision id
  explanation.nodes      // every node with { placement: NodePlacement, cause?, path }
  explanation.forks      // every node whose placement is not 'reused'
} else {
  explanation.error, explanation.missingInputs, explanation.missingBindings
  // missing ids are collected wherever they occur: declared Entry parameters, requirements deep
  // inside the graph, and the per-candidate failures of an UNSATISFIABLE_TOPOLOGY report
}
```

`NodePlacement` is `'reused' | 'new' | 'forked'` (a *reused* node is the parent's slot; an Input or Binding *inherited* from the parent is the same idea seen from the parameter side: `inputs.inherited`, `parameters.inputsInherited`, `parameters.bindingsInherited`). `ForkCause` kinds: `root`, `not-in-parent`, `fresh`, `input-provided`, `binding-changed`, `structure-changed`, `pinned-dependency-mismatch` (a lineage-unique Family pinned above the site does not fit the dependency), `dependency-forked` (with `via` edge and `dependency` node; `path` follows the chain to the terminal cause). Node kinds (`InspectionNodeKind`): `service`, `input`, `binding`, `all-implementations`, `entry`.

## Implementation collections

`C.all` yields an `ImplementationSet`: `candidates` (each an `ImplementationRecord` with its `candidateRef`), `resolve(ref)`, `load(candidate | candidateRef | ref, options?)` (`ref`: an `ImplementationRef`). Candidates are real nodes of the current Env; a `CandidateRef` (`{ kind: 'candidate-ref', contract, familyId, version }`) belongs to one collection slot (`FOREIGN_CANDIDATE_REF` elsewhere). `ImplementationRef` (`{ kind: 'implementation-ref', contractId, familyId, range }`) is JSON-safe; without the target family it fails with `MISSING_IMPLEMENTATION` — no supplier substitution.

## Errors

`SynaError` is a union discriminated by `code`: `SynaError<'MISSING_INPUT'>` is one member, `SynaError` all of them. `isSynaError(error, code)` narrows to one member and `error.code === code` narrows `details` in a `switch`; `SynaErrorOf<Code>` is the member type, `SynaErrorDetails[Code]` the `details` type of a code (both exported; `SynaErrorConstructor` types the `SynaError` value). `details` is frozen. Diagnostics (`check`, `explain`) use the same union plus `UNKNOWN_ERROR` (`DiagnosticCode`). Policy exceptions, invalid descriptors and budget exhaustion are never disguised as `UNSATISFIABLE_TOPOLOGY`.

| Code | Thrown when | `details` |
|---|---|---|
| `AMBIGUOUS_IMPLEMENTATION` | a bare Contract dependency has several implementation Families at a site | `{ contract, site, families: string[] }` |
| `DUPLICATE_DEFINITION` | two definitions of one Family, Binding, Entry or revision disagree structurally, or a Service is overridden twice | `{ existing, received }` (Family) · `{ revision }` (override) · `{ revision, expected, actual }` (manifest) |
| `ENTRY_ACTIVATION_FAILED` | `enter()` fails while activating; the underlying error is `cause` | `{ entry, env, causeCode?, causeDetails? }` |
| `ENV_CLOSED` | an operation meets a closing or closed Env: `enter` / `run` / `check` / `explain` / `derive` from it, an anchored Entry whose anchor is gone, an activation cut short by a close (as the `cause` of `ENTRY_ACTIVATION_FAILED`); or, in the slot form, a `load()`, retry or recovery under a closing owner and a setup still pending or completed only after its owner began closing | `{ env, state: EnvState }` · `{ env, state: EnvState, slot, revision }` |
| `FOREIGN_CANDIDATE_REF` | `set.load()` receives a `CandidateRef` (or a candidate carrying one) that belongs to another implementation collection | `{ expectedSourceSlot, receivedSourceSlot }` |
| `INACTIVE_REUSE_TARGET` | a `fresh`/`share` target (definition or call) names a revision or family that is not active in the parent world | `{ constraint: 'fresh' \| 'share', env, revision }` · `{ constraint, env, family }` |
| `INCOMPATIBLE_IMPLEMENTATION` | an implementation reference or assignment names a revision that does not provide the required Contract, or no range candidate covers the origin's Contracts | `{ binding, contract, reference }` · `{ binding, revision }` · `{ contract, reference }` · `{ family, range, site, realm, origin, required: string[], candidates: { revision, provides: string[] }[] }` |
| `INVALID_DESCRIPTOR` | a descriptor, option, policy result or serialized implementation reference has the wrong shape; `descriptor` names the expected kind, the option or the offending id / key, `problem` is one of `not-an-object`, `not-an-array`, `wrong-kind`, `unknown-kind`, `empty-contract-id`, `self-override`, `override-cycle`, `forward-cycle`, `not-service-revisions`, `parameters-not-an-object`, `invalid-assignment`, `not-from-this-runtime`, `policy-result-not-an-array`, `policy-result-not-a-permutation`, `malformed-implementation-ref`; `site` where a dependency site exists, `path` for an override cycle | `{ descriptor, problem, site?, path?: string[] }` |
| `INVALID_INHERITED_CHOICE` | the resolution a site inherited from the parent lineage is no longer among the site's candidates (the plan's dependency changed between the two plans, e.g. a `forward()` target) | `{ site, selectedRevision, candidates: string[] }` |
| `LIFECYCLE_MISUSE` | `onDispose()` is called on a lifecycle whose setup attempt already settled (`state` is the attempt's) | `{ slot, revision, attemptNumber, state }` |
| `LINEAGE_UNIQUENESS_CONFLICT` | a lineage-unique Family would diverge below its pinned revision or occupy several slots in one lineage | `{ family, pinnedRevision, pinnedSlot, attempted: { revision, slot, cause, path: string[] }[] }` · `{ family, slots: string[] }` |
| `LOAD_CANCELLED` | the caller's `signal` aborts a `load()` wait | `{ slot, revision }` |
| `LOAD_TIMEOUT` | one `load()` waited `loadTimeoutMs` on the current setup attempt; the attempt keeps running (adopted if the owner stays ready, discarded only by a close) | `{ slot, revision, env, attemptNumber, deadlineMs, elapsedMs, pendingLoads: { revision, slot, state, waitingMs }[], suspectedWaitCycle?: string[], attemptStillRunning: true, note }` |
| `MISSING_AUTO_POLICY` | `auto(C)` meets several Families and the Runtime has no `policy` | `{ contract, site, families: string[] }` |
| `MISSING_BINDING` | a Binding is required at a site but chosen nowhere in the lineage, or an Entry call omits a declared Binding parameter | `{ binding, site, missing: string[] }` · `{ entry, missing, missingInputs, missingBindings }` |
| `MISSING_IMPLEMENTATION` | a Binding assignment, a bare Contract or `auto()` site, or an implementation reference / candidate names a Family, version or candidate the Runtime (or the `C.all` collection) does not have; `available` lists the admitted (or held) versions of that Family, `[]` for an unknown Family; `version` is the range the reference asked for | `{ binding, implementation, version, available: string[] }` · `{ contract, site }` · `{ contract, implementation, version, available: string[] }` |
| `MISSING_INPUT` | an Input is required at a site but provided nowhere in the lineage, or an Entry call omits a declared Input parameter | `{ input, site, missing: string[] }` · `{ entry, missing, missingInputs, missingBindings }` |
| `MISSING_SERVICE` | a revision is unknown or not admitted, is outside the private realm at a site, or no visible revision satisfies a range | `{ revision }` · `{ binding, revision }` · `{ revision, site, realm }` · `{ family, range, site, realm }` |
| `OWNER_NOT_READY` | `enter()` from an Env that is still `activating` | `{ entry, env, state: EnvState }` |
| `PLANNING_BUDGET_EXCEEDED` | planning exhausts `limits.planningBudget` (a limit, not a proof) | `{ site, budget }` |
| `ROLLBACK_FAILED` | a recovery is refused because the previous attempt's rollback failed | `{ slot, revision, state }` |
| `RUNTIME_CLOSED` | any entry point (`enter` / `run` / `check` / `explain`) of a disposed Runtime | `{}` |
| `RUNTIME_MISMATCH` | an anchor belongs to another Runtime | `{}` |
| `SHARE_CONSTRAINT_FAILED` | a `share` target cannot reuse its parent-visible slot | `{ revision, env, cause, path: string[] }` |
| `SLOT_NOT_LOADABLE` | `load()` on a slot that is `disposing`, `disposed` or `abandoned` (`state` is the slot's, a `SlotState`) | `{ slot, revision, state }` |
| `UNSATISFIABLE_TOPOLOGY` | every candidate at a site fails; `failures` lists each attempt | `{ site, candidates: string[], failures: { code, message, details }[] }` |

An attempt that outlives a close is not an error (0.7.0): the 0.6 code `UNSETTLED_ATTEMPT` was removed with S1/S2 (`docs/MIGRATION_V06_TO_V07.md` §3); the ledger (`inspect().unsettledAttempts`, `env.inspect().abandonedAttempts`) and the events `attempt-abandoned` / `runtime-attempts-outstanding` report it.

## Platform

Node ≥ 22 (validated on 22/24 in CI configuration and 26 locally), TypeScript 5.9 strict with `exactOptionalPropertyTypes`, `lib: ES2022 + ESNext.Disposable`, real `@types/node`. `Symbol.asyncDispose` is used natively; no ambient async_hooks typing is involved because v0.5 uses no AsyncLocalStorage.

## Renamed in 0.8.0, the last rename before 1.0

0.8.0 renames the public surface once more and then freezes it: no alias remains, no pre-0.8 key, code, value or event name is read or reported, and the type declarations carry no `@deprecated` item. `docs/MIGRATION_V07_TO_V08.md` lists every renamed type, field, value, event and structure item by item, with what stayed and why; `scripts/codemod-v08.mjs` rewrites a consumer's sources (idempotent; it reports the sites it cannot rewrite). The 0.6 aliases removed in 0.7.0 are listed in `docs/MIGRATION_V06_TO_V07.md`. From 0.8.0 on the names in this document change only with a major version (`docs/API_STABILITY.md`).
