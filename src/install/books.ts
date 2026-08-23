/**
 * books.jsonl 登记 + 活动书 + resolveBookRoot —— 依据 M5 #32。
 *
 * M0–M4 既有命令从「单书 cwd」走向「工作目录多书」的核心接缝：
 * - resolveBookRoot 是所有写章/状态命令解析「当前对哪本书」的统一入口（#32 第 4 节）
 * - books.jsonl 登记有哪些书；.clwriting/active 指当前哪本（指针，换书只改它）
 *
 * 解析链优先级（#32 第 4 节）：
 *   1. 显式 [书目录] 参数（最高，覆盖一切；保留既有用法）
 *   2. cwd 是书仓库（有 book.yaml）→ cwd（兼容书仓库内直接跑）
 *   3. .clwriting/active → 读活动书 → 查 books.jsonl 取 path → 工作目录/path
 *   4. 都不是 → 人话报错「还没选书，请在书库入口启用或新建一本」
 */

import process from 'node:process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, dirname, basename, isAbsolute } from 'node:path'
import { readBookConfig } from '../format/yaml.js'
import { atomicWriteFile } from '../fs/atomic.js'

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
const KIND_DIRS = {
  long: '长篇',
  short: '短篇',
} as const

/** 书库二级目录名：一级书库 / 二级长短篇 / 三级具体书。 */
export function bookKindDir(kind: 'long' | 'short'): string {
  return KIND_DIRS[kind]
}

/** 新建书默认登记路径（相对工作目录）。旧 books.jsonl 平铺 path 仍兼容读取。 */
export function bookStoragePath(bookName: string, kind: 'long' | 'short'): string {
  return `${bookKindDir(kind)}/${bookName}`
}

/**
 * 书名合法性（P2-27：跨 server 建书 + doInit 逻辑层共用单一真相源）。
 * 书名直接用作目录名——禁空、NUL、路径分隔符、特殊路径段（. / ..），
 * 防 `../` 经 join 后越出 workDir（此前防线只在 server 层，逻辑层新调用方会重踩）。
 */
export function isInvalidBookName(name: string): boolean {
  if (name === '' || name.includes('\0') || /[\\/]/.test(name) || name === '.' || name === '..') return true
  // Z-22（第五十八轮）：Windows 保留设备名（CON/NUL/COM1-9/LPT1-9 等）——win 上
  // mkdir 对这些名字直接失败，提前以人话校验拒绝（mac 不受影响，为阶段 21 预铺）；
  // 尾点/尾空格同拒（win 落盘时被剥引发读写名不一致）
  const bare = name.replace(/\.+$/, '').replace(/\s+$/, '').toUpperCase()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(bare)) return true
  return /[.\s]$/.test(name)
}

/** 读 books.jsonl。写路径专用口径：缺文件 → 空表（新建合法）；读失败（EACCES/
 *  EISDIR 等）→ null——DA-3（第七轮）：写方据此拒绝重写，防「降级空表 × 后续整写」
 *  把其余登记清掉（EACCES 挡 readFileSync 不挡 atomicWriteFile 的 tmp+rename）。
 *  读路径容错请用 readBooks（失败降级空表，书架/resolveBook 不裸抛）。 */
