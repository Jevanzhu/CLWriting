/**
 * L-P1（第八轮）：带 symlink 环剪枝 + 根界约束的 .md 深度优先查找器。
 *
 * book-search.walkMd（第六轮）修复的同族收口：summary/materials/leads 三处递归找章
 * 此前无 visited（书内 a→b→a symlink 环深递归，靠帧内 try/catch 兜 RangeError 整项
 * 退化 + 大量无效 IO）、也无根界（书内指向书外的 symlink 被跟随，引文命中/摘要正文
 * 会整读外部文件）。统一抽此共享实现：
 * - 环剪枝：realpath 去重（visited），二次到访即剪；
 * - 根界 = startDir 自身：查找器都从书内子目录起遍（写作/正文 等），越出即拒
 *   （fail-closed，与 safe-path 同向）；
 * - onFile 返回非 undefined 即短路返回（找第一个命中）。
 *
 * N2（五十九轮）：新增 walkMdEach（全量遍历，与 walkMdFind 同源核心）——state
 * 状态机 / cache rebuild 的正文区目录遍历统一接入此口径，消除四处自带 walk。
 */
import { readdirSync, realpathSync, type Dirent } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'

const ESCAPE_SEGMENT_RE = /^\.\.([\\/]|$)/

export function walkMdFind<T>(
  startDir: string,
  onFile: (abs: string, name: string) => T | undefined,
): T | undefined {
  // 契约保持：yield realpath 绝对路径（L-P1 既有测试断言 realpath 口径）
  for (const hit of mdFileEntries(startDir, new Set<string>())) {
    const found = onFile(hit.real, hit.name)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * N2（五十九轮）：全量遍历口径（与 walkMdFind 同源共享实现）——正文区目录遍历
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
  // N2 产出路径重挂回调用方传入的 startDir 命名空间（realpath 会展开 /var → /private/var
  // 等 symlink 前缀，直接产 real 路径会破坏调用方 relative(root, fp) 类相对计算）
  for (const hit of mdFileEntries(startDir, visited)) {
    onFile(hit.abs, hit.name)
  }
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
  const walk = function* (dir: string): Generator<{ real: string; abs: string; name: string }, void, void> {
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      return // 断链/不可读 → 跳过
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
        // R34D-11（三十四轮）：扩展名匹配大小写不敏感（win 手工改名 .MD 不再对机检/
        // 树红点/账本扫描隐形）；热路径用 slice(-3) 小尾串做一次 toLowerCase，免每文件
        // 全名 toLowerCase 分配
        // abs = 重挂回调用方 startDir 命名空间的路径；real = realpath 绝对路径
        yield { real: fp, abs: join(startDir, relative(realRoot, fp)), name: e.name }
      }
    }
  }
  yield* walk(startDir)
}
