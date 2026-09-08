# 1.0.0-rc.4 — baseline on 1.0.0-rc.3 (`9c57269`)

Everything below was measured on this machine (Node v26.0.0, darwin arm64) against the
working tree at `9c57269` before a single line of the fix was written. The probes are in
`work/rc4/probes/`; `n1`–`n4`, `a4`, `waiter2`, `extra`, `abort-throw`, `onevent` are the ones
the root-cause round wrote (they were in a session scratchpad, not in the repository —
`work/rc4/ROOT_CAUSE.md` §0 records that), `n5.mjs` and `g1.mjs` are new here.

Every probe asserts that the **defect is present**, so on this tree the expected reading is
REPRODUCED. §7 of the task book forbids taking them into the suite as they are: `work/rc4/`
keeps them as the record of the baseline, and the tests added by this round assert the
**flipped** behaviour instead (`packages/core/tests/rc4-*.test.mjs`,
`apps/multitenant-blog/tests/rc4-acquire-deadline.test.mjs`).

## 0. The two previous rounds are still closed

```
work/rc3/probes/core-lifecycle.mjs   L1 L2 L2b L3   → 0/4 reproduced
work/rc3/probes/site-manager.mjs     A1 A2 A3       → 0/3 reproduced
```

## 1. N1 — a determined cleanup failure is hidden by a later one that hangs (`node work/rc4/probes/n1.mjs`)

```
N1a  ready-slot cleanup: error then hang
    dispose=fulfilled  events=[attempt-abandoned:cleanup]  ledger=[abandoned]
N1a  after releasing the hung cleanup
    events=[attempt-abandoned:cleanup,attempt-failed-late]  ledger=[0]
N1b  ready-slot cleanup: hang then (never-run) release
    dispose=fulfilled  events=[attempt-abandoned:cleanup]  secondCleanupRan=false
N1c  two determined failures behind one hang
    dispose=fulfilled  events=[attempt-abandoned]
N1d  attempt rollback: error then hang
    dispose=fulfilled  events=[attempt-abandoned:rollback]  waiter=pending  ledger=[rolling-back]
N1e  control, all inside the grace
    dispose=rejected:1  events=[]
```

## 2. N2 — an abort listener re-enters `dispose()` (`node work/rc4/probes/n2n3.mjs`, `extra.mjs`)

```
N2a  outer=fulfilled  afterMs=0  envState=disposed  live=0  cleanupCalls=1  stillHanging=true  events=[]  ledger=0
     the flow nobody awaits: inner=fulfilled  events=[attempt-abandoned:cleanup]  elapsedMs=502
N2b  events=[attempt-abandoned:cleanup, runtime-attempts-outstanding, runtime-attempts-outstanding]
N2c  child listener re-enters child.dispose()  → safe (afterMs=300, one event)
N2d  onEvent re-enters dispose()               → safe
N2e  a cleanup awaits its own dispose()        → bounded (92 ms), no deadlock
```

## 3. N3 — the close set is not closed before the callback runs (`n2n3.mjs`, `extra.mjs`)

```
N3a  childStateAtParentAbort=ready  dormantSetupsAfterClose=1  childLoad=ENV_CLOSED  events=[attempt-succeeded-late]
N3b  entered=ENTRY_ACTIVATION_FAILED  grandchildState=none  live=0  roots=0
N3c  graceMs=80  withListener=82 ms  control=0 ms  ledger=1      ← the close-time bound is broken
N3d  runtime.dispose(): secondStateAtAbort=ready  dormantSetups=1  load=ENV_CLOSED
```

## 4. N4 — suspended frames retain the Env graph (`node --expose-gc work/rc4/probes/n4.mjs`)

```
P1 setup pending      subject=env=false payload=false   control=false   ledger=[abandoned]
P2 rollback pending   subject=env=true  payload=true    control=false   ledger=[rolling-back]   ← red
P3 ready cleanup      subject=env=false payload=false   control=false   ledger=[abandoned]
P4 late cleanup       subject=env=true  payload=true    control=false   ledger=[settling]       ← red
(after the hung cleanup is released all four are env=false payload=false, ledger=0)
```