export function readBooksStrict(workDir: string): BookEntry[] | null {
  const fp = join(workDir, BOOKS_FILE)
  if (!existsSync(fp)) return []
  let text: string
  try {
    text = readFileSync(fp, 'utf-8')
  } catch {
    return null
  }
  const books: BookEntry[] = []
  const lines = text.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof obj['name'] === 'string' && typeof obj['path'] === 'string') {
        // 路径安全：拒绝对路径与父级穿越段（防 books.jsonl 篡改后 join(workDir,path) 越出 workDir，
        // DELETE 端点 rmSync recursive 可递归删除外部目录 —— NP0-B）
        const relPath = obj['path']
        // P2-SEC-2：补 NUL 字节检查（与 safeManifestPath 一致——NUL 可截断后续路径拼接）
        if (!relPath || relPath.includes('\0') || isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) continue
        // P1-2：拒绝 "." / "" / "./" 等 resolve 后指向 workDir 自身的路径
        // （join(workDir,".")=workDir → DELETE rmSync recursive 删整个书库）
        if (resolve(workDir, relPath) === resolve(workDir)) continue
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

/** 读 books.jsonl（容错：缺文件/读失败均返回空；坏行跳过不崩——读路径降级口径）。 */
export function readBooks(workDir: string): BookEntry[] {
  return readBooksStrict(workDir) ?? []
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
  // DA-3（第七轮）：读失败（null）拒绝重写——降级空表会让 writeBooks 只写进新书一行，
  // 其余登记全被清掉（repairBooks 扫盘可重建兜底，但期间书架丢书）
  const books = readBooksStrict(workDir)
  if (books === null) {
    return { ok: false, reason: 'books.jsonl 读取失败（权限或磁盘故障），已拒绝改写以防清空书库登记——请修复后重试' }
  }
  if (books.some((b) => b.name === entry.name)) {
    return { ok: false, reason: `已有一本叫「${entry.name}」的书，换个名字或先删掉旧的` }
  }
  books.push(entry)
  writeBooks(workDir, books)
  return { ok: true }
}

/**
 * 从 books.jsonl 移除一本书的登记（不改文件系统）。
 * 如果删的是活动书，清 active 指针（防野指针）。找不到则 no-op。
 */
export function removeBookEntry(workDir: string, name: string): void {
  // DA-3（第七轮）：读失败拒绝重写——降级空表会让 writeBooks 清掉其余登记；
  // 登记留在盘上由 repairBooks 扫盘兜底（文件系统侧删除照常进行）
  const books = readBooksStrict(workDir)
  if (books === null) return
  writeBooks(workDir, books.filter((b) => b.name !== name))
  // 活动书被删 → 清指针（下次进书架会提示选书）
  if (readActive(workDir) === name) {
    atomicWriteFile(join(workDir, ACTIVE_FILE), '')
  }
}

// ── 活动书指针（#32 第 3 节）──────────────────────

/** 读活动书 name（.clwriting/active 单行）。缺失返回 null。 */
export function readActive(workDir: string): string | null {
  const fp = join(workDir, ACTIVE_FILE)
  if (!existsSync(fp)) return null
  let name: string
  try {
    name = readFileSync(fp, 'utf-8')
  } catch {
    // 低级项（第六轮）：读取失败（EACCES/EISDIR 等）不裸抛——降级为未选书（null）
    return null
  }
  name = name.trim()
  return name === '' ? null : name
}

/** 写活动书 name（单文件，换书只改它）。原子写防并发/崩溃致半截文件。 */
export function writeActive(workDir: string, name: string): void {
  mkdirSync(join(workDir, CLWRITING_DIR), { recursive: true })
  atomicWriteFile(join(workDir, ACTIVE_FILE), name + '\n')
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

/** cwd 是书仓库：有 book.yaml（去 git：不再要求 .git——书库身份由 book.yaml 唯一判定）。 */
export function isBookRepo(dir: string): boolean {
  return existsSync(join(dir, 'book.yaml'))
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
    reason: '还没选书。请在书库入口启用一本书，或在工作目录下新建一本。',
  }
}

/** 从位置参里找书目录候选（非 -- 开头、非 .md 结尾）。
 *  RB-IF-P2-7：候选须真是书仓库（含 book.yaml）才接受——原先任何自由文本位置参
 *  （题材名/报告名等）都被 resolve 当书目录返回 ok，带自由文本参数的命令被误导。 */
function findPositionalBookRoot(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith('--')) continue
    if (/^\d+$/.test(arg)) continue // 章号/批量数量等数字位置参，不是书目录
    if (arg.endsWith('.md')) continue // 草稿文件，不是书目录
    if (!isBookRepo(resolve(arg))) continue // 非书仓库的自由文本 → 不当书根（回落 cwd/活动书）
    return arg
  }
  return undefined
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
  /** M-8（第八轮）：books.jsonl 读失败时跳过本轮自愈（防「降级空表 × 扫盘整写」清掉
   *  非标准深度登记）——此时其余字段为空、changed=false，调用方应告警而非报告自愈 */
  skipped?: 'read-failed'
}

