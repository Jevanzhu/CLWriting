/**
 * 带 symlink 环剪枝 + 根界约束的 .md 深度优先查找器。
 *
 * book-search.walkMd 修复的同族收口：summary/materials/leads 三处递归找章
 * 此前无 visited（书内 a→b→a symlink 环深递归，靠帧内 try/catch 兜 RangeError 整项
 * 退化 + 大量无效 IO）、也无根界（书内指向书外的 symlink 被跟随，引文命中/摘要正文
 * 会整读外部文件）。统一抽此共享实现：
 * - 环剪枝：realpath 去重（visited），二次到访即剪；
 * - 根界 = startDir 自身：查找器都从书内子目录起遍（写作/正文 等），越出即拒
 *   （fail-closed，与 safe-path 同向）；
 * - onFile 返回非 undefined 即短路返回（找第一个命中）。
 *
 * 新增 walkMdEach（全量遍历，与 walkMdFind 同源核心）——state
 * 状态机 / cache rebuild 的正文区目录遍历统一接入此口径，消除四处自带 walk。
 */
import { readdirSync, realpathSync, type Dirent } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'

const ESCAPE_SEGMENT_RE = /^\.\.([\\/]|$)/

export function walkMdFind<T>(
  startDir: string,
  onFile: (abs: string, name: string) => T | undefined,
): T | undefined {
  // 契约保持：yield realpath 绝对路径（既有测试断言 realpath 口径）
  for (const hit of mdFileEntries(startDir, new Set<string>())) {
    const found = onFile(hit.real, hit.name)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 全量遍历口径（与 walkMdFind 同源共享实现）——正文区目录遍历
 * （state 状态机三个 walk / cache rebuild 的 walkChapters、walkSourceStats）统一
 * 接入：裸 statSync（跟随 symlink）+ 递归无 visited 无根界的旧 walk 对循环 symlink
 * 深递归可 RangeError 崩进门、指向书外的 symlink 被整读参与章号推算。
 * - Dirent 判型（不跟随 symlink——symlink 目录不递归、symlink 文件不进结果）；
 * - realpath 去重（visited，可由调用方跨多个 startDir 复用同一 Set）；
 * - 根界 = startDir 自身：越出即拒（fail-closed，与 safe-path 同向）。
 * @param visited 跨目录共享的已访问集合（rebuild 的 walkSourceStats 对
 *   布线/写作/定稿/关系线 多起遍目录复用，防目录间 symlink 互指成环）。
 */
export function walkMdEach(
  startDir: string,
  onFile: (abs: string, name: string) => void,
  visited: Set<string> = new Set<string>(),
): void {
  // 产出路径重挂回调用方传入的 startDir 命名空间（realpath 会展开 /var → /private/var
  // 等 symlink 前缀，直接产 real 路径会破坏调用方 relative(root, fp) 类相对计算）
  for (const hit of mdFileEntries(startDir, visited)) {
    onFile(hit.abs, hit.name)
  }
}

/**
 * walkMdEach 异步孪生（0918修复1）：遍历纪律与同步版逐位同源——
 * Dirent 判型（不跟随 symlink）、realpath 去重环剪枝、根界 = startDir 自身、
 * `._` 资源分叉噪声排除、产出路径重挂回调用方 startDir 命名空间；IO 面（realpath/
 * readdir）走 fs/promises，studio 服务进程事件循环内调用不再冻结。onFile 可返回
 * Promise（顺序 await，遍历序与同步版一致：DFS + readdir 序）。
 */
export async function walkMdEachAsync(
  startDir: string,
  onFile: (abs: string, name: string) => void | Promise<void>,
  visited: Set<string> = new Set<string>(),
): Promise<void> {
  let realRoot: string
  try {
    realRoot = await realpath(startDir)
  } catch {
    return // 起点（含目录缺失）不可解析 → 空遍历（与同步版一致）
  }
  const walk = async (dir: string, dirReal?: string): Promise<void> => {
    let real: string
    if (dirReal !== undefined) {
      real = dirReal
    } else {
      try {
        real = await realpath(dir)
      } catch {
        return // 断链/不可读 → 跳过
      }
    }
    if (visited.has(real)) return // 环剪枝
    visited.add(real)
    const rel = relative(realRoot, real)
    if (rel !== '' && (ESCAPE_SEGMENT_RE.test(rel) || isAbsolute(rel))) return // 越出起遍目录 → 拒
    let entries: Dirent[]
    try {
      entries = await readdir(real, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('._')) continue // macOS 资源分叉噪声
      const fp = join(real, e.name)
      if (e.isDirectory()) {
        await walk(fp)
      } else if (e.isFile() && e.name.slice(-3).toLowerCase() === '.md') {
        // 扩展名匹配大小写不敏感（与同步版同口径）
        // abs = 重挂回调用方 startDir 命名空间的路径（realpath 展开语义同同步版注）
        await onFile(join(startDir, relative(realRoot, fp)), e.name)
      }
    }
  }
  await walk(startDir, realRoot)
}

/**
 * walkMdEach 的生成器孪生（阶段 52 批 1）：与同步版同源核心（mdFileEntries），逐项产出
 * 命中而非回调——调用方可在项目间 yield 让出事件循环（机检前奏段的目录整扫切片用）。
 * 遍历纪律与 walkMdEach 逐位同源：Dirent 判型（不跟随 symlink）、realpath 去重环剪枝、
 * 根界 = startDir 自身、`._` 资源分叉排除、产物路径重挂回调用方 startDir 命名空间。
 * @param visited 跨目录共享的已访问集合（语义同 walkMdEach）。
 */
export function* walkMdEachGen(
  startDir: string,
  visited: Set<string> = new Set<string>(),
): Generator<{ abs: string; name: string }, void, void> {
  for (const hit of mdFileEntries(startDir, visited)) yield { abs: hit.abs, name: hit.name }
}

/** 共享遍历核心：产出 startDir 之下全部 .md 文件（生成器，短路友好）。 */
function* mdFileEntries(
  startDir: string,
  visited: Set<string>,
): Generator<{ real: string; abs: string; name: string }, void, void> {
  let realRoot: string
  try {
    realRoot = realpathSync(startDir)
  } catch {
    return
  }
  // （四轮处置批）：walk 签名加 dirReal 可选参——起点直传上方已解析的
  // realRoot，省掉对 startDir 的第二次 realpathSync 系统调用（原 :63 根解析与首帧
  // 重复解析同一路径）；子目录递归不传，行为不变
  const walk = function* (dir: string, dirReal?: string): Generator<{ real: string; abs: string; name: string }, void, void> {
    let real: string
    if (dirReal !== undefined) {
      real = dirReal
    } else {
      try {
        real = realpathSync(dir)
      } catch {
        return // 断链/不可读 → 跳过
      }
    }
    if (visited.has(real)) return // 环剪枝
    visited.add(real)
    const rel = relative(realRoot, real)
    if (rel !== '' && (ESCAPE_SEGMENT_RE.test(rel) || isAbsolute(rel))) return // 越出起遍目录 → 拒
    let entries: Dirent[]
    try {
      entries = readdirSync(real, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('._')) continue // macOS 资源分叉噪声
      const fp = join(real, e.name)
      if (e.isDirectory()) {
        yield* walk(fp)
      } else if (e.isFile() && e.name.slice(-3).toLowerCase() === '.md') {
        // 扩展名匹配大小写不敏感（win 手工改名 .MD 不再对机检/
        // 树红点/账本扫描隐形）；热路径用 slice(-3) 小尾串做一次 toLowerCase，免每文件
        // 全名 toLowerCase 分配
        // abs = 重挂回调用方 startDir 命名空间的路径；real = realpath 绝对路径
        yield { real: fp, abs: join(startDir, relative(realRoot, fp)), name: e.name }
      }
    }
  }
  yield* walk(startDir, realRoot)
}
