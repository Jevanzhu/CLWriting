/**
 * books.jsonl 登记 + 活动书 + resolveBookRoot —— 依据 M5 #32。
 *
 * M0–M4 既有命令从「单书 cwd」走向「工作目录多书」的核心接缝：
 * - resolveBookRoot 是所有写章/状态命令解析「当前对哪本书」的统一入口（#32 第 4 节）
 * - books.jsonl 登记有哪些书；.clwriting/active 指当前哪本（指针，换书只改它）
 *
 * 解析链优先级（#32 第 4 节）：
 *   1. 显式 [书目录] 参数（最高，覆盖一切；保留既有用法）
 *   2. cwd 是书仓库（有 book.yaml + .git）→ cwd（兼容书仓库内直接跑）
 *   3. .clwriting/active → 读活动书 → 查 books.jsonl 取 path → 工作目录/path
 *   4. 都不是 → 人话报错「还没选书，先 clwriting use <书> 或 init」
 */

import process from 'node:process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { readBookConfig } from '../format/yaml.js'
import { atomicWriteFile } from '../fs/atomic.js'
import { git } from '../git/exec.js'
import type { LeadType } from '../format/types.js'

// ── books.jsonl 登记格式（#32 第 2 节）──────────────

export interface BookEntry {
  name: string
  /** 书仓库目录，相对工作目录（移动检测用） */
  path: string
  kind: 'long' | 'short'
  created_at?: string
  /** 未知字段容错保留 */
  [key: string]: unknown
}

const BOOKS_FILE = '.clwriting/books.jsonl'
const ACTIVE_FILE = '.clwriting/active'
const CLWRITING_DIR = '.clwriting'

/** 读 books.jsonl（容错：缺文件返回空；坏行跳过不崩）。 */
export function readBooks(workDir: string): BookEntry[] {
  const fp = join(workDir, BOOKS_FILE)
  if (!existsSync(fp)) return []
  const books: BookEntry[] = []
  const lines = readFileSync(fp, 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof obj['name'] === 'string' && typeof obj['path'] === 'string') {
        const entry = {
          ...obj,
          name: obj['name'],
          path: obj['path'],
          kind: obj['kind'] === 'short' ? 'short' : 'long',
        } as BookEntry
        if (typeof obj['created_at'] === 'string') {
          entry.created_at = obj['created_at']
        } else {
          delete entry.created_at
        }
        books.push(entry)
      }
    } catch {
      // 坏行跳过（容错，不崩）
    }
  }
  return books
}

/** 全量写 books.jsonl（一行一书）。 */
export function writeBooks(workDir: string, books: BookEntry[]): void {
  mkdirSync(join(workDir, CLWRITING_DIR), { recursive: true })
  const fp = join(workDir, BOOKS_FILE)
  const lines = books.map((b) => JSON.stringify(b)).join('\n')
  atomicWriteFile(fp, lines + (lines ? '\n' : ''))
}

/** 追加一本书到 books.jsonl（不改 active）。同名已存在则报冲突。 */
export function appendBook(
  workDir: string,
  entry: BookEntry,
): { ok: true } | { ok: false; reason: string } {
  const books = readBooks(workDir)
  if (books.some((b) => b.name === entry.name)) {
    return { ok: false, reason: `已有一本叫「${entry.name}」的书，换个名字或先删掉旧的` }
  }
  books.push(entry)
  writeBooks(workDir, books)
  return { ok: true }
}

// ── 活动书指针（#32 第 3 节）──────────────────────

/** 读活动书 name（.clwriting/active 单行）。缺失返回 null。 */
export function readActive(workDir: string): string | null {
  const fp = join(workDir, ACTIVE_FILE)
  if (!existsSync(fp)) return null
  const name = readFileSync(fp, 'utf-8').trim()
  return name === '' ? null : name
}

/** 写活动书 name（单文件，换书只改它）。 */
export function writeActive(workDir: string, name: string): void {
  mkdirSync(join(workDir, CLWRITING_DIR), { recursive: true })
  writeFileSync(join(workDir, ACTIVE_FILE), name + '\n', 'utf-8')
}

