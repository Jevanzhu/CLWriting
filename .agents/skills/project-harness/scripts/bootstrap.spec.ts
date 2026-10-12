/**
 * Tests for `bootstrap.ts`. The two failure modes covered here both produced a
 * repository that looked installed but could not run a single gate:
 *
 *   - a verifier left out of the copy list, so the copied gate dies on import
 *   - the paired skill missing, so the Agent Note gates cannot start at all
 *
 * Run with: node --test skills/project-harness/scripts/bootstrap.spec.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const BOOTSTRAP = join(SCRIPT_DIR, 'bootstrap.ts')
const SKILL_ROOT = resolve(SCRIPT_DIR, '..')

/** A fresh git-less directory to bootstrap into. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'harness-bootstrap-'))
}

const roots: string[] = []
function tracked(): string {
  const root = scratch()
  roots.push(root)
  return root
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('bootstrapping a fresh repository', () => {
  let target: string
  let result: ReturnType<typeof spawnSync>

  before(() => {
    target = tracked()
    result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target], { encoding: 'utf8' })
  })

  test('succeeds and reports what it created', () => {
    assert.equal(result.status, 0, String(result.stderr))
    assert.match(result.stdout ?? '', /harness bootstrap: \d+ path\(s\) created/)
  })

  test('copies every verifier the gate list runs', () => {
    // Each entry names a file the copied run-gates.ts spawns or a verifier imports.
    for (const file of [
      'harness-root.ts',
      'markdown.ts',
      'baseline.ts',
      'agent-note-tree.ts',
      'archived-agent-notes.ts',
      'verify-agent-note-format.ts',
      'verify-agent-note-classification.ts',
      'verify-archived-agent-notes.ts',
      'verify-doc-budgets.ts',
      'verify-md-links.ts',
      'verify-md-wrap.ts',
      'run-gates.ts',
    ]) {
      assert.ok(existsSync(join(target, 'scripts/harness', file)), `${file} was not copied`)
    }
  })

  test('every copied gate actually starts', () => {
    const run = spawnSync(process.execPath, [join(target, 'scripts/harness/run-gates.ts'), 'doc-quick'], {
      cwd: target,
      encoding: 'utf8',
    })
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
    // A missing import surfaces as MODULE_NOT_FOUND; the gates must get far enough
    // to report their own verdicts instead.
    assert.doesNotMatch(out, /MODULE_NOT_FOUND|Cannot find module/)
    assert.match(out, /6 passed, 0 failed, 0 skipped/, out)
  })

  test('creates the Agent Note lifecycle and archive trees the gates require', () => {
    for (const lifecycle of ['proposed', 'implemented', 'rejected']) {
      for (const cls of ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing']) {
        assert.ok(existsSync(join(target, '.agents/notes', lifecycle, cls)), `${lifecycle}/${cls} missing`)
        assert.ok(existsSync(join(target, '.agents/notes/archived', cls)), `archived/${cls} missing`)
      }
    }
  })

  test('declares the corpus monolingual, since no counterpart files exist', () => {
    assert.deepEqual(JSON.parse(readFileSync(join(target, '.agents/notes/harness.json'), 'utf8')), {
      pairedDocuments: false,
    })
  })

  test('measures the standing docs that already existed, not the templates it just wrote', () => {
    // Budgets are seeded before templates are copied, so a freshly copied skeleton
    // cannot set a ceiling the first real paragraph blows through. The manifest is
    // therefore empty here, and says how to seed it.
    const manifest = JSON.parse(readFileSync(join(target, 'scripts/harness/doc-budgets.manifest.json'), 'utf8'))
    assert.deepEqual(manifest, {})
    assert.match(result.stdout ?? '', /no standing documents to measure yet/)
    assert.match(result.stdout ?? '', /re-run bootstrap to seed their ceilings/)
  })

  test('writes no ledger, because it had no violations to record', () => {
    assert.equal(existsSync(join(target, 'scripts/harness/baseline.json')), false)
  })

  test('is idempotent: a second run preserves the files the first run wrote', () => {
    const agents = readFileSync(join(target, 'AGENTS.md'), 'utf8')
    writeFileSync(join(target, 'AGENTS.md'), `${agents}\n<!-- local edit -->\n`)
    const again = spawnSync(process.execPath, [BOOTSTRAP, '--target', target], { encoding: 'utf8' })
    assert.equal(again.status, 0, String(again.stderr))
    assert.match(again.stdout ?? '', /preserved \d+ existing path/)
    assert.match(readFileSync(join(target, 'AGENTS.md'), 'utf8'), /<!-- local edit -->/)
  })
})

describe('adopting a repository that already has violations', () => {
  let target: string
  let result: ReturnType<typeof spawnSync>

  before(() => {
    target = tracked()
    mkdirSync(join(target, 'docs'), { recursive: true })
    writeFileSync(join(target, 'README.md'), '# Existing\n\nSee [gone](docs/GONE.md).\n\nA wrapped\nparagraph.\n')
    result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, '--adopt'], { encoding: 'utf8' })
  })

  test('records the pre-existing debt and says so', () => {
    assert.equal(result.status, 0, String(result.stderr))
    assert.match(result.stdout ?? '', /adopted: markdown-links: recorded 1 existing violation/)
    assert.match(result.stdout ?? '', /adopted: markdown-wrap: recorded 1 existing violation/)
  })

  test('the gates pass on history alone', () => {
    const run = spawnSync(process.execPath, [join(target, 'scripts/harness/run-gates.ts'), 'doc-quick'], {
      cwd: target,
      encoding: 'utf8',
    })
    assert.match(`${run.stdout ?? ''}${run.stderr ?? ''}`, /6 passed, 0 failed, 0 skipped/)
  })

  test('but a newly broken link still fails', () => {
    writeFileSync(join(target, 'docs', 'new.md'), '# New\n\n[broken](nope.md)\n')
    const run = spawnSync(process.execPath, [join(target, 'scripts/harness/run-gates.ts'), 'doc-quick'], {
      cwd: target,
      encoding: 'utf8',
    })
    assert.equal(run.status, 1)
    assert.match(`${run.stdout ?? ''}${run.stderr ?? ''}`, /docs\/new\.md:3/)
  })
})

describe('a partial installation', () => {
  test('refuses to bootstrap when the paired agent-notes skill is absent', () => {
    // Reproduce a lone `project-harness` copy: both skills ship together, so this is
    // the shape a manual partial install takes.
    const isolated = tracked()
    cpSync(SKILL_ROOT, join(isolated, 'project-harness'), { recursive: true })
    const target = tracked()
    const run = spawnSync(process.execPath, [join(isolated, 'project-harness/scripts/bootstrap.ts'), '--target', target], {
      encoding: 'utf8',
    })
    assert.equal(run.status, 1)
    // The guard's own message, start to finish. Asserting only the first line let a
    // template-literal syntax error in the closing lines masquerade as this refusal.
    assert.match(run.stderr ?? '', /missing the paired `agent-notes` skill/)
    assert.match(run.stderr ?? '', /verify-agent-note-format\.ts not found/)
    assert.match(run.stderr ?? '', /copy both directories side by side/)
    assert.doesNotMatch(run.stderr ?? '', /ReferenceError|is not defined|SyntaxError/)
    // It must refuse before creating anything, not after.
    assert.equal(existsSync(join(target, 'scripts/harness/run-gates.ts')), false)
  })
})
