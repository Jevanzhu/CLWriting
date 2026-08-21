/**
 * 共享路径安全校验（P1-3 / D3 defense-in-depth）。
 *
 * manifest 路径（文档清单.jsonl 中 m.path）与 books.jsonl 同属可篡改的本地数据文件，
 * 需统一校验防止 join(bookRoot, m.path) 越出 bookRoot。
 *
 * 本模块还导出 symlink 校验共享函数（isWithinRoot）与 canonical 路径解析
 * （resolveWithinRoot），供 trash.ts / files.ts / service.ts / desktop 等各
 * safePath 变体统一引用，确保防护行为一致（fail-closed）。
 */
import { relative, isAbsolute, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'

export interface ResolvedWithinRoot {
  /** 绝对路径；目标存在时为 realpath（symlink 已解析），不存在时为 resolve 结果 */
  abs: string
  /** abs 相对 bookRoot 的规范化相对路径（posix 分隔，白名单前缀匹配用） */
  rel: string
}

/**
 * canonical 防穿越解析（批 6 二轮复审统一）：relPath 解析到 bookRoot 内的绝对路径，
 * 越出 / NUL / 空路径 / 落到 bookRoot 自身 → null（fail-closed：realpath 抛 → null）。
 *
 * 语义 = files.ts safePath / safeManifestPath 的多数派：root 平时只 resolve，目标
 * 存在时才双侧 realpath 防 symlink 越出（macOS tmpdir /var→/private/var 场景由
 * 双侧 realpath 消解，无需 root 预解析）。此前 6 处手写变体语义等价但实现漂移，
 * 统一委托此处（service.resolveSafePath / files.safePath / trash.safePathWithin /
 * desktop show-in-folder·open-book-dir / style·books 删路径守卫）。
 */
/** P5-数据层（第七轮）：越段判定——'..' 本体或以 '..' + 分隔符开头才算越出；
 *  原先的 startsWith('..') 把字面以 .. 开头的合法文件名（..foo.md）误杀（fail-closed
 *  方向安全但属误报）；两种分隔符都认（win 反斜杠）。 */
const ESCAPE_SEGMENT_RE = /^\.\.([\\/]|$)/

export function resolveWithinRoot(bookRoot: string, relPath: string): ResolvedWithinRoot | null {
  if (!relPath || relPath.includes('\0')) return null
  const root = resolve(bookRoot)
  const abs = resolve(root, relPath)
  const rel = relative(root, abs)
  if (rel === '' || ESCAPE_SEGMENT_RE.test(rel) || isAbsolute(rel)) return null
  if (existsSync(abs)) {
    // 两边都 realpath：root 自身经符号链接时（tmpdir /var→/private/var），
    // 只 realpath 文件会与未解析的 root 前缀不一致而误判越出
    try {
      const realRoot = realpathSync(root)
      const real = realpathSync(abs)
      const realRel = relative(realRoot, real)
      if (realRel === '' || ESCAPE_SEGMENT_RE.test(realRel) || isAbsolute(realRel)) return null
      return { abs: real, rel: realRel.replace(/\\/g, '/') }
    } catch {
      return null // realpath 失败（EACCES/ELOOP/断链）→ 拒绝（fail-closed）
    }
  }
  return { abs, rel: rel.replace(/\\/g, '/') }
}

/**
 * symlink realpath 二次校验（防符号链接指向 bookRoot 外）。
 *
 * fail-closed 策略：realpath 失败 → false（拒绝），与 resolveSafePath 一致。
 * 文件不存在（新建场景）→ true（只做路径校验即可）。
 */
export function isWithinRoot(bookRoot: string, abs: string): boolean {
  if (!existsSync(abs)) return true
  try {
    const realRoot = realpathSync(bookRoot)
    const real = realpathSync(abs)
    const rel = relative(realRoot, real)
    // L-D1（第八轮）：与 resolveWithinRoot 同段级判定——原先 startsWith('..') 把字面
    // 以 .. 开头的合法文件名（..foo.md）误判越出（fail-closed 误报方向，兄弟函数
    // 第七轮已换 ESCAPE_SEGMENT_RE，此处漏同步）；另补「rel 为空 = 目标即 root」放行，
    // 与 resolveWithinRoot 语义一致（root 自身不越出）
    return rel === '' || (!ESCAPE_SEGMENT_RE.test(rel) && !isAbsolute(rel))
  } catch {
    return false // realpath 失败 → 拒绝（fail-closed）
  }
}

/**
 * 校验 docId 不含路径穿越字符（manifest 可篡改数据面 defense-in-depth）。
 *
 * docId 系统生成（ULID 或 legacy:<hex>），正常不含分隔符。
 * 此函数供内核层（version/analysis）调用，与 API 端点（snapshots.ts）的
 * docId 白名单保持一致：拒绝 `\0` / `/` / `\` / `..`。
 */
export function safeDocId(docId: string): boolean {
  return !docId.includes('\0') && !docId.includes('/') && !docId.includes('\\') && !docId.includes('..')
}

/** 校验 manifest 路径不越出 bookRoot，返回绝对路径或 null（非法）。批 6：委托 resolveWithinRoot。 */
export function safeManifestPath(bookRoot: string, rel: string): string | null {
  return resolveWithinRoot(bookRoot, rel)?.abs ?? null
}