// ── 工作目录定位（向上找 .clwriting/）──────────────

/**
 * 向上查找最近的含 .clwriting/ 的目录（工作目录定位）。
 * 找不到返回 null（当前在书仓库内或裸目录）。
 */
export function findWorkDir(startDir: string): string | null {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, CLWRITING_DIR)) && statSync(join(dir, CLWRITING_DIR)).isDirectory()) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return null // 到根了
    dir = parent
  }
}

// ── 书仓库判定 ────────────────────────────────────

/** cwd 是书仓库：有 book.yaml 且有 .git（区别于工作目录——工作目录无 book.yaml、非 git）。 */
export function isBookRepo(dir: string): boolean {
  return existsSync(join(dir, 'book.yaml')) && existsSync(join(dir, '.git'))
}

// ── resolveBookRoot 解析链（#32 第 4 节，统一入口）──

export type ResolveResult = { ok: true; bookRoot: string } | { ok: false; reason: string }

/**
 * 解析「当前对哪本书操作」——所有写章/状态命令的统一入口。
 *
 * 优先级：
 * 1. 显式 [书目录] 参数（args 里非 -- 开头、非 .md 结尾的位置参）→ resolve
   * 2. cwd 是书仓库 → cwd
   * 3. .clwriting/active → 读活动书 → 查 books.jsonl 取 path → 工作目录/path
 * 4. 都不是 → 人话报错
 *
 * @param args 命令的原始参数（如 process.argv.slice(3)）
 * @param explicitBookRoot 显式书目录（调用方已从位置参识别出的书目录，优先级最高）。
 *        check/finalize 等有草稿位置参的命令应先识别出书目录再传入，避免 .md 误判。
 */
export function resolveBookRoot(
  args?: readonly string[],
  explicitBookRoot?: string,
): ResolveResult {
  // 1. 显式书目录（调用方识别或位置参直接是目录）
  if (explicitBookRoot) {
    return { ok: true, bookRoot: resolve(explicitBookRoot) }
  }
  if (args) {
    const positionalBook = findPositionalBookRoot(args)
    if (positionalBook) return { ok: true, bookRoot: resolve(positionalBook) }
  }

  const cwd = process.cwd()

  // 2. cwd 是书仓库：在书仓库内直接跑命令时不受 active 影响。
  if (isBookRepo(cwd)) {
    return { ok: true, bookRoot: cwd }
  }

  // 3. 活动书（经工作目录定位）
  const workDir = findWorkDir(cwd)
  if (workDir) {
    const activeName = readActive(workDir)
    if (activeName) {
      const books = readBooks(workDir)
      const entry = books.find((b) => b.name === activeName)
      if (entry) {
        const bookPath = join(workDir, entry.path)
        if (existsSync(bookPath)) return { ok: true, bookRoot: bookPath }
        // 活动书指向失效（目录移动/删除）→ 落到第 4 档
      }
    }
  }

  // 4. 都不是
  return {
    ok: false,
    reason: '还没选书。先 clwriting use <书名> 选一本，或者在工作目录里 clwriting init 建一本。',
  }
}

/** 从位置参里找书目录候选（非 -- 开头、非 .md 结尾）。 */
function findPositionalBookRoot(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith('--')) continue
    if (/^\d+$/.test(arg)) continue // 章号/篇号/批量数量等数字位置参，不是书目录
    if (arg.endsWith('.md')) continue // 草稿文件，不是书目录
    return arg
  }
  return undefined
}

/**
 * 便捷：给只有简单 `args[0] ? resolve : cwd` 形态的命令用（enter/health/session-start 等
 * 无草稿位置参的命令）。等价于 resolveBookRoot(args)。
 */
export function resolveBookRootFromArgs(args: readonly string[]): ResolveResult {
  return resolveBookRoot(args)
}

// ── 自愈（#32 第 6 节，文件即真相 + 不报错拒绝）──

export interface RepairResult {
  /** 重建的登记条目 */
  rebuilt: BookEntry[]
  /** 原登记中 path 在磁盘找不到的书（可能被移动/改名） */
  missing: BookEntry[]
  /** 已按 book.yaml 书名重新关联的移动/改名书目录 */
  relinked: { name: string; from: string; to: string }[]
  /** 是否有变动（重建了或发现缺失） */
  changed: boolean
}

