/**
 * 文档服务尾部自由函数集 —— （⑤④产品巨件拆分波1）自
 * service.ts 缝 B 拆出（纯移动，零行为变化）。
 *
 * 内容：trashBaselineOf / isSamePhysicalFile / sanitizeCreateSegment /
 * isSanitizedCreatePath / isPieceBody / normalizeChapterNo / chapterTitleSegment /
 * findByLegacyId 八个自由函数（原 service.ts 模块私有，仅 DocumentService 类内
 * 消费）。迁入后加 export 供 service.ts 内部 import；原本即无外部消费方，不入
 * service.ts re-export 桥。
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { roleOf } from './layout.js'
import { legacyId } from './stable-id.js'
import { type ManifestEntry } from './manifest.js'
import { type TreeNode } from './tree.js'
import { sanitizeFileNamePart, chapterNoFromName } from '../format/filename.js'
import { readBookConfig } from '../format/yaml.js'

/** 清单条目 → TrashEntry 基线投影单源（
 *  基线 + tags/order，status 可派生故不带）——doTrash 的无锁快照与删除 RMW
 *  锁内新鲜读两处共用同一字段集与键序（键序固定是 JSON.stringify 逐位比对的判据）。 */
export function trashBaselineOf(e: ManifestEntry): { finalizedRevision?: string; finalizedAt?: string; tags?: string[]; order?: number } {
  return {
    ...(e.finalizedRevision ? { finalizedRevision: e.finalizedRevision, finalizedAt: e.finalizedAt } : {}),
    ...(e.tags && e.tags.length > 0 ? { tags: e.tags } : {}),
    ...(typeof e.order === 'number' ? { order: e.order } : {}),
  }
}

/** 同物理文件判定（win NTFS/mac APFS 大小写不敏感 FS 的纯大小写改名识别）——
 *  dev+ino 口径对齐 api/books.ts 。stat 失败（EACCES 等）按「非同文件」保守处理，
 *  走既有冲突收口。 */
export function isSamePhysicalFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a)
    const sb = statSync(b)
    return sa.dev === sb.dev && sa.ino === sb.ino
  } catch {
    return false
  }
}

/** createDocument 的单段消毒——文件段带 .md 扩展名时只消毒标题段
 *  再原样拼回扩展名（大小写保留），目录段/无扩展名段整体消毒。sanitizeFileNamePart
 *  对空段兜底「未命名」，故 `/.md` 形态落为 `未命名.md`，不产生空段。 */
export function sanitizeCreateSegment(seg: string): string {
  if (seg.toLowerCase().endsWith('.md')) {
    return sanitizeFileNamePart(seg.slice(0, -3)) + seg.slice(-3)
  }
  return sanitizeFileNamePart(seg)
}

/** save 新建路径的消毒闸判定——任一**非空**段经 sanitizeCreateSegment
 *  （单源）会改写即不合规（保留设备名/尾点/尾空格/控制字符/非法字符段）。
 *  空段跳过（'a//b.md' 类冗余分隔符由 resolve 词法折叠，铸名无害，不误拒）；两种
 *  分隔符都切（win 反斜杠 relPath 变体与 posix 口径同判）。 */
export function isSanitizedCreatePath(relPath: string): boolean {
  return relPath
    .split(/[\\/]/)
    .every((seg) => seg === '' || sanitizeCreateSegment(seg) === seg)
}

/** 短篇正文（写作/正文/ + 书级 kind=short）——标题编辑联动文件名 rename + 清单同步。 */
export function isPieceBody(relPath: string, bookRoot: string): boolean {
  if (roleOf(relPath) !== 'chapter') return false
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  return cfg.ok ? (cfg.config.kind ?? 'long') === 'short' : false
}

/** fm 章号归一——引号包裹的纯数字串（作者手写/外部工具写回的
 *  `章号: "12"`）与数字同等参与文件名派生；此前 typeof === 'number' 判不过就回落
 *  basename 前缀提取，改标题后章号段静默劣化。非数字（含小数/空/杂串）→ null 走
 *  原回落；仅用于文件名派生，fm 原值不回写（字节级忠实口径）。 */
export function normalizeChapterNo(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return null
}

/** 0914 章文件名标题段剥离（章号识别收编 chapterNoFromName 单源，
 *  format/filename 宽集：`-`/`—`/空白/裸尾均认）——原窄正则 `/^(?:\d+-)?(.+)\.md$/`
 *  只认 `-` 分隔，`5—标题.md`/`5 标题.md` 的章号前缀剥不净（整名连章号落标题）。
 *  命中判定走 chapterNoFromName；剥段 = 首个分隔符（`-`/`—`/空白，与单源分隔集一致）
 *  之后余下部分（前缀是纯数字，首个分隔符即单源正则消费的那一个）。裸章号名（`0001.md`，
 *  单源 `$` 臂命中）无标题段 → 空串，消费侧 sanitize || '未命名' 兜底；非 .md 名
 *  维持原窄正则口径返回空串。 */
export function chapterTitleSegment(fileName: string): string {
  if (!fileName.endsWith('.md')) return ''
  const base = fileName.slice(0, -'.md'.length)
  if (chapterNoFromName(base) === null) return base
  const sepIdx = base.search(/[-—\s]/)
  return sepIdx === -1 ? '' : base.slice(sepIdx + 1)
}

/** 深度优先找 legacyId(path) === docId 的叶子，返回其 relPath；无匹配 null。 */
export function findByLegacyId(nodes: TreeNode[], docId: string): string | null {
  for (const n of nodes) {
    if (!n.isDirectory && legacyId(n.path) === docId) return n.path
    if (n.children.length) {
      const hit = findByLegacyId(n.children, docId)
      if (hit) return hit
    }
  }
  return null
}
