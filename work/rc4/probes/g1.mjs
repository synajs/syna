// G1 — `Date.now()` around a setTimeout(N) can measure less than N: libuv may fire
// a timer ~1 ms early and both readings truncate to whole milliseconds.
const BUDGET = 40
const ROUNDS = Number(process.argv[2] ?? 2000)
let min = Infinity
let under = 0
for (let round = 0; round < ROUNDS; round += 1) {
  const started = Date.now()
  await new Promise(resolve => setTimeout(resolve, BUDGET))
  const elapsed = Date.now() - started
  if (elapsed < min) min = elapsed
  if (elapsed < BUDGET) under += 1
}
console.log(`setTimeout(${BUDGET}) measured with Date.now(): ${ROUNDS} rounds, min=${min} ms, below the budget ${under} times`)
const startedMono = performance.now()
await new Promise(resolve => setTimeout(resolve, BUDGET))
console.log(`one round with performance.now(): ${(performance.now() - startedMono).toFixed(3)} ms`)
