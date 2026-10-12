/**
 * Resolve the repository a gate validates. Gates run from `cwd` so they work from
 * any subdirectory; `--root <path>` overrides for tests, CI, and cross-repository runs.
 *
 * This file is byte-identical in every bundled skill so the installer can copy it once.
 */

import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** A directory carrying any of these marks is a repository root. */
const ROOT_MARKERS = ['.git', '.agents/notes'] as const

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Walk up from `start` to the nearest directory marked as a repository root, falling
 * back to `start` itself when no ancestor is marked (a fresh tree before bootstrap).
 */
export function findRepoRoot(start: string = process.cwd()): string {
  const origin = resolve(start)
  let current = origin
  for (;;) {
    for (const marker of ROOT_MARKERS) {
      if (existsSync(resolve(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return origin
    current = parent
  }
}

/**
 * Read `--root <path>` from argv. Returns undefined when absent, so callers can fall
 * back to discovery.
 */
export function parseRootArgument(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--root')
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('-')) {
    throw new Error('--root requires a directory path')
  }
  return resolve(value)
}

/** Resolve the validated repository root: `--root` wins, otherwise discovery from cwd. */
export function resolveRepoRoot(argv: readonly string[] = process.argv.slice(2)): string {
  const explicit = parseRootArgument(argv)
  if (explicit === undefined) return findRepoRoot()
  if (!isDirectory(explicit)) throw new Error(`--root ${JSON.stringify(explicit)} is not a directory`)
  return explicit
}
