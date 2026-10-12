/**
 * Negative-control tests for the Agent Note gates: every rule must reject a tree that
 * violates it. A gate that passes both ways guards nothing.
 *
 * Run with: node --test skills/agent-notes/scripts/gates.spec.ts
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing']
const LIFECYCLES = ['proposed', 'implemented', 'rejected']

/** Temporary repository roots created by this suite, removed on exit. */
const created: string[] = []
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

/** Create an empty repository root with the full lifecycle and archive tree. */
function makeRepo(withArchive = false, options: { pairedDocuments?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-notes-'))
  created.push(root)
  for (const lifecycle of LIFECYCLES) {
    for (const cls of CLASSES) mkdirSync(join(root, '.agents/notes', lifecycle, cls), { recursive: true })
  }
  if (withArchive) {
    for (const cls of CLASSES) mkdirSync(join(root, '.agents/notes/archived', cls), { recursive: true })
    writeFileSync(join(root, '.agents/notes/archived/AGENTS.md'), '# Archived\n')
    writeFileSync(join(root, '.agents/notes/archived/manifest.json'), '{\n  "version": 1,\n  "files": {}\n}\n')
    if (options.pairedDocuments === true) {
      writeFileSync(join(root, '.agents/notes/harness.json'), '{\n  "pairedDocuments": true\n}\n')
    }
  }
  return root
}

/** Write one Agent Note into a lifecycle/class folder. */
function writeNote(root: string, lifecycle: string, cls: string, filename: string, body: string): void {
  const abs = join(root, '.agents/notes', lifecycle, cls, filename)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body)
}

/** A conforming note body for each lifecycle. */
function validBody(lifecycle: string): string {
  const header = lifecycle === 'rejected'
    ? 'Status: rejected — superseded by a narrower decision\n'
    : `Status: ${lifecycle}\n`
  if (lifecycle === 'proposed') {
    return `# Agent Note: Sample topic\n\n${header}\n## Problem\nThe failure this solves.\n\n## Proposal\nWhat to build.\n\n## Alternatives considered\n**Do nothing.** Rejected because the failure recurs.\n\n## Acceptance criteria\nObservable state that means done.\n\n## Risks\nWhat could go wrong.\n`
  }
  if (lifecycle === 'rejected') {
    return `# Agent Note: Sample topic\n\n${header}\n## Problem\nThe failure this solves.\n\n## Proposal\nWhat was proposed.\n\n## Alternatives considered\n**Do nothing.** Rejected because the failure recurs.\n`
  }
  return `# Agent Note: Sample topic\n\n${header}\n## Problem\nThe failure this solves.\n\n## Decision\nWhat shipped, in the present tense.\n\n## Alternatives considered\n**Do nothing.** Rejected because the failure recurs.\n\n## Consequences\nWhat the trade-off cost and bought.\n`
}

/** Run one gate as a subprocess against a fixture root. */
function runGate(script: string, root: string, extra: string[] = []): { code: number | null; output: string } {
  const result = spawnSync('node', [join(SCRIPT_DIR, script), '--root', root, ...extra], { encoding: 'utf8' })
  return { code: result.status, output: `${result.stdout}${result.stderr}` }
}

/** The Git blob id of a buffer, as the consistency sidecar records it. */
function gitBlobHash(content: string): string {
  const buffer = Buffer.from(content, 'utf8')
  return createHash('sha1').update(`blob ${buffer.byteLength}\0`).update(buffer).digest('hex')
}

interface TripletOptions {
  /** Omit one side to build an incomplete artifact set. */
  omit?: 'zh' | 'sidecar'
  /** Record deliberately wrong hashes. */
  staleSidecar?: boolean
  /** Archive date to stamp on both sides. */
  archived?: string
  /** Write only the primary file, for a monolingual corpus. */
  primaryOnly?: boolean
}

/**
 * Write a complete archived artifact set. With `pairedDocuments` enabled the set is a
 * triplet (primary, counterpart, consistency sidecar); monolingual corpora archive the
 * primary file alone.
 */
function writeTriplet(root: string, cls: string, date: string, options: TripletOptions = {}): { source: string; zh: string } {
  const base = `${date}-sample`
  const archived = options.archived ?? '2026-02-01'
  const header = `# Agent Note: Sample\n\nStatus: implemented\nArchived: ${archived}\n\n## Problem\nx\n\n## Decision\ny\n\n## Alternatives considered\n**Z.** no\n\n## Consequences\ncost\n`
  const source = header
  const zh = header.replace('# Agent Note: Sample', '# Agent Note: 示例')
  const dir = join(root, '.agents/notes/archived', cls)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${base}.md`), source)
  if (options.primaryOnly === true) return { source, zh }
  if (options.omit !== 'zh') writeFileSync(join(dir, `${base}.zh.md`), zh)
  if (options.omit !== 'sidecar') {
    const primaryHash = options.staleSidecar === true ? '0'.repeat(40) : gitBlobHash(source)
    const counterpartHash = options.staleSidecar === true ? '0'.repeat(40) : gitBlobHash(zh)
    writeFileSync(join(dir, `${base}.i18n.yaml`), `# Bilingual-pair consistency record (git blob hashes).\n${base}.md: ${primaryHash}\n${base}.zh.md: ${counterpartHash}\n`)
  }
  return { source, zh }
}

