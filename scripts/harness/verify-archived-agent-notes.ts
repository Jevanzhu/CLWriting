/** Verify and append-seal the frozen Agent Note archive. */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AGENT_NOTE_CLASSES, agentNoteRoot } from './agent-note-tree.ts'
import { readHarnessConfig } from './harness-config.ts'
import { resolveRepoRoot } from './harness-root.ts'
import {
  extendArchiveManifest,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
  type ArchiveManifest,
} from './archived-agent-notes.ts'

const USAGE = 'usage: node verify-archived-agent-notes.ts [--write] [--root <path>]'

let writeMode = false
for (let index = 0; index < process.argv.length - 2; index += 1) {
  const arg = process.argv[index + 2]
  if (arg === '--write') {
    writeMode = true
    continue
  }
  if (arg === '--root') {
    index += 1
    continue
  }
  console.error(`verify-archived-agent-notes: ${USAGE}`)
  process.exit(1)
}

let repoRoot: string
try {
  repoRoot = resolveRepoRoot()
} catch (error: unknown) {
  console.error(`verify-archived-agent-notes: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const notesRoot = agentNoteRoot(repoRoot)
const archiveRoot = resolve(notesRoot, 'archived')
const manifestPath = resolve(archiveRoot, 'manifest.json')
const manifestRepoPath = '.agents/notes/archived/manifest.json'
const errors: string[] = []
const allowedRootFiles = new Set(['AGENTS.md', 'manifest.json', 'harness.json'])
const kinds = new Set<string>()
const artifacts = new Map<string, Buffer>()

const harness = readHarnessConfig(notesRoot)
errors.push(...harness.errors)

if (!existsSync(archiveRoot)) {
  console.error('verify-archived-agent-notes: no .agents/notes/archived/ tree found; create it with the harness bootstrap script.')
  process.exit(1)
}

if (!existsSync(resolve(archiveRoot, 'AGENTS.md'))) errors.push('archived/AGENTS.md is required')
for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
  if (entry.isFile()) {
    if (!allowedRootFiles.has(entry.name)) errors.push(`archived/${entry.name}: unexpected root file`)
    continue
  }
  if (!entry.isDirectory()) {
    errors.push(`archived/${entry.name}: only regular files and kind directories are allowed`)
    continue
  }
  if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(entry.name)) {
    errors.push(`archived/${entry.name}/: unknown Agent Note kind`)
    continue
  }
  kinds.add(entry.name)
  for (const child of readdirSync(resolve(archiveRoot, entry.name), { withFileTypes: true })) {
    // Dotfiles keep otherwise-empty kind directories in version control; they are
    // not archived artifacts and carry no seal.
    if (child.name.startsWith('.')) continue
    const rel = `${entry.name}/${child.name}`
    if (!child.isFile()) {
      errors.push(`${rel}: archived kind directories contain regular files only`)
      continue
    }
    artifacts.set(rel, readFileSync(resolve(archiveRoot, rel)))
  }
}
for (const kind of AGENT_NOTE_CLASSES) {
  if (!kinds.has(kind)) errors.push(`archived/${kind}/: required kind directory is missing`)
}
errors.push(...validateArchiveArtifacts(artifacts, harness.config))

function runGit(gitArgs: string[]): string {
  const result = spawnSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git exited with status ${result.status}`)
  return result.stdout
}

/** Whether this repository root is under Git version control at all. */
function isGitRepository(): boolean {
  try {
    runGit(['rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

type BaselineResult = { manifest: ArchiveManifest; warning?: string }

/**
 * Read the sealed manifest as of `ref`. An unborn HEAD in a fresh repository is an
 * empty baseline: there is nothing to have tampered with yet. A ref that cannot be
 * resolved when CI supplied it explicitly is an error, because a shallow checkout
 * must not silently skip the comparison.
 */
function readBaselineManifest(ref: string, explicit: boolean): BaselineResult {
  try {
    runGit(['cat-file', '-e', `${ref}^{commit}`])
  } catch (error: unknown) {
    if (explicit) throw error
    return { manifest: { version: 1, files: {} }, warning: `no committed baseline at ${JSON.stringify(ref)} yet; comparing against the working manifest only` }
  }
  const manifestEntry = runGit(['ls-tree', '--name-only', ref, '--', manifestRepoPath]).trim()
  if (manifestEntry === '') return { manifest: { version: 1, files: {} } }
  return { manifest: parseArchiveManifest(runGit(['show', `${ref}:${manifestRepoPath}`])) }
}

let manifest: ArchiveManifest = { version: 1, files: {} }
if (existsSync(manifestPath)) {
  try {
    manifest = parseArchiveManifest(readFileSync(manifestPath, 'utf8'))
  } catch (error: unknown) {
    errors.push(`archived/manifest.json: ${error instanceof Error ? error.message : String(error)}`)
  }
} else if (!writeMode) {
  errors.push('archived/manifest.json is required; seal new artifacts with `node verify-archived-agent-notes.ts --write`')
}

// CI supplies its trusted pre-change commit; local writes compare with committed HEAD.
const configuredRef = process.env.HARNESS_ARCHIVE_BASE_REF
const baselineRef = configuredRef ?? 'HEAD'
if (!isGitRepository()) {
  console.warn(`verify-archived-agent-notes: ${JSON.stringify(repoRoot)} is not a Git repository; seals are checked against the working manifest only.`)
} else {
  try {
    const { manifest: baseline, warning } = readBaselineManifest(baselineRef, configuredRef !== undefined)
    if (warning !== undefined) console.warn(`verify-archived-agent-notes: ${warning}`)
    errors.push(...validateArchiveManifestExtension(baseline, manifest))
  } catch (error: unknown) {
    errors.push(`archived/manifest.json: cannot read baseline ${JSON.stringify(baselineRef)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const extended = extendArchiveManifest(manifest, artifacts)
errors.push(...extended.errors)
if (!writeMode) {
  for (const path of extended.added) errors.push(`${path}: archived artifact is not sealed in manifest.json`)
}

if (errors.length > 0) {
  console.error('verify-archived-agent-notes: archive rules violated:')
  for (const error of errors) console.error(`  ${error}`)
  process.exit(1)
}

if (writeMode) {
  const rendered = renderArchiveManifest(extended.files)
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== rendered) {
    writeFileSync(manifestPath, rendered)
  }
  console.log(`verify-archived-agent-notes: sealed ${extended.added.length} new artifact(s); existing seals unchanged.`)
} else {
  console.log(`verify-archived-agent-notes: ${artifacts.size} frozen artifact(s) checked across ${kinds.size} kind(s).`)
}
