/**
 * Run quality gates with bounded concurrency, a validated dependency graph, and
 * explicit skip accounting.
 *
 * A gate is data, not a script: the MODES table at the bottom of this file is the
 * single place a repository declares what it checks. Package scripts own the public
 * aggregate names; this runner owns the graph, the scheduler, and the diagnostics.
 *
 *   node scripts/harness/run-gates.ts <mode> [--list] [--concurrency N]
 */

import { spawn } from 'node:child_process'

/** One check in the graph. */
export interface Gate {
  /** Stable identifier used by `needs` and `after`. */
  id: string
  /** Human label printed in the summary. */
  label: string
  /** Executable to spawn. */
  command: string
  /** Arguments passed to `command`. */
  args: string[]
  /**
   * Hard dependencies: when any of these fails, this gate is skipped rather than run.
   * Use for gates that would read half-written output or report noise.
   */
  needs?: string[]
  /**
   * Ordering only: wait for these to settle, but run regardless of their result.
   * Use to serialize a writer against readers without making the writer a
   * precondition.
   */
  after?: string[]
  /** Extra environment for this gate. */
  env?: Record<string, string | undefined>
  /** Part of the fast documentation subset that needs no build. */
  quick?: boolean
  /** Failure is reported but does not fail the run. */
  allowFailure?: boolean
}

/** Terminal state of one gate. */
export type GateStatus = 'passed' | 'failed' | 'skipped'

/** Outcome of one gate, including how it ended. */
export interface GateResult {
  gate: Gate
  status: GateStatus
  /** Why this gate never ran, when `status` is `skipped`. */
  skipReason?: string
  exitCode: number | null
  durationMs: number
  output: string
}

/** Reject a graph that cannot run: unknown references and dependency cycles. */
export function validateGateGraph(gates: readonly Gate[]): string[] {
  const errors: string[] = []
  const byId = new Map<string, Gate>()
  for (const gate of gates) {
    if (byId.has(gate.id)) errors.push(`duplicate gate id ${JSON.stringify(gate.id)}`)
    byId.set(gate.id, gate)
  }
  for (const gate of gates) {
    for (const reference of [...gate.needs ?? [], ...gate.after ?? []]) {
      if (!byId.has(reference)) errors.push(`${gate.id}: unknown dependency ${JSON.stringify(reference)}`)
      if (reference === gate.id) errors.push(`${gate.id}: depends on itself`)
    }
  }
  const cycle = findDependencyCycle(gates)
  if (cycle !== undefined) errors.push(`dependency cycle: ${cycle.join(' -> ')}`)
  return errors
}

