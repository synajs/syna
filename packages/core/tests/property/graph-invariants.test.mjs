// 1.0.0-rc.4 / §4 — a property test over random graphs, in the shape the task book
// asks for: the ordering and the attribution of a close, on a fixed seed, with an
// oracle that owes nothing to the scheduler under test.
//
// What is random: the structure (edges, cycles, never-materialized intermediate
// nodes), which slots are materialized at all, how many cleanups each slot
// registers, in what order, and which of them throw.
//
// What is NOT random, on purpose: cleanups that hang. A hung cleanup costs a real
// grace period, which would make the gate both slow and timing-sensitive — G1 is
// the lesson. Those cases are the fixed, gate-driven scenarios of
// `disposal/cleanup-phase.test.mjs` and `disposal/close-matrix.test.mjs`.
//
// The oracle is plain reachability computed here by breadth-first search over the
// generated edges, never the condensation the Runtime builds: two slots that are
// mutually reachable are in one cycle and may be disposed in any order; otherwise
// a slot must be completely disposed before anything it depends on is touched,
// including when the path between them runs through a node that was never
// materialized.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage, forward } from '../../dist/index.js'

const SEED = 0x5ee0_4c4
const GRAPHS = 200

/** mulberry32: a small, fully deterministic PRNG, so a failing case is reproducible from its seed alone. */
const prng = seed => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}

/**
 * One random shape. Forward edges (i → j, j > i) may be awaited during setup and
 * so materialize their target; back edges (j → i) are declared but never awaited,
 * which is what produces cycles in the structural graph without a setup deadlock.
 */
const makeGraph = random => {
  const size = 6 + Math.floor(random() * 9)
  const forward = new Map()
  const back = new Map()
  for (let i = 0; i < size; i += 1) { forward.set(i, []); back.set(i, []) }
  for (let i = 0; i < size; i += 1) {
    for (let j = i + 1; j < size; j += 1) {
      if (random() < 0.25) forward.get(i).push(j)
    }
  }
  const backEdges = Math.floor(random() * 3)
  for (let count = 0; count < backEdges; count += 1) {
    const from = 1 + Math.floor(random() * (size - 1))
    const to = Math.floor(random() * from)
    if (forward.get(to).includes(from) && !back.get(from).includes(to)) back.get(from).push(to)
  }
  const awaited = new Map([...forward].map(([node, targets]) => [node, targets.filter(() => random() < 0.7)]))
  const cleanups = new Map()
  for (let i = 0; i < size; i += 1) {
    cleanups.set(i, Array.from({ length: Math.floor(random() * 4) }, (_unused, index) => ({
      id: `s${i}#${index}`,
      throws: random() < 0.35,
    })))
  }
  const roots = [...Array(size).keys()].filter(() => random() < 0.4)
  return { size, forward, back, awaited, cleanups, roots: roots.length > 0 ? roots : [0] }
}

/** Everything reachable from each node over declared edges, whether or not the path was materialized. */
const reachability = graph => {
  const edges = new Map()
  for (let i = 0; i < graph.size; i += 1) edges.set(i, [...graph.forward.get(i), ...graph.back.get(i)])
  const reaches = new Map()
  for (let i = 0; i < graph.size; i += 1) {
    const seen = new Set()
    const queue = [...edges.get(i)]
    while (queue.length > 0) {
      const node = queue.pop()
      if (seen.has(node)) continue
      seen.add(node)
      queue.push(...edges.get(node))
    }
    reaches.set(i, seen)
  }
  return reaches
}

const buildServices = (graph, define, order, failures) => {
  // Built from the last node backwards, so a forward edge (i → j, j > i) names a
  // revision that exists. A back edge closes a cycle and is declared with
  // `forward()`, the one way to name a revision that is not defined yet (§12).
  const revisions = new Array(graph.size)
  for (let i = graph.size - 1; i >= 0; i -= 1) {
    const requires = {}
    for (const target of graph.forward.get(i)) requires[`f${target}`] = revisions[target]
    for (const target of graph.back.get(i)) requires[`b${target}`] = forward(() => revisions[target])
    const awaited = graph.awaited.get(i)
    const cleanups = graph.cleanups.get(i)
    revisions[i] = define.service(`s${i}`, {
      requires,
      async setup(deps, { onDispose }) {
        // Only forward edges are awaited: a cycle of setup waits cannot settle (§12).
        for (const target of awaited) await deps[`f${target}`].load()
        for (const cleanup of cleanups) {
          onDispose(() => {
            order.push(cleanup.id)
            if (cleanup.throws) {
              failures.push(cleanup.id)
              throw Object.assign(new Error(`cleanup ${cleanup.id} failed`), { marker: cleanup.id })
            }
          })
        }
        return { node: i }
      },
    })
  }
  return revisions
}

