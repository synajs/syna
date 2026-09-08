# v0.4 adversarial audit

This document records the attacks that changed the v0.4 implementation. It is not a claim that future bugs are impossible.

## Selector template leak

**Attack:** candidate Entry ids contained the short-lived selector slot id, so every request generated new plan templates and definition signatures.

**Correction:** candidate Entry identity is stable by Contract and exact candidate revision. CandidateRef remains selector-slot-local, but plan identity does not. Plan templates live in a bounded LRU. Selector, Binding, and churn benchmarks verify non-linear growth does not recur.

## Promise-wait inference

**Attack:** AsyncLocalStorage could identify the setup context that called `load()`, but JavaScript cannot reveal whether the returned Promise was actually awaited. One version missed indirect cycles; the next could classify fire-and-forget warming as a cycle.

**Correction:** intent is explicit. `load()` is always strong during setup and joins a completion barrier; `preload()` is explicitly non-blocking. The wait graph now models declared operational semantics instead of guessing source-level `await`.

*Superseded in v0.5:* there is no completion barrier any more. `load()` returns a plain Promise, an un-awaited `load()` is a background operation and `preload()` is deprecated (`docs/SEMANTIC_CHANGES_V05.md` §6, K07 in `packages/core/tests/refs/refs-and-payloads.test.mjs`).

## Retry during disposal

**Attack:** retry continued through an aborted signal and made Env disposal wait for the entire retry schedule.

**Correction:** every attempt and delay checks owner state and signal. Backoff is abortable, no new recovery generation starts during disposal, and tests enforce prompt shutdown.

## Incoherent substitution

**Attack:** late edge redirection made exact dependencies resolve to Fake while Contract candidates still contained Real and Fake; `fresh(Real)` targeted an inactive node.

**Correction:** `override(Real, Fake)` is compiled in the definition registry. Real retains nominal identity and public Contract position; Fake supplies executable setup/dependencies. Candidate enumeration, persistent refs, exact dependencies, selector/all, and scope constraints agree.

## Private Bound Entry roots

**Attack:** a private Transaction was known in the definition closure but a Service-owned TransactionEntry still resolved roots with public-only authority.

**Correction:** BoundEntry carries a restricted resolution realm derived from its declaring Service. Exact roots declared by that Entry are permitted; unrelated private definitions and private Contract discovery are not.

## Sticky failure recovery

**Attack:** retries only repeated attempts inside one setup Promise. Exhaustion poisoned the canonical slot permanently even when policy claimed future recovery.

**Correction:** failure policy separates attempts per sequence from after-exhaustion recovery. `retry-on-next-load` atomically starts one later sequence, with optional cooldown; concurrent callers join it.

## Activation-time child worlds

**Attack:** owner-bound Entries were forbidden while an eager owner was activating, preventing the primary worker-world use case.

**Correction:** child Entry activation may join the owner's activation transaction. Failure rolls back the child; reverse setup waits are detected as cycles.

## Remaining explicit boundaries

Syna v0.4 remains a static, immutable composition runtime. It does not implement Runtime hot installation, Env merge, reactive Input tracking, ambient caller Env, cross-process uniqueness, or forced revocation of escaped plain JavaScript instances.