## 5. N5 — the waiter loses its deadline the moment the raw setup settles (`node work/rc4/probes/n5.mjs`)

```
N5a  lazy load(), rollback hangs, Env open
    first=pending  second=pending  envState=ready  slot=starting  ledger=0  events=[]
N5b  eager activation, rollback hangs
    enter=pending  live=1  ledger=0  events=[]
```

`loadTimeoutMs` is 100 ms in both; both were still pending 400–500 ms later and no event was
reported. `waiter2.mjs` shows the same at 515 ms.

## 6. A4 — `acquireTimeoutMs` does not cover the creation (`node work/rc4/probes/a4.mjs`)

```
A4a  acquireTimeoutMs=20 ms, gate inside create()
    afterMs=84  acquire=still pending → after opening the gate: {"value":"acquired"}   ← a lease, not a timeout
A4b  a joining acquirer (await record.creation)     afterMs=82  second=still pending
A4c  shutdown() with an acquirer inside create()
    shutdown=still pending  shutdownMs=401  acquirer=still pending
    after opening the gate: acquirer=SITE_MANAGER_CLOSED  totalMs=502
```

`shutdown()` itself running past `shutdownTimeoutMs` is **not** a defect
(`docs/MULTITENANT_BLOG.md:71`); the defect is that the acquirer inside `create()` only learns
of the shutdown when the creation returns.

## 7. G1 — the two zero-tolerance wall-clock lower bounds (`node work/rc4/probes/g1.mjs 3000`)

```
setTimeout(40) measured with Date.now(): 3000 rounds, min=39 ms, below the budget 8 times
one round with performance.now(): 41.131 ms
```

`packages/core/tests/close-matrix.test.mjs:249` (`wideElapsed >= graceMs`) and `:263`
(`deepElapsed >= graceMs * 3`) are the only two assertions in the repository that compare a
measured wall-clock duration against a budget with no tolerance; every other one leaves 5 ms
or ~10 %. The cloud gate's PARTIAL was 39 ms against the 40 ms budget — 8/3000 here.

## 8. Not a defect

- `abort-throw.mjs`: a throwing abort listener does **not** interrupt `broadcastClosing`
  (`dispose=fulfilled root=disposed child=disposed grandchild=disposed live=0`); the throw
  becomes an `uncaughtException` per Node's `EventTarget` semantics.
- `onevent.mjs`: a throwing `onEvent` changes nothing (`runtime.ts` wraps it in try/catch).

## 9. Every new test was run against the pre-fix source first

With `packages/core/src` and `apps/multitenant-blog/src` stashed back to `9c57269` and the
workspace rebuilt, the tests this round adds read as follows (the stash was popped and the
workspace rebuilt afterwards; `git stash list` is empty):

```
packages/core/tests/rc4-cleanup-phase.test.mjs        13 pass  11 fail
packages/core/tests/rc4-close-invariants.test.mjs      7 pass   9 fail
packages/core/tests/rc4-waiter-termination.test.mjs   hangs — the defect itself: the first
                                                      load() never settles, so the run had
                                                      to be killed
packages/core/tests/rc4-retention.test.mjs             3 pass   3 fail   (P2, P4, runtime.dispose)
apps/multitenant-blog/tests/rc4-acquire-deadline.test.mjs
                                                      hangs — the defect itself: the acquire
                                                      never times out
packages/core/tests/rc4-graph-property.test.mjs        1 pass   0 fail
packages/core/tests/close-matrix.test.mjs             19 pass   0 fail
```

The last two pass on both sides on purpose and are recorded as such: the property test is a
net for the dimensions the matrix never covered, not a regression test for this round's
defects, and the G1 rework changes how the same property is asserted, not what the Runtime
does. Everything else is red — or silent — before the fix and green after it.
