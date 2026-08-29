/**
 * 写作技巧包 skill 化（批次 C4 / DSH-18）。
 *
 * 多根发现 + 按需加载（对齐 B3 spill 的预算纪律：system prompt 不背全量正文）：
 * - 三根扫描，rank 高覆盖低（同名去重）：项目 <bookRoot>/设定/技巧/*.md
 *   → 用户 <userDataPath>/skills/*.md → 捆绑 resources/skills/*.md；
 * - 索引（formatSkillIndex）只暴露元信息（一行一包），正文由 read_skill 工具
 *   按名取用（loadSkill）——模型看到目录，用到哪包读哪包。
 *
 * 容错约定：目录缺失/读失败一律 best-effort 跳过——技巧包残缺绝不阻断对话。
 * frontmatter 复用 format/frontmatter 的 readFile/parseFlat（平铺 key: value）。
 */
import { join, basename } from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile, parseFlat } from '../format/frontmatter.js'
import { bundledResource } from '../fs/resources.js'
import { log } from '../log/index.js'

/** 技巧包元信息（索引级；正文按需加载） */
export interface SkillMeta {
  name: string
  description: string
  whenToUse: string
  source: 'bundled' | 'user' | 'project'
  path: string
}

/** 多根发现入参（均可缺省——缺省的根直接跳过） */
export interface SkillRoots {
  bookRoot?: string
  userDataPath?: string
}

/** 扫描单个根目录 → 元信息列表（目录缺失/读失败 → 空数组，best-effort） */
function scanRoot(dir: string, source: SkillMeta['source']): SkillMeta[] {
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    // 过滤口径同 readCharacterCards：只收 .md，跳过 macOS 资源叉 ._*
    files = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
  } catch {
    return []
  }
  const out: SkillMeta[] = []
  for (const f of files) {
    const fp = join(dir, f)
    // R74-12（七十四轮批 D）：索引先试读——readFile 的 {ok:false} 混装「读失败」与
    // 「无 front matter」两种形态，此前一律按裸 md 降级收录：不可读文件（权限/竞态
    // 删除/IO 故障）也进索引，而 loadSkill 对它恒 null——模型见目录取不到包。现读
    // 失败不入索引并 warn 留痕（读到 text 后再走 readFile 的 content 参数，不二读）
    let text: string
    try {
      text = readFileSync(fp, 'utf-8')
    } catch (e) {
      log.warn('skills', `技巧包读取失败，不入索引：${fp}（${e instanceof Error ? e.message : String(e)}）`)
      continue
    }
    const r = readFile(fp, text)
    if (r.ok) {
      const map = parseFlat(r.fmRaw)
      out.push({
        name: String(map.get('name') ?? basename(f, '.md')),
        description: String(map.get('description') ?? ''),
        whenToUse: String(map.get('whenToUse') ?? ''),
        source,
        path: fp,
      })
    } else {
      // 无 front matter 降级（用户随手丢的裸 md）：name=文件名，全文即正文，不拒之门外
      out.push({ name: basename(f, '.md'), description: '', whenToUse: '', source, path: fp })
    }
  }
  return out
}

/**
 * 三根发现技巧包元信息（rank：项目 > 用户 > 捆绑，同名高 rank 覆盖低 rank）。
 * 输出按 name 排序——索引展示与测试断言都稳定。
 */
export function listSkills(roots: SkillRoots): SkillMeta[] {
  const byName = new Map<string, SkillMeta>()
  // 低 rank 先入、高 rank 后入：Map.set 同 key 覆写即覆盖语义
  for (const meta of scanRoot(bundledResource('skills'), 'bundled')) byName.set(meta.name, meta)
  if (roots.userDataPath) {
    for (const meta of scanRoot(join(roots.userDataPath, 'skills'), 'user')) byName.set(meta.name, meta)
  }
  if (roots.bookRoot) {
    for (const meta of scanRoot(join(roots.bookRoot, '设定', '技巧'), 'project')) byName.set(meta.name, meta)
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * 按需读正文（read_skill 工具的执行通道）。
 * 名字未知/文件读失败 → null（调用方据此回「未找到 + 可用列表」）。
 */
export function loadSkill(name: string, roots: SkillRoots): { meta: SkillMeta; content: string } | null {
  const meta = listSkills(roots).find((m) => m.name === name)
  if (!meta) return null
  const r = readFile(meta.path)
  if (r.ok) return { meta, content: r.body.trim() }
  // 裸 md（无 front matter）：全文即正文（与 scanRoot 降级口径一致）
  try {
    return { meta, content: readFileSync(meta.path, 'utf8').trim() }
  } catch {
    return null
  }
}

/** 索引默认预算（code points，非 UTF-16 单元——emoji 按 1 计） */
const DEFAULT_INDEX_MAX_CHARS = 800

/**
 * 元信息列表 → system prompt 索引段：头行 + 一行一包（- <name>：<whenToUse>）。
 *
 * 预算纪律（学 spill）：超预算整行丢弃（不切半行），末尾补截断通知行；
 * 通知行自身也计价——装不下则回退再丢整行；头行是地板（只剩头行时破例保留
 * 通知，属配置错误场景的 best-effort）。空列表返回空串（不注入段）。
 */
export function formatSkillIndex(metas: SkillMeta[], opts?: { maxChars?: number }): string {
  if (metas.length === 0) return ''
  const maxChars = opts?.maxChars ?? DEFAULT_INDEX_MAX_CHARS
  const header = '## 写作技巧包（需要时调用 read_skill 工具按名取全文）'
  const lines: string[] = [header]
  let used = Array.from(header).length
  let truncated = false
  for (const m of metas) {
    const line = `- ${m.name}：${m.whenToUse}`
    const cost = 1 + Array.from(line).length // 前置换行 + 本行
    if (used + cost > maxChars) {
      truncated = true
      break
    }
    lines.push(line)
    used += cost
  }
  if (truncated) {
    const note = '（技巧包索引超长已截断）'
    while (lines.length > 1 && used + 1 + Array.from(note).length > maxChars) {
      const dropped = lines.pop()!
      used -= 1 + Array.from(dropped).length
    }
    lines.push(note)
  }
  return lines.join('\n')
}
