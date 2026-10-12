/**
 * Tests for the gate runner: the graph validator and the scheduler's skip semantics.
 * A gate that reports a green aggregate while a gate silently never ran is the failure
 * mode these tests exist to prevent.
 *
 * Run with: node --test skills/project-harness/scripts/run-gates.spec.ts
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  findDependencyCycle,
  formatGateReason,
  runFailed,
  runGates,
  validateGateGraph,
  type Gate,
} from './run-gates.ts'

/** A gate that exits with the given code, using the current node binary. */
function gate(id: string, exitCode: number, extra: Partial<Gate> = {}): Gate {
  return { id, label: id, command: process.execPath, args: ['-e', `process.exit(${exitCode})`], ...extra }
}

describe('gate graph validation', () => {
  test('accepts an empty graph', () => {
    assert.deepEqual(validateGateGraph([]), [])
  })

  test('accepts a linear chain', () => {
    const gates = [gate('a', 0), gate('b', 0, { needs: ['a'] }), gate('c', 0, { after: ['b'] })]
    assert.deepEqual(validateGateGraph(gates), [])
  })

  test('rejects a duplicate id', () => {
    const errors = validateGateGraph([gate('a', 0), gate('a', 0)])
    assert.equal(errors.length, 1)
    assert.match(errors[0] ?? '', /duplicate gate id "a"/)
  })

  test('rejects an unknown dependency in needs and in after', () => {
    assert.match(validateGateGraph([gate('a', 0, { needs: ['ghost'] })])[0] ?? '', /unknown dependency "ghost"/)
    assert.match(validateGateGraph([gate('a', 0, { after: ['ghost'] })])[0] ?? '', /unknown dependency "ghost"/)
  })

  test('rejects a self-dependency', () => {
    assert.match(validateGateGraph([gate('a', 0, { needs: ['a'] })])[0] ?? '', /depends on itself/)
  })

  test('rejects a two-node cycle', () => {
    const gates = [gate('a', 0, { needs: ['b'] }), gate('b', 0, { needs: ['a'] })]
    const errors = validateGateGraph(gates)
    assert.ok(errors.some(error => error.startsWith('dependency cycle:')), errors.join('\n'))
  })

  test('rejects a longer cycle spanning needs and after', () => {
    const gates = [gate('a', 0, { after: ['b'] }), gate('b', 0, { needs: ['c'] }), gate('c', 0, { after: ['a'] })]
    const errors = validateGateGraph(gates)
    assert.ok(errors.some(error => error.startsWith('dependency cycle:')), errors.join('\n'))
  })

  test('finds no cycle in a diamond', () => {
    const gates = [
      gate('root', 0),
      gate('left', 0, { needs: ['root'] }),
      gate('right', 0, { needs: ['root'] }),
      gate('join', 0, { needs: ['left', 'right'] }),
    ]
    assert.equal(findDependencyCycle(gates), undefined)
  })
})

describe('gate scheduling', () => {
  test('passes when every gate succeeds', async () => {
    const results = await runGates([gate('a', 0), gate('b', 0, { needs: ['a'] })])
    assert.deepEqual(results.map(result => result.status), ['passed', 'passed'])
    assert.equal(runFailed(results), false)
  })

  test('skips a gate whose needs failed, with an explicit reason', async () => {
    const results = await runGates([gate('a', 1), gate('b', 0, { needs: ['a'] })])
    const b = results.find(result => result.gate.id === 'b')
    assert.equal(b?.status, 'skipped')
    assert.match(b?.skipReason ?? '', /required gate a did not pass/)
    assert.match(formatGateReason(b!), /skipped \(required gate a did not pass\)/)
  })

  test('runs an after-dependent gate even when its predecessor failed', async () => {
    const results = await runGates([gate('a', 1), gate('b', 0, { after: ['a'] })])
    assert.equal(results.find(result => result.gate.id === 'b')?.status, 'passed')
    assert.equal(runFailed(results), true)
  })

  test('propagates a skip transitively', async () => {
    const results = await runGates([gate('a', 1), gate('b', 0, { needs: ['a'] }), gate('c', 0, { needs: ['b'] })])
    assert.deepEqual(results.map(result => result.status), ['failed', 'skipped', 'skipped'])
  })

  test('does not launch new gates after a blocking failure under fail-fast', async () => {
    const results = await runGates([gate('a', 1), gate('b', 0)], { failFast: true, concurrency: 1 })
    const b = results.find(result => result.gate.id === 'b')
    assert.equal(b?.status, 'skipped')
    assert.match(b?.skipReason ?? '', /fail-fast/)
  })

  test('keeps running after a failure allowed to fail', async () => {
    const results = await runGates(
      [gate('a', 1, { allowFailure: true }), gate('b', 0)],
      { failFast: true, concurrency: 1 },
    )
    assert.equal(results.find(result => result.gate.id === 'b')?.status, 'passed')
    assert.equal(runFailed(results), false)
  })

  test('an allowFailure gate that needs a failed gate is still skipped', async () => {
    const results = await runGates([gate('a', 1), gate('b', 1, { needs: ['a'], allowFailure: true })])
    assert.equal(results.find(result => result.gate.id === 'b')?.status, 'skipped')
  })

  test('returns results in declaration order regardless of completion order', async () => {
    const slow = gate('slow', 0, { args: ['-e', 'setTimeout(() => process.exit(0), 120)'] })
    const results = await runGates([slow, gate('fast', 0)], { concurrency: 4 })
    assert.deepEqual(results.map(result => result.gate.id), ['slow', 'fast'])
  })

  test('captures output from a failing gate', async () => {
    const noisy = gate('noisy', 1, { args: ['-e', 'console.error("boom"); process.exit(1)'] })
    const results = await runGates([noisy])
    assert.match(results[0]?.output ?? '', /boom/)
    assert.equal(results[0]?.exitCode, 1)
  })

  test('reports a gate whose command cannot start', async () => {
    const missing: Gate = { id: 'missing', label: 'missing', command: 'definitely-not-a-real-binary-xyz', args: [] }
    const results = await runGates([missing])
    assert.equal(results[0]?.status, 'failed')
    assert.match(formatGateReason(results[0]!), /failed to start/)
  })

  test('throws on an invalid graph before spawning anything', async () => {
    await assert.rejects(
      runGates([gate('a', 0, { needs: ['ghost'] })]),
      /invalid gate graph/,
    )
  })

  test('respects the concurrency ceiling', async () => {
    // Each gate writes a marker on start and removes it on exit; overlap would leave
    // more than one marker present at once.
    const script = `import { readdirSync, writeFileSync, rmSync } from 'node:fs'
const dir = process.env.MARKER_DIR
const file = dir + '/' + process.argv[1]
writeFileSync(file, 'x')
const overlapping = readdirSync(dir).length > 1
await new Promise(resolve => setTimeout(resolve, 60))
rmSync(file)
process.exit(overlapping ? 1 : 0)`
    const { mkdtempSync, rmSync: rm } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const markerDir = mkdtempSync(join(tmpdir(), 'harness-gates-'))
    try {
      const gates = ['a', 'b', 'c'].map((id): Gate => ({
        id, label: id, command: process.execPath, args: ['-e', script, id], env: { MARKER_DIR: markerDir },
      }))
      const results = await runGates(gates, { concurrency: 1 })
      assert.deepEqual(results.map(result => result.status), ['passed', 'passed', 'passed'])
    } finally {
      rm(markerDir, { recursive: true, force: true })
    }
  })
})
