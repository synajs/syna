// K03 — a slow, brute-force parent-only reference planner checked against the
// production planner on seeded random graphs. It covers exactly the sub-model
// it enumerates (exact Service edges, Input edges, fresh, re-provided Inputs);
// it is not a proof about version solving, Bindings, realms or lifecycle.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage, forward } from '../../dist/index.js'

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generate(seed) {
  const random = mulberry32(seed)
  const pick = (array) => array[Math.floor(random() * array.length)]
  const define = definePackage({ name: `@ref/g${seed}`, version: '1.0.0', syna: { id: `ref.g${seed}` } })
  const inputs = ['i0', 'i1'].map(name => define.input(name))
  const count = 2 + Math.floor(random() * 6)
  const specs = []
  for (let index = 0; index < count; index += 1) {
    const deps = {}
    const depCount = Math.floor(random() * 3)
    for (let d = 0; d < depCount; d += 1) {
      const target = Math.floor(random() * count)
      if (target === index) continue
      deps[`s${target}`] = target
    }
    const inputDeps = {}
    if (random() < 0.45) inputDeps[`in${Math.floor(random() * 2)}`] = Math.floor(random() * 2)
    specs.push({ index, deps, inputDeps })
  }
  const services = []
  for (const spec of specs) {
    const requires = {}
    for (const [key, target] of Object.entries(spec.deps)) requires[key] = forward(() => services[target])
    for (const [key, target] of Object.entries(spec.inputDeps)) requires[key] = inputs[target]
    services.push(define.service(`s${spec.index}`, { requires, setup: () => ({ id: spec.index }) }))
  }
  const rootRequires = Object.fromEntries(services.map((service, index) => [`s${index}`, service]))
  const Root = define.entry('root', { requires: rootRequires, parameters: { in0: inputs[0], in1: inputs[1] } })
  const childRoots = services.filter(() => random() < 0.6)
  if (childRoots.length === 0) childRoots.push(pick(services))
  const reprovide = [random() < 0.4, random() < 0.4]
  const parameters = {}
  if (reprovide[0]) parameters.in0 = inputs[0]
  if (reprovide[1]) parameters.in1 = inputs[1]
  const freshTargets = services.filter(() => random() < 0.2).map(service => random() < 0.5 ? service : service.family)
  const Child = define.entry('child', {
    requires: Object.fromEntries(childRoots.map(service => [service.family.id.split('/').at(-1), service])),
    parameters,
    reuse: { fresh: freshTargets },
  })
  return { seed, define, inputs, specs, services, Root, Child, reprovide, freshTargets }
}

/** Brute-force parent-only greatest reuse set over the child's node closure. */
function referenceReuse(world, parentNodeIds) {
  const { specs, services, inputs, reprovide, freshTargets, Child } = world
  const freshKeys = new Set(freshTargets.map(target => target.kind === 'service-revision' ? target.id : target.id))
  const isFresh = service => freshKeys.has(service.id) || freshKeys.has(service.family.id)

  // Child graph closure from the child's roots (inherited roots are the root Entry's: every service).
  const childNodes = new Set(services.map(service => `service:${service.id}`))
  for (const spec of specs) for (const target of Object.values(spec.inputDeps)) childNodes.add(`input:${inputs[target].id}`)
  void Child
  const serviceNodes = services.filter(service => parentNodeIds.has(`service:${service.id}`) && !isFresh(service))
  const edgesOf = service => {
    const spec = specs[Number(service.family.id.split('/s').at(-1))]
    return {
      services: Object.values(spec.deps).map(target => services[target]),
      inputs: Object.values(spec.inputDeps).map(target => target),
    }
  }
  const valid = new Set()
  const total = 1 << serviceNodes.length
  for (let mask = 0; mask < total; mask += 1) {
    const subset = serviceNodes.filter((_, index) => mask & (1 << index))
    const keys = new Set(subset.map(service => service.id))
    const ok = subset.every(service => {
      const edges = edgesOf(service)
      if (edges.inputs.some(inputIndex => reprovide[inputIndex])) return false
      return edges.services.every(target => keys.has(target.id))
    })
    if (ok) valid.add(mask)
  }
  const maximal = [...valid].filter(mask => ![...valid].some(other => other !== mask && (other & mask) === mask))
  return {
    maximal: maximal.map(mask => new Set(serviceNodes.filter((_, index) => mask & (1 << index)).map(service => `service:${service.id}`))),
    candidateCount: serviceNodes.length,
    validCount: valid.size,
  }
}