/**
 * 自愈 books.jsonl（#32 第 6 节）。
 * - 缺失/损坏 → 扫描工作目录直接子目录 + 长篇/短篇 子目录（有 book.yaml）→ 重建登记
 * - 已有登记：检查 path 是否在磁盘存在，不存在的标 missing（提示重关联）
 *
 * 真源是磁盘上的书仓库本身；books.jsonl 是「可从扫描重建的派生登记」（类比 .cache）。
 */
export function repairBooks(workDir: string): RepairResult {
  // M-8（第八轮）：读失败（EACCES 等）跳过本轮自愈——DA-3（第七轮）只收口了
  // append/remove/rename 三个写点，本函数自称「兜底」却用降级空表起建：EACCES 挡
  // readFileSync 不挡 atomicWriteFile 的 tmp+rename，扫盘整写会立即落盘；而
  // scanBookCandidates 只扫顶层 + 长篇/短篇 二级，登记允许任意无 .. 相对路径——
  // 非标准深度的书会被静默清出登记。读失败时留给下次启动或人工修复。
  const existing = readBooksStrict(workDir)
  if (existing === null) {
    return { rebuilt: [], missing: [], relinked: [], changed: false, skipped: 'read-failed' }
  }
  const rebuilt: BookEntry[] = existing.map((b) => ({ ...b }))
  const relinked: { name: string; from: string; to: string }[] = []
  let updated = false

  // 扫描旧平铺书仓库 + 新分组书仓库（只到二级，避免误纳书内子目录）
  const scanned: BookEntry[] = []
  const entries = scanBookCandidates(workDir)

  for (const relPath of entries) {
    const dir = join(workDir, relPath)
    if (!isBookRepo(dir)) continue
    const bookName = detectBookName(dir, basename(relPath))
    const kind = detectBookKind(dir)
    const createdAt = detectBookCreatedAt(dir)

    const existingPathIndex = rebuilt.findIndex((b) => b.path === relPath)
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
      if (oldPath !== relPath && !existsSync(join(workDir, oldPath))) {
        rebuilt[existingIndex] = {
          ...entry,
          path: relPath,
          kind,
          ...(entry.created_at || !createdAt ? {} : { created_at: createdAt }),
        }
        relinked.push({ name: bookName, from: oldPath, to: relPath })
      }
      continue
    }

    scanned.push({
      name: bookName,
      path: relPath,
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

function scanBookCandidates(workDir: string): string[] {
  let topEntries: string[] = []
  try {
    topEntries = readdirSync(workDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
  } catch {
    return []
  }

  const candidates: string[] = []
  for (const name of topEntries) {
    candidates.push(name)
    if (name !== KIND_DIRS.long && name !== KIND_DIRS.short) continue
    try {
      const nested = readdirSync(join(workDir, name), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => `${name}/${e.name}`)
      candidates.push(...nested)
    } catch {
      // 分组目录读失败时跳过，不影响旧平铺扫描
    }
  }
  return candidates
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
  // Y-20（第五十七轮）：与 detectBookName 同走 readBookConfig 解析口径——此前正则
  // 直读文本，注释行（如 `# kind: short 预留`）会被误判 short 并写回登记
  const r = readBookConfig(join(dir, 'book.yaml'))
  return r.ok && r.config.kind === 'short' ? 'short' : 'long'
}

/** 从 book.yaml 文件 mtime 兜底 created_at（去 git：不再依赖 git log；无则 undefined）。 */
function detectBookCreatedAt(dir: string): string | undefined {
  try {
    const st = statSync(join(dir, 'book.yaml'))
    if (st.isFile()) return new Date(st.mtimeMs).toISOString()
  } catch {
    // 无 book.yaml 忽略
  }
  return undefined
}