/** Depth-first search that returns the first dependency cycle as an id path. */
export function findDependencyCycle(gates: readonly Gate[]): string[] | undefined {
  const byId = new Map(gates.map(gate => [gate.id, gate]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  let cycle: string[] | undefined

  const visit = (id: string): void => {
    if (cycle !== undefined) return
    const current = state.get(id)
    if (current === 'done') return
    if (current === 'visiting') {
      cycle = [...stack.slice(stack.indexOf(id)), id]
      return
    }
    state.set(id, 'visiting')
    stack.push(id)
    const gate = byId.get(id)
    for (const reference of [...gate?.needs ?? [], ...gate?.after ?? []]) {
      if (byId.has(reference)) visit(reference)
    }
    stack.pop()
    state.set(id, 'done')
  }

  for (const gate of gates) visit(gate.id)
  return cycle
}

/** Dependencies that must settle before a gate may start. */
function dependencies(gate: Gate): string[] {
  return [...new Set([...(gate.needs ?? []), ...(gate.after ?? [])])]
}

/** Whether a gate's `needs` are satisfied by the settled results so far. */
function unmetNeeds(gate: Gate, settled: ReadonlyMap<string, GateResult>): string[] {
  return (gate.needs ?? []).filter(id => {
    const result = settled.get(id)
    return result !== undefined && (result.status === 'failed' || result.status === 'skipped')
  })
}

/** Spawn one gate and buffer its combined output. */
function runGate(gate: Gate): Promise<GateResult> {
  const startedAt = Date.now()
  return new Promise(resolve => {
    const child = spawn(gate.command, gate.args, {
      env: { ...process.env, ...gate.env },
      // A process group lets one kill reach the whole tree on POSIX hosts.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', (error: Error) => {
      resolve({
        gate,
        status: 'failed',
        exitCode: null,
        durationMs: Date.now() - startedAt,
        output: `${output}${error.message}\n`,
      })
    })
    child.on('close', (code: number | null) => {
      resolve({
        gate,
        status: code === 0 ? 'passed' : 'failed',
        exitCode: code,
        durationMs: Date.now() - startedAt,
        output,
      })
    })
  })
}

/** Options controlling one `runGates` invocation. */
export interface RunGatesOptions {
  /** Maximum gates running at once. */
  concurrency?: number
  /**
   * Stop launching new gates after the first blocking failure. Gates already running
   * finish; gates never started are recorded skipped with an explicit reason.
   */
  failFast?: boolean
  /** Stream each gate's output as it arrives, instead of printing on completion. */
  streamOutput?: boolean
}

/**
 * Run every gate in dependency order and return the results in declaration order,
 * so a summary is stable regardless of completion order.
 */
export async function runGates(gates: readonly Gate[], options: RunGatesOptions = {}): Promise<GateResult[]> {
  const graphErrors = validateGateGraph(gates)
  if (graphErrors.length > 0) {
    throw new Error(`invalid gate graph:\n${graphErrors.map(error => `  ${error}`).join('\n')}`)
  }

  const concurrency = Math.max(1, options.concurrency ?? 4)
  const settled = new Map<string, GateResult>()
  const running = new Set<string>()
  const aborted = { value: false }

  const pending = new Map(gates.map(gate => [gate.id, gate]))
  const results: GateResult[] = []

  // A gate whose dependencies failed can never run; record that before scheduling.
  const skip = (gate: Gate, reason: string): void => {
    settled.set(gate.id, { gate, status: 'skipped', skipReason: reason, exitCode: null, durationMs: 0, output: '' })
    pending.delete(gate.id)
  }

  for (;;) {
    let progressed = false

    for (const gate of [...pending.values()]) {
      const deps = dependencies(gate)
      if (!deps.every(id => settled.has(id))) continue
      const blocked = unmetNeeds(gate, settled)
      if (blocked.length > 0) {
        skip(gate, `required gate ${blocked.join(', ')} did not pass`)
        progressed = true
        continue
      }
      if (aborted.value) {
        skip(gate, 'fail-fast: an earlier gate failed')
        progressed = true
        continue
      }
      if (running.size >= concurrency) continue

      pending.delete(gate.id)
      running.add(gate.id)
      progressed = true
      void runGate(gate).then(result => {
        running.delete(gate.id)
        settled.set(gate.id, result)
        if (options.streamOutput) process.stdout.write(result.output)
        const blocking = result.status === 'failed' && gate.allowFailure !== true
        if (blocking && options.failFast === true) aborted.value = true
        process.stdout.write(`${result.status === 'passed' ? 'PASS' : result.status === 'failed' ? 'FAIL' : 'SKIP'}  ${gate.id} (${(result.durationMs / 1000).toFixed(1)}s)\n`)
      })
    }

    if (pending.size === 0 && running.size === 0) break
    if (!progressed && running.size === 0) {
      // Defensive: settle anything still pending so the caller always gets a verdict.
      for (const gate of [...pending.values()]) skip(gate, 'unreachable: dependencies never settled')
      break
    }
    if (running.size > 0) await new Promise(resolve => setTimeout(resolve, 50))
  }

  for (const gate of gates) {
    const result = settled.get(gate.id)
    if (result !== undefined) results.push(result)
  }
  return results
}

/** Whether the run failed: any failed gate that is not explicitly allowed to fail. */
export function runFailed(results: readonly GateResult[]): boolean {
  return results.some(result => result.status === 'failed' && result.gate.allowFailure !== true)
}

/** One-line reason a gate did not pass, for the summary. */
export function formatGateReason(result: GateResult): string {
  if (result.status === 'passed') return 'passed'
  if (result.status === 'skipped') return `skipped (${result.skipReason ?? 'no reason recorded'})`
  return result.exitCode === null ? 'failed to start' : `failed with exit code ${result.exitCode}`
}

/** Print the per-gate summary and the reason for every non-passing gate. */
export function printSummary(results: readonly GateResult[]): void {
  const passed = results.filter(result => result.status === 'passed').length
  const failed = results.filter(result => result.status === 'failed').length
  const skipped = results.filter(result => result.status === 'skipped').length
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
  for (const result of results) {
    if (result.status === 'passed') continue
    console.log(`  ${result.gate.id}: ${formatGateReason(result)}`)
  }
}

// ---------------------------------------------------------------------------
// The gate table. Edit this to declare what this repository checks.
// ---------------------------------------------------------------------------

const HARNESS = 'scripts/harness'

/** Agent Note corpus rules: paths, filenames, headers, and lifecycle sections. */
const noteGates: Gate[] = [
  {
    id: 'agent-note-classification',
    label: 'Agent Note classification',
    command: 'node',
    args: [`${HARNESS}/verify-agent-note-classification.ts`],
    quick: true,
  },
  {
    id: 'agent-note-format',
    label: 'Agent Note format',
    command: 'node',
    args: [`${HARNESS}/verify-agent-note-format.ts`],
    quick: true,
  },
  {
    id: 'archived-agent-notes',
    label: 'Frozen archive seals',
    command: 'node',
    args: [`${HARNESS}/verify-archived-agent-notes.ts`],
    quick: true,
  },
]

/** Documentation rules: dead links, one-line paragraphs, word budgets. */
const docGates: Gate[] = [
  { id: 'markdown-links', label: 'Markdown links and anchors', command: 'node', args: [`${HARNESS}/verify-md-links.ts`], quick: true },
  { id: 'markdown-wrap', label: 'One paragraph per line', command: 'node', args: [`${HARNESS}/verify-md-wrap.ts`], quick: true },
  { id: 'doc-budgets', label: 'Documentation word budgets', command: 'node', args: [`${HARNESS}/verify-doc-budgets.ts`], quick: true },
]

/**
 * Named aggregates. `doc-quick` needs no build and is the fast loop; add a
 * repository-specific mode for whatever else this project must check.
 */
export const MODES: Readonly<Record<string, readonly Gate[]>> = {
  'doc-quick': [...noteGates, ...docGates],
  'agent-notes': noteGates,
}

function usage(): never {
  console.error(`usage: node run-gates.ts <mode> [--list] [--concurrency N] [--stream]
modes: ${Object.keys(MODES).join(', ')}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let mode: string | undefined
  let listOnly = false
  let concurrency: number | undefined
  let stream = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') listOnly = true
    else if (arg === '--stream') stream = true
    else if (arg === '--concurrency') {
      index += 1
      concurrency = Number(argv[index])
      if (!Number.isInteger(concurrency) || concurrency < 1) usage()
    } else if (arg !== undefined && !arg.startsWith('-') && mode === undefined) mode = arg
    else usage()
  }
  if (mode === undefined) usage()
  const gates = MODES[mode]
  if (gates === undefined) usage()

  if (listOnly) {
    for (const gate of gates) {
      const marks = [gate.quick === true ? 'quick' : '', gate.allowFailure === true ? 'allow-failure' : ''].filter(Boolean).join(',')
      console.log(`${gate.id.padEnd(28)} ${gate.command} ${gate.args.join(' ')}${marks === '' ? '' : `  [${marks}]`}`)
    }
    return
  }

  const errors = validateGateGraph(gates)
  if (errors.length > 0) {
    console.error('run-gates: invalid gate graph:')
    for (const error of errors) console.error(`  ${error}`)
    process.exit(1)
  }

  console.log(`run-gates: mode ${mode}, ${gates.length} gate(s), concurrency ${concurrency ?? 4}`)
  const results = await runGates(gates, { concurrency, failFast: true, streamOutput: stream })
  printSummary(results)

  if (!stream) {
    for (const result of results) {
      if (result.status !== 'failed') continue
      console.error(`\n--- ${result.gate.id} output ---\n${result.output}`)
    }
  }
  process.exit(runFailed(results) ? 1 : 0)
}

if (import.meta.main) void main()
