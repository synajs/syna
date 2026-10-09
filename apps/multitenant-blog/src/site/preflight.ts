import type { EntryExplanation, EntryExplanationSuccess, Env } from 'synajs'
import type { ExplainedNode } from 'synajs'

export interface ForkBudget {
  /** Maximum Services that are new or forked in the explained Entry. */
  readonly maxLocalServices: number
  /** Node ids (`service:<key>`) that must be inherited, never new or forked (shared infrastructure). */
  readonly mustInherit: readonly string[]
  /** Optional cost per service key for resource-heavy nodes; default cost 1. */
  readonly costs?: Readonly<Record<string, number>>
  readonly maxCost?: number
}

export interface BudgetReport {
  readonly ok: boolean
  readonly entry: string
  readonly localServices: number
  readonly cost: number
  readonly inputs: number
  readonly synthetic: number
  readonly eagerToStart: number
  readonly violations: readonly string[]
  readonly forks: readonly { readonly nodeId: string; readonly placement: string; readonly cause: string; readonly path: readonly string[] }[]
}

const describeCause = (node: ExplainedNode): string => node.cause ? JSON.stringify(node.cause) : 'inherited'

/** Evaluates an explain() result against a budget. Counting rules are fixed: services vs synthetic vs inputs are reported separately. */
export function evaluateBudget(explanation: EntryExplanation, budget: ForkBudget): BudgetReport {
  if (!explanation.ok) {
    return {
      ok: false,
      entry: explanation.entry,
      localServices: 0,
      cost: 0,
      inputs: 0,
      synthetic: 0,
      eagerToStart: 0,
      violations: [`${explanation.error.code}: ${explanation.error.message}`],
      forks: [],
    }
  }
  const success: EntryExplanationSuccess = explanation
  const localServiceNodes = success.nodes.filter(node => node.kind === 'service' && node.placement !== 'reused')
  const violations: string[] = []
  const localServices = success.services.new + success.services.forked
  if (localServices > budget.maxLocalServices) {
    violations.push(`${localServices} local Services exceed the budget of ${budget.maxLocalServices}`)
  }
  const cost = localServiceNodes.reduce((sum, node) => sum + (budget.costs?.[node.label] ?? 1), 0)
  if (budget.maxCost !== undefined && cost > budget.maxCost) {
    violations.push(`resource cost ${cost} exceeds the budget of ${budget.maxCost}`)
  }
  for (const nodeId of budget.mustInherit) {
    const node = success.nodes.find(item => item.nodeId === nodeId)
    if (!node) {
      violations.push(`${nodeId} is not part of the plan`)
      continue
    }
    if (node.placement !== 'reused') {
      violations.push(`${nodeId} must be inherited but is ${node.placement}: ${describeCause(node)} via ${node.path.join(' -> ')}`)
    }
  }
  return {
    ok: violations.length === 0,
    entry: success.entry,
    localServices,
    cost,
    inputs: success.inputs.provided + success.inputs.inherited,
    synthetic: success.synthetic.new + success.synthetic.forked + success.synthetic.reused,
    eagerToStart: success.services.eagerToStart,
    violations,
    forks: success.forks.map(node => ({ nodeId: node.nodeId, placement: node.placement, cause: describeCause(node), path: node.path })),
  }
}

export interface PreflightResult {
  readonly ok: boolean
  readonly reports: readonly BudgetReport[]
}

/** Runs explain() from a Ready anchor for one Entry and evaluates it against a budget. Planning only; no Env is published. */
export async function preflightEntry<E extends Parameters<Env['explain']>[0]>(
  anchor: Env<any>,
  entry: E,
  parameters: Parameters<Env['explain']>[1],
  budget: ForkBudget,
): Promise<BudgetReport> {
  const explanation = await anchor.explain(entry, parameters as never)
  return evaluateBudget(explanation, budget)
}