const flat = error => (error instanceof AggregateError ? error.errors.flatMap(flat) : [error])

test(`property: ${GRAPHS} random graphs close in dependant-first order and report every cleanup failure exactly once (seed ${SEED})`, async () => {
  const random = prng(SEED)
  // The generator must be shown to generate: a property test over trivial graphs
  // proves nothing, so the run reports what it actually covered.
  const covered = { cleanups: 0, failures: 0, cycles: 0, dormant: 0, orderedPairs: 0 }
  for (let index = 0; index < GRAPHS; index += 1) {
    const graph = makeGraph(random)
    const order = []
    const failures = []
    const define = definePackage({ name: `@rc4/property-${index}`, version: '1.0.0', syna: { id: `rc4.property.${index}` } })
    const services = buildServices(graph, define, order, failures)
    const Entry = define.entry({ requires: Object.fromEntries(services.map((service, node) => [`s${node}`, service])) })
    const runtime = createRuntime({ services, limits: { disposalGraceMs: 200 } })
    const describe = () => JSON.stringify({
      seed: SEED,
      graph: index,
      size: graph.size,
      forward: [...graph.forward].map(([node, targets]) => [node, targets]),
      back: [...graph.back].map(([node, targets]) => [node, targets]),
      awaited: [...graph.awaited].map(([node, targets]) => [node, targets]),
      roots: graph.roots,
      cleanups: [...graph.cleanups].map(([node, list]) => [node, list]),
      order,
    })
    try {
      const env = await runtime.enter(Entry)
      for (const root of graph.roots) await env.deps[`s${root}`].load()
      const materialized = new Set(
        env.inspect().nodes
          .filter(node => node.kind === 'service' && node.state === 'ready')
          .map(node => Number(node.label.match(/\/s(\d+)@/)[1])),
      )
      const closeError = await env.dispose().then(() => undefined, error => error)

      // 1. Every cleanup of a materialized slot ran exactly once, and no other did.
      const expected = [...materialized].flatMap(node => graph.cleanups.get(node).map(cleanup => cleanup.id)).sort()
      assert.deepEqual([...order].sort(), expected, `every cleanup of a materialized slot ran exactly once ${describe()}`)

      // 2. Dependant-first over the declared graph, cycles excepted, paths through
      //    never-materialized nodes included.
      const reaches = reachability(graph)
      const first = new Map()
      const last = new Map()
      for (const [position, id] of order.entries()) {
        const node = Number(id.slice(1, id.indexOf('#')))
        if (!first.has(node)) first.set(node, position)
        last.set(node, position)
      }
      for (const dependant of first.keys()) {
        for (const dependency of first.keys()) {
          if (dependant === dependency) continue
          if (!reaches.get(dependant).has(dependency)) continue
          if (reaches.get(dependency).has(dependant)) { covered.cycles += 1; continue } // one cycle: no order is promised
          covered.orderedPairs += 1
          assert.ok(last.get(dependant) < first.get(dependency),
            `s${dependant} depends on s${dependency} and must be disposed first ${describe()}`)
        }
      }

      // 3. Every failure the close waited for is in its AggregateError exactly once,
      //    identified by the cleanup execution that produced it.
      const reported = closeError ? flat(closeError).map(error => error.marker).filter(Boolean).sort() : []
      assert.deepEqual(reported, [...failures].sort(), `every cleanup failure reported exactly once ${describe()}`)

      // 4. Nothing is left over.
      assert.equal(env.state, 'disposed', describe())
      assert.equal(runtime.inspect().unsettledAttempts.length, 0, `nothing outstanding ${describe()}`)
      assert.equal(runtime.inspect().liveEnvCount, 0, describe())
      covered.cleanups += order.length
      covered.failures += failures.length
      covered.dormant += graph.size - materialized.size
    }
    finally {
      await runtime.dispose().catch(() => undefined)
    }
  }
  assert.ok(covered.orderedPairs > 500, `the ordering oracle had something to check (${covered.orderedPairs} ordered pairs)`)
  assert.ok(covered.cycles > 0, `graphs with strongly connected components were generated (${covered.cycles} mutually reachable pairs)`)
  assert.ok(covered.dormant > 50, `slots that were never materialized were generated (${covered.dormant})`)
  assert.ok(covered.failures > 100, `cleanup failures were generated (${covered.failures} of ${covered.cleanups} executions)`)
})
