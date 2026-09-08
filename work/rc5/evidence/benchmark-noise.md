# The benchmark comparison on a loaded machine

`benchmark-compare` is the gate's same-machine, same-session check: the baseline commit is checked
out, installed and built beside the current tree, and the two are run in 21 alternating rounds
(`--expose-gc --no-maglev` on both sides); the statistic is the element-wise median of those rounds,
and every timing row must be within ±10 %. It failed on 1.0.0-rc.5 — twice, on a different row each
time. This file is the measurement that says what that means.

## The three comparisons

| # | what | failing row | delta | the same case's other rows |
|---|---|---|---|---|
| A | release gate, rc.4 (`b691067`) vs rc.5 (`b619983`) | `phase-breakdown-300.materializationMs.p95Ms` | **+14.0 %** | warmPlan p95 +2.6 %, materialization p50 +6.4 %, dispose p50 +1.3 %, p95 +5.4 % |
| B | the same comparison, repeated at once | `phase-breakdown-300.warmPlanMs.p95Ms` | **+12.1 %** | materialization p95 −0.2 %, p50 +3.5 %, dispose p50 +2.1 %, p95 −1.0 % |
| N | **null experiment**: `b619983` against *itself*, same script, same 21 rounds | `materializationMs.p50Ms` **+19.3 %** and `disposeMs.p50Ms` **+15.8 %** | materialization p95 −0.1 %, dispose p95 +8.1 % |

A and B disagree about which row is slow, and N — identical code on both sides — misses the band by
more than either of them. Whatever A measured, it was not a property of rc.5's source.

## Why this case and not the others

`phase-breakdown-300` reports four sub-phases of a single round: the cold plan (~20 ms), the warm
plan (~0.3 ms), one `load()` of the 300-service closure (~0.03 ms) and one `dispose()` (~0.08 ms).
The last three are tens of microseconds over 60 samples per round; the p50 and p95 of that are one or
two scheduling hiccups wide. The other cases in the suite — `warm-enter-dispose-*`,
`site-enter-*`, `bound-entry-*`, `override-and-all-*`, `churn-10000-requests` — are 0.1 ms and up and
stayed within ±4 % in all three comparisons, including the null one.

The run's own informational check says the same thing from the other direction. It compares the
recorded rc.4 baseline (`benchmarks/results-v1.0.0-rc.4-baseline-same-machine.json`, measured on this
machine in an earlier session) with the rc.4 build measured in this session — **identical code** —
and reports, in run B, four rows of this one case outside the band: materialization p50 +18.9 %,
p95 +10.7 %, dispose p50 +13.6 %, p95 +11.9 %. In run A the same check reported two of them.

## The machine

```
13:08  up 8 days, 17:26, 13 users, load averages: 6.85 8.40 7.38
100.0% steam_osx (running 2 days)   97.9% target/debug/xtask   94.2% iTerm2   3.7% Chrome renderer
```

Fourteen cores with roughly seven runnable threads of other people's work on them. None of it is this
session's, and none of it is mine to stop. The baseline record these runs drift from was taken on a
quieter machine: every absolute number in it is 10–25 % lower than the same build measures now.

## What was *not* done about it

The statistic was not touched: not the tolerance, not p95 → p50, not the number of rounds, not the
flags. A row that fails because the machine is loaded is fixed by measuring again on a quieter
machine, not by widening the band until it passes. Every comparison run is recorded here, including
the ones that failed, and the release gate's own record is whichever run it finally completed on.
