/**
 * 账本推进声明生成（W-P1-3 右端：AI 草拟 + 作者确认）。
 *
 * 下沉到 process 层：端点（server/api/lead-updates.ts）与 self-heal 写稿完成后
 * （ai/orchestrate）共用，避免 ai → server 反向依赖。
 *
 * 流程：读本章正文 + 细纲声明推进 + 当前进行中账本 → AI 产出「本章实际写入的履历行」
 * → 解析过滤（存量编号 + 合法动词表）→ 写 工作区/账本推进.md（作者在编辑器确认/修改，
 * finalize 时回写布线履历并清空）。
 */
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { atomicWriteFile } from '../fs/atomic.js'
import { readChapterDir } from '../format/chapters.js'
import { readDraft } from '../format/draft.js'
import { readKind } from '../format/kind.js'
import { runSpec } from '../ai/tasks/spec.js'
import { LEAD_UPDATE_SPEC } from '../ai/tasks/specs.js'
import { readOutlineLeads } from '../check/outline-leads.js'
import { LEAD_VERBS } from '../format/leads.js'
import { readOpenLeads } from './open-leads.js'
import { pruneTextMiddle } from './prune.js'

/** 账本推进文件路径（与 check/lead-updates.ts + document/lead-finalize.ts 读取常量一致） */
export const LEAD_UPDATES_FILE = '工作区/账本推进.md'

/** 批量连写下按章归档目录（X-P2-6：上一章未定稿确认的草稿不被本章覆盖，finalize 按章号回收） */
export const LEAD_UPDATES_ARCHIVE_DIR = '工作区/.账本推进暂存'

/**
 * W-P1-3 右端：生成并落盘 账本推进.md（AI 草拟）。
 * 端点与 self-heal 写稿完成后共用：读本章正文 + 细纲声明 + 进行中账本 → AI 声明实际履历行
 * → 解析过滤（存量编号 + 合法动词）→ 写 工作区/账本推进.md。
 *
 * @param signal Z-P1-1：外部中断信号（self-heal 编排级 / chat 工具层）——
 *               生成随调用方中断同步中止；端点直调（无可中断语境）缺省不传。
 * @returns { ok: true; count: number } 成功（count=0 表示无推进/全被过滤）；
 *          { ok: false; code: 'rejected' | 'not-found' | 'failed'; error: string } 失败
 *          （rejected=业务拒绝如短篇无布线；not-found=正文不存在；failed=AI/落盘失败）。
 */
export async function generateLeadUpdateDraft(
  bookRoot: string,
  chapter: number,
  userDataPath: string | null,
  signal?: AbortSignal,
): Promise<{ ok: true; count: number } | { ok: false; code: 'rejected' | 'not-found' | 'failed'; error: string }> {
  if (readKind(bookRoot) !== 'long') return { ok: false, code: 'rejected', error: '账本推进仅适用于长篇（有布线账本）' }

  const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
  const hit = chapters.find((c) => c.章号 === chapter)
  if (!hit?._path) return { ok: false, code: 'not-found', error: '第 ' + chapter + ' 章正文不存在，先写稿再生成账本推进' }

  const draft = readDraft(hit._path)
  if (!draft.ok) return { ok: false, code: 'not-found', error: draft.reason }

  const prompt = buildLeadUpdatePrompt(bookRoot, chapter, draft.body)
  // Z-P1-1：signal 桥接进 runSpec——调用方（self-heal/chat）中断时本生成同步中止
  const out = await runSpec(LEAD_UPDATE_SPEC, { userDataPath, bookRoot, userPrompt: prompt, signal })
  if (!out.ok) return { ok: false, code: 'failed', error: out.error }
  const text = out.data.text.trim()
  if (!text) return { ok: false, code: 'failed', error: 'AI 产出为空' }

  const updates = parseLeadUpdateDraft(text, bookRoot)
  const body = updates.length > 0
    ? updates.map((u) => '- ' + u.leadId + ' ' + u.动词 + '：' + u.证据).join('\n')
    : '# 本章无账本推进'
  try {
    // X-P2-6：批量连写下，主文件可能是上一章（尚未定稿确认）的草稿——先按章归档再写本章，
    // finalize（applyLeadUpdates）按定稿章号从归档回收，防止整链旁路丢确认内容。
    archivePendingLeadUpdates(bookRoot, chapter)
    atomicWriteFile(join(bookRoot, LEAD_UPDATES_FILE), `# 第${chapter}章 账本推进\n` + body + '\n')
  } catch (e) {
    return { ok: false, code: 'failed', error: '落盘:' + (e instanceof Error ? e.message : String(e)) }
  }
  return { ok: true, count: updates.length }
}

