/**
 * 设定上下文 RAG 注入（P1-8 架构下沉：从 studio/server/api/settings 下沉内核）。
 *
 * buildSettingsContext：角色卡 + 境界体系 → 上下文摘要（AI 写稿/对话 prompt 注入用）。
 * 供 ai/prompts、ai/orchestrate、studio/server/api/draft 共用。
 *
 * C3（DSH-17 预算制）：新增 buildSettingsLayers 产出结构化层（角色/境界，均 volume 档），
 * 供 draft-pipeline 组装预算注入；buildSettingsContext 改为按层拼接，渲染格式不变。
 */
import { join, basename, relative } from 'node:path'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { readFile, parseFlat } from '../format/frontmatter.js'
import { readRealmDoc } from '../format/realms.js'
import type { SettingsLayer } from './settings-injection.js'

/** 角色卡(P2 结构化):front matter 姓名/身份/目标/境界 + 正文(自由描述) */
export interface CharacterCard {
  file: string // 相对 bookRoot
  姓名: string
  身份: string
  目标: string
  境界: string
  关系: string // 原始（如 "林远(师徒);赵衡(仇敌)"）
  正文: string
}

function normalizeProjectPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\/+/, '')
}

// ii 批（评审 #19 残余）：角色卡 stat 级缓存——settings GET / 关系梳理输入每次全量
// readFile+parseFlat 所有卡（大书几十张卡+长正文，同步 IO 阻塞事件循环）。与 chapters.ts
// CC-P1-3 同口径：(mtimeMs,size) 命中跳过整读；变化/新增/删除由每轮 readdir 自愈；
// 返回浅拷贝防调用方 mutate 污染缓存。含 mtime+size 撞车理论窗口（同 CC-P1-3，接受）。
interface CardCacheEntry {
  mtimeMs: number
  size: number
  card: CharacterCard
}
const cardCache = new Map<string, CardCacheEntry>()

/** 清空角色卡缓存（测试用）。 */
export function clearCharacterCardCache(): void {
  cardCache.clear()
}

/** 读角色卡目录（front matter 结构化；无 fm 降级：姓名=文件名，正文=全文） */
export function readCharacterCards(dirPath: string, bookRoot: string): CharacterCard[] {
  const out: CharacterCard[] = []
  if (!existsSync(dirPath)) return out
  let files: string[]
  try {
    files = readdirSync(dirPath).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
  } catch {
    return out
  }
  for (const f of files) {
    const fp = join(dirPath, f)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(fp)
    } catch {
      continue
    }
    const hit = cardCache.get(fp)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      out.push({ ...hit.card }) // 浅拷贝：调用方改字段不污染缓存
      continue
    }
    const r = readFile(fp)
    let card: CharacterCard
    if (r.ok) {
      const map = parseFlat(r.fmRaw)
      card = {
        file: normalizeProjectPath(relative(bookRoot, fp)),
        姓名: String(map.get('姓名') ?? basename(f, '.md')),
        身份: String(map.get('身份') ?? ''),
        目标: String(map.get('目标') ?? ''),
        境界: String(map.get('境界') ?? ''),
        关系: String(map.get('关系') ?? ''),
        正文: r.body.trim(),
      }
    } else {
      // 降级:无 front matter(旧自由 MD),姓名=文件名,正文=全文
      const text = readFileSync(fp, 'utf8')
      card = {
        file: normalizeProjectPath(relative(bookRoot, fp)),
        姓名: basename(f, '.md'),
        身份: '',
        目标: '',
        境界: '',
        关系: '',
        正文: text.trim(),
      }
    }
    cardCache.set(fp, { mtimeMs: st.mtimeMs, size: st.size, card })
    out.push({ ...card })
  }
  return out
}

/**
 * 角色层 + 境界层 → 结构化设定层（C3 预算注入用，均 volume 档）。
 * 各层 text 渲染格式与原 buildSettingsContext 完全一致（含 '## …' 标题头）。
 */
export function buildSettingsLayers(bookRoot: string): SettingsLayer[] {
  const layers: SettingsLayer[] = []
  const chars = readCharacterCards(join(bookRoot, '设定', '角色'), bookRoot)
  if (chars.length) {
    layers.push({
      name: '角色设定',
      specificity: 'volume',
      text:
        '## 角色设定(供参考,保持人物一致)\n\n' +
        chars
          .map((c) => {
            const meta = [c.身份, c.目标, c.境界].filter(Boolean).join('/')
            return `- ${c.姓名}${meta ? `(${meta})` : ''}`
          })
          .join('\n'),
      // Q-5：角色层源文件（CharacterCard.file 已是相对书根）
      sources: chars.map((c) => c.file),
    })
  }
  const rr = readRealmDoc(join(bookRoot, '设定', '境界体系.md'))
  if (rr.ok && rr.doc.体系.length) {
    layers.push({
      name: '境界体系',
      specificity: 'volume',
      text:
        '## 境界体系(成长线机检依据)\n\n' +
        rr.doc.体系.map((s) => `- ${s.名称}: ${s.序列.join(' → ')}`).join('\n'),
      sources: ['设定/境界体系.md'],
    })
  }
  return layers
}

/** 角色 + 境界体系 → prompt 注入上下文（写稿/对话保持人物一致性）；按层拼接，格式不变 */
export function buildSettingsContext(bookRoot: string): string {
  return buildSettingsLayers(bookRoot)
    .map((l) => l.text)
    .join('\n\n')
}