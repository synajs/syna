# 07 — failure modes: what happens when setup fails, hangs, or the world closes

A provider client can refuse the credential, flap during its handshake, take much longer to start than anyone wants to wait, or hang forever ignoring every request to stop. This demo runs five such scenes and shows, for each, what the calling code gets — the error code and the `details` fields worth reading — what the runtime does with the attempt behind the scenes, and what closing the world does to it.

## The five scenes (`src/index.ts`)

1. **Sticky failure** — a setup that throws. Two `load()` calls, one attempt: the failure is remembered and every later load gets the same error; the slot's state is `failed`.
2. **A retry policy** — `failure: { attempts: 3, delayMs }` retries inside one sequence (ready on the third handshake); `failure: { attempts: 2, afterExhaustion: 'retry-on-next-load', cooldownMs }` gives up after two, and the next `load()` after the cooldown starts a new sequence, which succeeds once the provider is back.
3. **A slow start** — `loadTimeoutMs: 50` on a client that needs 150 ms. The first `load()` rejects with `LOAD_TIMEOUT` (`details.slot`, `details.elapsedMs`, `details.attemptStillRunning: true`): that is the waiter's timeout, not a verdict on the client. The slot stays `starting` with `overdueMs`, `attempt-overdue` is reported once, and a later `load()` gets the instance — the late success was adopted (`attempt-succeeded-late`, `adopted: true`), and its cleanup runs at close like any other.
4. **A bounded close** — a setup that never settles and ignores the stop signal. `env.dispose()` returns after the disposal grace (`limits.disposalGraceMs: 50`), the world's state is `disposed`, the attempt is listed in `runtime.inspect().unsettledAttempts` as `abandoned`, `attempt-abandoned` names the phase and the dependency slots the attempt may still hold, and `runtime.dispose()` reports what is still outstanding once (`runtime-attempts-outstanding`). The hung attempt is still reachable — the program keeps the wake-up its setup parked on — so the runtime cannot prove it dead; a hang nothing refers to any more ends as `attempt-unreachable` instead, and the close has nothing left to abandon.
5. **A setup wait cycle** — two clients that await each other in `setup`. `LOAD_TIMEOUT` again, with `details.suspectedWaitCycle` naming the observed `load()` cycle — an observation to read, not a deadlock proof.

Every scene collects `diagnostics.onEvent` and prints the event types it saw.

## Run

```sh
npm run build && node apps/07-failure-modes/dist/index.js     # or: npm run demo:07
```

## What it prints

```
07-failure-modes: sticky failure: 2 loads, 1 attempt; both rejected with "Acme refused the API key"; slot state: failed
07-failure-modes: retry: flaky provider ready after attempt 3 of 3; provider down after 2 attempts ("Acme is down (attempt 2)"); the next load after the cooldown started a new sequence: ready after 3 attempts in total
07-failure-modes: slow start: LOAD_TIMEOUT for slot slow-start@1.0.0 after ≥ 50 ms (attempt still running: true); the slot stayed starting and overdue: true; a later load got the instance: true; events: attempt-overdue, attempt-succeeded-late (adopted: true); cleanup ran at close: true
07-failure-modes: bounded close: dispose() returned within the grace: true; env state: disposed; unsettled attempts on the runtime: 1 (abandoned); attempt-abandoned phase=setup dependencies=[credentials: ready]; runtime-attempts-outstanding: 1
07-failure-modes: wait cycle: LOAD_TIMEOUT; suspected cycle over cycle-audit@1.0.0, cycle-client@1.0.0 (an observation, not a proof); pending loads: 1
07-failure-modes: OK
```

Asserted by the program (exit 1 otherwise) and matched by the release gate's `demo-07-failure-modes` step.