describe('agent note structure gate', () => {
  test('accepts an empty tree', () => {
    const result = runGate('verify-agent-note-classification.ts', makeRepo())
    assert.equal(result.code, 0, result.output)
  })

  test('accepts a conforming note in every lifecycle', () => {
    const root = makeRepo()
    for (const lifecycle of LIFECYCLES) {
      writeNote(root, lifecycle, 'process', '2026-01-01-sample-topic.md', validBody(lifecycle))
    }
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /3 Agent Note\(s\) checked/)
  })

  test('rejects an unknown lifecycle folder', () => {
    const root = makeRepo()
    mkdirSync(join(root, '.agents/notes/ideas'), { recursive: true })
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /unknown lifecycle folder/)
  })

  test('rejects an unknown class folder', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'refactor', '2026-01-01-sample.md', validBody('implemented'))
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /unknown class folder "refactor"/)
  })

  test('rejects a filename without a leading date', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', 'sample-topic.md', validBody('implemented'))
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /filename must be yyyy-mm-dd-topic\.md/)
  })

  test('rejects a note one level too deep', () => {
    const root = makeRepo()
    const nested = join(root, '.agents/notes/implemented/process/nested/2026-01-01-sample.md')
    mkdirSync(dirname(nested), { recursive: true })
    writeFileSync(nested, validBody('implemented'))
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /expected \{lifecycle\}\/\{class\}\/file\.md/)
  })

  test('rejects a centralized index', () => {
    const root = makeRepo()
    writeFileSync(join(root, '.agents/notes/INDEX.md'), '# Index\n')
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /centralized Agent Note indexes are forbidden/)
  })

  test('rejects a note parked in the former docs/rfc home', () => {
    const root = makeRepo()
    mkdirSync(join(root, 'docs/rfc'), { recursive: true })
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /legacy-path: docs\/rfc\/ is forbidden/)
  })
})

describe('agent note format gate', () => {
  test('accepts a conforming implemented note', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', validBody('implemented'))
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 0, result.output)
  })

  test('rejects a first line that is not the Agent Note header', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', validBody('implemented').replace('# Agent Note: Sample topic', '# Sample topic'))
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /line 1 must be `# Agent Note: <title>`/)
  })

  test('rejects a status line that disagrees with the lifecycle folder', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', validBody('implemented').replace('Status: implemented', 'Status: proposed'))
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /line 3 must match the implemented status grammar/)
  })

  test('rejects a rejected note with no reason', () => {
    const root = makeRepo()
    writeNote(root, 'rejected', 'process', '2026-01-01-sample.md', validBody('rejected').replace('Status: rejected — superseded by a narrower decision', 'Status: rejected'))
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /line 3 must match the rejected status grammar/)
  })

  test('rejects a missing required section', () => {
    const root = makeRepo()
    const body = validBody('implemented').replace('## Consequences\nWhat the trade-off cost and bought.\n', '')
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /missing the required `## Consequences` section/)
  })

  test('rejects a proposal-era heading in an implemented note', () => {
    const root = makeRepo()
    const body = `${validBody('implemented')}\n## Plan\nStep one.\n`
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /is a proposal-era heading/)
  })

  test('rejects a note with no alternatives section', () => {
    const root = makeRepo()
    const body = validBody('implemented').replace(/## Alternatives considered\n[^\n]*\n/, '')
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /missing `## Alternatives considered`/)
  })

  test('rejects the grandfather comment on a note dated after the format took effect', () => {
    const root = makeRepo()
    const body = validBody('implemented')
      .replace(/## Alternatives considered\n[^\n]*\n/, '<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->\n')
    writeNote(root, 'implemented', 'process', '2026-08-01-sample.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /grandfather comment is only valid for Agent Notes dated before/)
  })

  test('accepts the grandfather comment on a pre-format note', () => {
    const root = makeRepo()
    const body = validBody('implemented')
      .replace(/## Alternatives considered\n[^\n]*\n/, '<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->\n')
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 0, result.output)
  })

  test('rejects a second Status line elsewhere in the file', () => {
    const root = makeRepo()
    const body = `${validBody('implemented')}\nStatus: implemented\n`
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /must be the only one in the file/)
  })

  test('ignores format tokens inside a fenced example', () => {
    const root = makeRepo()
    const body = `${validBody('implemented')}\n## Testing\nA note in a fence is not structure:\n\n\`\`\`markdown\n## Plan\nStatus: proposed\n\`\`\`\n`
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 0, result.output)
  })
})