async function compare(seed) {
  const world = generate(seed)
  const runtime = createRuntime({ services: world.services })
  const root = await runtime.enter(world.Root, { in0: 'root-0', in1: 'root-1' })
  const parentNodeIds = new Set(root.inspect().nodes.map(node => node.nodeId))
  const parameters = {}
  if (world.reprovide[0]) parameters.in0 = 'child-0'
  if (world.reprovide[1]) parameters.in1 = 'child-1'
  const explanation = await root.explain(world.Child, parameters)
  const child = await root.enter(world.Child, parameters)
  const rootSlots = new Map(root.inspect().nodes.map(node => [node.nodeId, node.slotId]))
  const inheritedByEnter = new Set(
    child.inspect().nodes
      .filter(node => node.kind === 'service' && rootSlots.get(node.nodeId) === node.slotId)
      .map(node => node.nodeId),
  )
  const inheritedByExplain = new Set(
    explanation.nodes.filter(node => node.kind === 'service' && node.placement === 'reused').map(node => node.nodeId),
  )
  const reference = referenceReuse(world, parentNodeIds)
  const describe = () => JSON.stringify({
    seed,
    specs: world.specs,
    reprovide: world.reprovide,
    fresh: world.freshTargets.map(target => target.kind === 'service-revision' ? target.id : `family:${target.id}`),
    production: [...inheritedByEnter].sort(),
    reference: reference.maximal.map(set => [...set].sort()),
  })
  assert.equal(reference.maximal.length, 1, `reference greatest reuse set must be unique: ${describe()}`)
  assert.deepEqual([...inheritedByEnter].sort(), [...reference.maximal[0]].sort(), `production differs from reference: ${describe()}`)
  assert.deepEqual([...inheritedByExplain].sort(), [...inheritedByEnter].sort(), `explain differs from enter: ${describe()}`)
  await runtime.dispose()
  return reference
}

test('reference parent-only planner agrees with the production planner on 200 seeded random graphs', async () => {
  let validTotal = 0
  let candidateTotal = 0
  for (let seed = 1; seed <= 200; seed += 1) {
    const reference = await compare(seed)
    validTotal += reference.validCount
    candidateTotal += reference.candidateCount
  }
  assert.ok(candidateTotal > 200, 'the sample exercised non-trivial candidate sets')
  assert.ok(validTotal > 200)
})

test('reference planner: the greatest reuse set is the union of all valid subsets (fixed point), shown on a hand-built diamond', async () => {
  const define = definePackage({ name: '@ref/diamond', version: '1.0.0', syna: { id: 'ref.diamond' } })
  const Tenant = define.input('tenant')
  const Base = define.service('base', { setup: () => ({}) })
  const Left = define.service('left', { requires: { base: Base, tenant: Tenant }, setup: () => ({}) })
  const Right = define.service('right', { requires: { base: Base }, setup: () => ({}) })
  const Top = define.service('top', { requires: { left: Left, right: Right }, setup: () => ({}) })
  const Root = define.entry('root', { requires: { top: Top }, parameters: { tenant: Tenant } })
  const Child = define.entry('child', { requires: { top: Top }, parameters: { tenant: Tenant } })
  const runtime = createRuntime({ services: [Top, Left, Right, Base] })
  const root = await runtime.enter(Root, { tenant: 'a' })
  const explanation = await root.explain(Child, { tenant: 'b' })
  const byId = Object.fromEntries(explanation.nodes.map(node => [node.nodeId, node]))
  assert.equal(byId[`service:${Base.id}`].placement, 'reused')
  assert.equal(byId[`service:${Right.id}`].placement, 'reused')
  assert.equal(byId[`service:${Left.id}`].placement, 'forked')
  assert.equal(byId[`service:${Top.id}`].placement, 'forked')
  assert.deepEqual(byId[`service:${Top.id}`].path, [`service:${Top.id}`, `service:${Left.id}`, `input:${Tenant.id}`])
  await runtime.dispose()
})