/**
 * 主文件若载有**其他章**的待确认条目 → 归档到 工作区/.账本推进暂存/第N章.md（X-P2-6）。
 * 同章重生成（自愈循环复查）直接覆盖不归档；无条目（空/无推进）不归档；无标签旧文件不归档
 * （语义上视为当前章，保持单章模式旧行为）。
 */
export function archivePendingLeadUpdates(bookRoot: string, forChapter: number): void {
  const file = join(bookRoot, LEAD_UPDATES_FILE)
  if (!existsSync(file)) return
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch {
    return
  }
  const hasEntries = raw.split('\n').some((l) => l.trim().startsWith('-'))
  if (!hasEntries) return
  const m = (raw.split('\n', 1)[0] ?? '').match(/^#\s*第(\d+)章/)
  if (!m) return // 无标签旧格式 → 视为当前章，保持覆盖语义
  const tag = Number(m[1])
  if (tag === forChapter) return
  const dir = join(bookRoot, LEAD_UPDATES_ARCHIVE_DIR)
  mkdirSync(dir, { recursive: true })
  renameSync(file, join(dir, `第${tag}章.md`))
}

/**
 * 组账本推进 prompt：正文 + 细纲声明 + 进行中账本 → AI 声明「本章实际写入的履历行」。
 * 关键约束：证据必须是正文原句（readChapterLeadUpdates 用 extractEvidenceCore 命中正文才算兑现），
 * 动词须匹配该线合法动词表（LEAD_VERBS），编号须为存量进行中账本。
 */
export function buildLeadUpdatePrompt(bookRoot: string, chapter: number, body: string): string {
  const declared = readOutlineLeads(bookRoot, chapter)
  const open = readOpenLeads(bookRoot)
  const parts: string[] = [
    '## 任务\n为第 ' + chapter + ' 章生成「账本推进声明」——AI 写完本章后声明本章**实际**推进了哪些账本线。',
    // A3：超长正文无通知硬切 slice(0,6000) → 修剪器头尾保留（账本证据常在章尾）。
    // 预算对齐原值：4800+1024+marker ≈ 5850 < 6000，可见量不增、多覆盖尾部且明示省略
    '## 本章正文\n' + pruneTextMiddle(body, { threshold: 6000, head: 4800, tail: 1024 }),
  ]
  if (declared.length > 0) {
    parts.push('## 细纲声明推进（计划，本章应兑现；实际写砸了可如实降级/不推进）\n' + declared.join('、'))
  }
  if (open.length > 0) {
    parts.push(
      '## 进行中账本（编号 + 合法动词表，仅可从这些编号中选择）\n' +
        open
          .map((l) => {
            const type = l.编号.split('-')[0] as keyof typeof LEAD_VERBS
            const verbs = LEAD_VERBS[type]
            return '- ' + l.编号 + ' ' + l.标题 + '（' + l.状态 + '） 动词:[' + (verbs ? verbs.advance.join('/') : '') + ']'
          })
          .join('\n'),
    )
  }
  parts.push(
    '## 输出\n直接输出账本推进行列表（每行一个，- 开头）：\n  - <编号> <动词>：<证据>\n其中 <证据> 必须是本章正文的**原句**（机检据此核对兑现，非原句会被判未兑现）；\n只列本章真正推进/开启/揭晓的线；本章无推进则输出「无推进」三个字。',
  )
  return parts.join('\n\n')
}

/**
 * 解析 AI 产出的账本推进草稿 → 合法 ChapterLeadUpdate[]。
 * 与 check/lead-updates.ts 读取格式同构（- <编号> <动词>：<证据>）；
 * 过滤：编号必须命中存量进行中账本、动词必须命中该线 advance/resolve/open 动词表。
 */
export function parseLeadUpdateDraft(text: string, bookRoot: string): { leadId: string; 动词: string; 证据: string }[] {
  const open = new Set(readOpenLeads(bookRoot).map((l) => l.编号))
  const out: { leadId: string; 动词: string; 证据: string }[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('-')) continue
    const m = line.match(/^-\s*(\S+)\s+([^\s:：]+)[:：]\s*(.+)$/)
    if (!m) continue
    const leadId = m[1]!.trim()
    const 动词 = m[2]!.trim()
    const 证据 = m[3]!.trim()
    if (!open.has(leadId) || !证据) continue
    const type = leadId.split('-')[0] as keyof typeof LEAD_VERBS
    const verbs = LEAD_VERBS[type]
    if (!verbs) continue
    const valid = [...verbs.open, ...verbs.advance, ...verbs.resolve, ...verbs.drop]
    if (!valid.includes(动词)) continue
    out.push({ leadId, 动词, 证据 })
  }
  return out
}
