/**
 * 写稿契约——tool_use schema（方案 §四④）。
 *
 * tool_use + tool_choice 强制调用：正文是 JSON 的 string 字段，
 * front matter 由宿主用结构化字段拼装，不再由 AI 手写。
 * 格式漂移从根上消失。
 */
import type { ToolDef } from '../provider/types.js'
import { stringifyValue } from '../../format/frontmatter.js'

/** 章节写作工具——定义 front matter 结构化字段 + 正文 */
export function submitChapter(): ToolDef {
  return {
    name: 'submit_chapter',
    description: '提交章节草稿。把标题、钩子属性、情绪定位、场景和正文一次性提交。',
    input_schema: {
      type: 'object',
      properties: {
        标题: { type: 'string', description: '本章标题' },
        钩子类型: {
          type: 'string',
          enum: ['危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩'],
          description: '章尾钩子类型',
        },
        钩子强弱: {
          type: 'string',
          enum: ['强', '中', '弱'],
          description: '钩子强度',
        },
        情绪定位: {
          type: 'string',
          enum: ['压抑', '铺垫', '小爽', '大爽', '转折'],
          description: '本章主导情绪',
        },
        场景: {
          type: 'string',
          enum: ['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮'],
          description: '本章主场景',
        },
        目标情绪: {
          type: 'string',
          description: '本章要落地的核心情绪（如：恐惧/温暖/震撼/悲伤/释然）',
        },
        核心反转: {
          type: 'string',
          description: '核心反转点的一句话描述',
        },
        正文: {
          type: 'string',
          description: '正文全文（纯叙事文本，仅段落与空行，禁 markdown 标题/加粗/列表）',
        },
      },
      required: ['标题', '钩子类型', '情绪定位', '正文'],
    },
  }
}

/** 局部改写/续写工具——只提交正文文本（不涉 front matter） */
export function submitText(): ToolDef {
  return {
    name: 'submit_text',
    description: '提交改写后的文本。只输出正文文本，不输出标题或属性。',
    input_schema: {
      type: 'object',
      properties: {
        正文: {
          type: 'string',
          description: '改写后的文本（纯叙事文本，仅段落与空行）',
        },
      },
      required: ['正文'],
    },
  }
}

/** 写稿工具（长短篇统一） */
export function chapterTool(): ToolDef {
  return submitChapter()
}

/** 写稿工具名（配合 tool_choice: 'tool'） */
export function chapterToolName(): string {
  return 'submit_chapter'
}

/**
 * 从 tool_use 结构化产出拼装完整 markdown（front matter + 正文）。
 * 章号由宿主填入（AI 不产出），front matter 由宿主组装（AI 不手写）。
 */
export function assembleChapter(
  input: unknown,
  chapter: number,
): { ok: true; content: string } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: '产出为空或非对象' }
  }
  const o = input as Record<string, unknown>
  const 正文 = typeof o['正文'] === 'string' ? (o['正文'] as string).trim() : ''
  if (!正文) return { ok: false, error: '正文字段为空' }

  // fm 单行字段 sanitize：去首尾空白 + 内部换行转空格（换行破坏 fm 按行解析，P2-8）
  const fmVal = (v: unknown): string => String(v ?? '').trim().replace(/[\r\n]+/g, ' ')
  // R43-3（四十三轮）：值侧再过 stringifyValue 单源——AI 产出的自由文本（标题/目标情绪/
  // 核心反转等）含 `#`（被行内注释剥离截断）、`[`/`,`（解析成数组）、`|`/`>`（命中块标量
  // 分支吞后续 fm 行）、纯数字（解析成 number）时此前原样落盘，读回即静默损坏（与系统
  // 正规写侧 frontmatter.ts:276 的 escape-unquote 对称口径在此闭环）。
  const fmLine = (key: string, v: string): string => `${key}: ${stringifyValue(v)}`
  const lines: string[] = []
  lines.push(`章号: ${chapter}`)
  const 标题 = fmVal(o['标题'])
  if (标题) lines.push(fmLine('标题', 标题))
  const 钩子类型 = fmVal(o['钩子类型'])
  if (钩子类型) lines.push(fmLine('钩子类型', 钩子类型))
  const 钩子强弱 = fmVal(o['钩子强弱'])
  if (钩子强弱) lines.push(fmLine('钩子强弱', 钩子强弱))
  const 情绪定位 = fmVal(o['情绪定位'])
  if (情绪定位) lines.push(fmLine('情绪定位', 情绪定位))
  const 场景 = fmVal(o['场景'])
  if (场景) lines.push(fmLine('场景', 场景))
  const 目标情绪 = fmVal(o['目标情绪'])
  if (目标情绪) lines.push(fmLine('目标情绪', 目标情绪))
  const 核心反转 = fmVal(o['核心反转'])
  if (核心反转) lines.push(fmLine('核心反转', 核心反转))

  const fmText = lines.join('\n')
  return { ok: true, content: `---\n${fmText}\n---\n${正文}` }
}