describe('frozen archive gate', () => {
  test('accepts an empty sealed archive', () => {
    const root = makeRepo(true)
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 0, result.output)
  })

  test('accepts a monolingual artifact by default', () => {
    const root = makeRepo(true)
    writeTriplet(root, 'process', '2026-01-01', { primaryOnly: true })
    const sealed = runGate('verify-archived-agent-notes.ts', root, ['--write'])
    assert.equal(sealed.code, 0, sealed.output)
    assert.match(sealed.output, /sealed 1 new artifact/)
    const verified = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(verified.code, 0, verified.output)
  })

  test('rejects a counterpart when the corpus is monolingual', () => {
    const root = makeRepo(true)
    writeTriplet(root, 'process', '2026-01-01')
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /configured monolingual/)
  })

  test('rejects an incomplete triplet when pairs are required', () => {
    const root = makeRepo(true, { pairedDocuments: true })
    writeTriplet(root, 'process', '2026-01-01', { omit: 'zh' })
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /incomplete archived triplet/)
  })

  test('rejects an archive missing a required kind directory', () => {
    const root = makeRepo(true)
    rmSync(join(root, '.agents/notes/archived/testing'), { recursive: true })
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /required kind directory is missing/)
  })

  test('rejects a note with no primary file', () => {
    const root = makeRepo(true, { pairedDocuments: true })
    writeTriplet(root, 'process', '2026-01-01', { omit: 'zh' })
    // Remove the primary too, leaving only the sidecar.
    rmSync(join(root, '.agents/notes/archived/process/2026-01-01-sample.md'))
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /archived note has no primary file/)
  })

  test('rejects a seal whose content hash changed', () => {
    const root = makeRepo(true)
    const triplet = writeTriplet(root, 'process', '2026-01-01', { primaryOnly: true })
    const sealed = runGate('verify-archived-agent-notes.ts', root, ['--write'])
    assert.equal(sealed.code, 0, sealed.output)
    assert.match(sealed.output, /sealed 1 new artifact/)
    // Editing a sealed artifact must fail even when writing, because the seal is
    // append-only: the manifest is never allowed to absorb the change.
    writeFileSync(join(root, '.agents/notes/archived/process/2026-01-01-sample.md'), `${triplet.source}\nrewritten after sealing\n`)
    const result = runGate('verify-archived-agent-notes.ts', root, ['--write'])
    assert.equal(result.code, 1)
    assert.match(result.output, /sealed content hash changed/)
  })

  test('rejects a triplet whose sidecar hashes are stale', () => {
    const root = makeRepo(true, { pairedDocuments: true })
    writeTriplet(root, 'process', '2026-01-01', { staleSidecar: true })
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /consistency record must contain the current Git blob hashes/)
  })

  test('rejects an archive date earlier than the note filename', () => {
    const root = makeRepo(true)
    writeTriplet(root, 'process', '2026-05-01', { archived: '2026-01-01', primaryOnly: true })
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /archive date 2026-01-01 predates the note filename/)
  })

  test('rejects an unsealed artifact in verify mode', () => {
    const root = makeRepo(true)
    writeTriplet(root, 'process', '2026-01-01', { primaryOnly: true })
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /archived artifact is not sealed in manifest\.json/)
  })

  test('rejects a missing archived AGENTS.md', () => {
    const root = makeRepo(true)
    rmSync(join(root, '.agents/notes/archived/AGENTS.md'))
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /archived\/AGENTS\.md is required/)
  })

  test('rejects an unexpected file at the archive root', () => {
    const root = makeRepo(true)
    writeFileSync(join(root, '.agents/notes/archived/stray.md'), 'x\n')
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /unexpected root file/)
  })

  test('rejects a manifest outside its closed schema', () => {
    const root = makeRepo(true)
    writeFileSync(join(root, '.agents/notes/archived/manifest.json'), '{"version":1,"files":{},"extra":true}\n')
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /expected exactly the fields/)
  })

  test('rejects an invalid pairedDocuments value', () => {
    const root = makeRepo(true)
    writeFileSync(join(root, '.agents/notes/harness.json'), '{"pairedDocuments":"yes"}\n')
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /must be a boolean/)
  })

  test('ignores dotfiles that keep empty kind directories', () => {
    const root = makeRepo(true)
    for (const cls of CLASSES) writeFileSync(join(root, '.agents/notes/archived', cls, '.gitkeep'), '')
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 0, result.output)
  })
})

describe('repository root resolution', () => {
  test('a gate run from a subdirectory finds the same tree', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', validBody('implemented'))
    const deep = join(root, 'apps/web/src')
    mkdirSync(deep, { recursive: true })
    const result = spawnSync('node', [join(SCRIPT_DIR, 'verify-agent-note-format.ts')], { cwd: deep, encoding: 'utf8' })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /1 Agent Note\(s\) checked/)
  })

  test('an unknown --root path fails loudly', () => {
    const result = runGate('verify-agent-note-format.ts', resolve(SCRIPT_DIR, 'does-not-exist'))
    assert.equal(result.code, 1)
    assert.match(result.output, /is not a directory/)
  })
})