/**
 * 自愈 books.jsonl（#32 第 6 节）。
 * - 缺失/损坏 → 扫描工作目录直接子目录（有 book.yaml + .git）→ 重建登记
 * - 已有登记：检查 path 是否在磁盘存在，不存在的标 missing（提示重关联）
 *
 * 真源是磁盘上的书仓库本身；books.jsonl 是「可从扫描重建的派生登记」（类比 .cache）。
 */
export function repairBooks(workDir: string): RepairResult {
  const existing = readBooks(workDir)
  const rebuilt: BookEntry[] = existing.map((b) => ({ ...b }))
  const relinked: { name: string; from: string; to: string }[] = []
  let updated = false

  // 扫描工作目录直接子目录（不递归深扫，避免误纳嵌套/无关目录）
  const scanned: BookEntry[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(workDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
  } catch {
    entries = []
  }

  for (const name of entries) {
    const dir = join(workDir, name)
    if (!isBookRepo(dir)) continue
    const bookName = detectBookName(dir, name)
    const kind = detectBookKind(dir)
    const createdAt = detectBookCreatedAt(dir)

    const existingPathIndex = rebuilt.findIndex((b) => b.path === name)
    if (existingPathIndex >= 0) {
      const entry = rebuilt[existingPathIndex]!
      const nextEntry = {
        ...entry,
        name: bookName,
        kind,
        ...(entry.created_at || !createdAt ? {} : { created_at: createdAt }),
      }
      if (entry.name !== nextEntry.name || entry.kind !== nextEntry.kind || entry.created_at !== nextEntry.created_at) {
        rebuilt[existingPathIndex] = nextEntry
        updated = true
      }
      continue
    }

    const existingIndex = rebuilt.findIndex((b) => b.name === bookName)
    if (existingIndex >= 0) {
      const entry = rebuilt[existingIndex]!
      const oldPath = entry.path
      if (oldPath !== name && !existsSync(join(workDir, oldPath))) {
        rebuilt[existingIndex] = {
          ...entry,
          path: name,
          kind,
          ...(entry.created_at || !createdAt ? {} : { created_at: createdAt }),
        }
        relinked.push({ name: bookName, from: oldPath, to: name })
      }
      continue
    }

    scanned.push({
      name: bookName,
      path: name,
      kind,
      ...(createdAt ? { created_at: createdAt } : {}),
    })
  }

  rebuilt.push(...scanned)

  // 只剩无法重关联的缺失登记进入 missing；已重关联的用 relinked 报告。
  const missing = rebuilt.filter((b) => !existsSync(join(workDir, b.path)))
  const changed = updated || scanned.length > 0 || relinked.length > 0 || missing.length > 0

  if (changed) {
    writeBooks(workDir, rebuilt)
  }

  return { rebuilt, missing, relinked, changed }
}

/** 从 book.yaml 读书名；无书名时回落目录名。 */
function detectBookName(dir: string, fallback: string): string {
  try {
    const title = readBookConfig(join(dir, 'book.yaml')).config.book.title.trim()
    if (title) return title
  } catch {
    // 读失败回落目录名
  }
  return fallback
}

/** 从 book.yaml 读 kind（缺省 long）。 */
function detectBookKind(dir: string): 'long' | 'short' {
  try {
    const text = readFileSync(join(dir, 'book.yaml'), 'utf-8')
    if (/kind:\s*short/.test(text)) return 'short'
  } catch {
    // 读失败当 long
  }
  return 'long'
}

/** 从 git 首 commit 时间兜底 created_at（无则 undefined）。 */
function detectBookCreatedAt(dir: string): string | undefined {
  try {
    const r = execGit(['log', '--reverse', '--format=%aI', '--max-count=1'], dir)
    if (r) return r
  } catch {
    // 无 git 历史忽略
  }
  return undefined
}

function execGit(args: string[], cwd: string): string | null {
  const r = git(args, cwd)
  return r.ok ? r.stdout.trim() || null : null
}
