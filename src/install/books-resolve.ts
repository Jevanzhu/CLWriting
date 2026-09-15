/**
 * 工作目录定位 + 书仓库判定 + resolveBookRoot 解析链 —— 依据 M5 #32（第 4 节）。
 *
 * R0916-5e（2026-09-16，⑤④产品拆分波1）：自 install/books.ts 缝 B 纯移动拆出——
 * findWorkDir / isBookRepo / ResolveResult / resolveBookRoot / findPositionalBookRoot
 * 原样随迁（注释随代码走，零行为变化）；books.ts 逐名 re-export 桥接，既有消费方
 * import 面不动。残核（books.jsonl 登记读写 + 锁 + 活动书指针）留在 books.ts。
 *
 * resolveBookRoot 是所有写章/状态命令解析「当前对哪本书」的统一入口（#32 第 4 节），
 * 解析链优先级：
 *   1. 显式 [书目录] 参数（最高，覆盖一切；保留既有用法）
 *   2. cwd 是书仓库（有 book.yaml）→ cwd（兼容书仓库内直接跑）
 *   3. .clwriting/active → 读活动书 → 查 books.jsonl 取 path → 工作目录/path
 *   4. 都不是 → 人话报错「还没选书，请在书库入口启用或新建一本」
 */

import process from 'node:process'
import { existsSync, statSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { CLWRITING_DIR, readActive, readBooks } from './books.js'

// ── 工作目录定位（向上找 .clwriting/）──────────────

/**
 * 向上查找最近的含 .clwriting/ 的目录（工作目录定位）。
 * 找不到返回 null（当前在书仓库内或裸目录）。
 */
export function findWorkDir(startDir: string): string | null {
  let dir = resolve(startDir)
  for (;;) {
    // R71-16（总七十一轮）：existsSync 与 statSync 之间存在窗口——同步盘/并发操作下
    // .clwriting 恰在两次调用之间被移走时 statSync 裸抛 ENOENT 炸穿整个上溯（对齐
    // init.ts R62-39 同型口径）；按不存在继续上溯
    if (existsSync(join(dir, CLWRITING_DIR))) {
      try {
        if (statSync(join(dir, CLWRITING_DIR)).isDirectory()) {
          return dir
        }
      } catch {
        // 竞态消失/EACCES 等 stat 失败：视为此处没有 .clwriting，继续上溯
      }
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
