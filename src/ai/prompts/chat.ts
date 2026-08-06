/**
 * 对话助手 system prompt + 上下文组装 + 历史截断（方案 §3.4.3 / §3.5）。
 *
 * 与写稿 prompt 完全隔离——不含工具指令、不含 clwriting 命令、不继承全局配置。
 * 讨论伙伴人格，不是代笔。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMsg } from '../provider/types.js'
import { buildSettingsContext } from '../../studio/server/api/settings.js'
import { resolveDraftPath } from '../../format/draft.js'
import { readKind } from '../../studio/server/book-context.js'

/** 对话上下文（注入 system prompt 的稳定前段） */
export interface ChatContext {
  /** 角色设定 + 境界体系摘要（buildSettingsContext 产出） */
  settings: string
  /** 作者指定讨论的章节信息（未选则 undefined） */
  currentChapter?: string
}

/** 构建 system prompt（前段稳定 → 利于前缀缓存） */
export function chatSystem(ctx: ChatContext): string {
  return `你是 CLWriting 的写作助手。你正在协助一位中文网文作者。

## 当前作品设定
${ctx.settings}

${ctx.currentChapter ? `## 作者指定讨论的章节\n${ctx.currentChapter}` : ''}

## 你的职责
- 讨论剧情走向、角色动机、伏笔布局
- 分析节奏与结构问题
- 提供写作建议和灵感
- 回答关于本书设定的疑问
- 需要时可以调用工具触发写作工作流（写章 / 机检 / 审稿）

## 规则
- 紧扣本书的设定和前文，不编造不存在的人物或设定
- 回答简洁实用，不堆砌辞藻
- 你是讨论伙伴，不是代笔——引导作者自己做决定
- 调用 write_chapter 前先用一句话说明你要做什么（作者会看到确认框）
- 超出能力范围时坦诚说明`
}

/**
 * 组装对话上下文。
 *
 * @param bookRoot 书库根
 * @param chapter 作者选定的章号（可选；未选则只注入设定不注入正文）
 */
export function buildChatContext(bookRoot: string, chapter?: number): ChatContext {
  const settings = buildSettingsContext(bookRoot)
  let currentChapter: string | undefined

  if (chapter !== undefined && chapter >= 1) {
    // 尝试读取章节正文前 2000 字
    const draftPath = join(bookRoot, resolveDraftPath(bookRoot, chapter, readKind(bookRoot)).relPath)
    const parts: string[] = [`第 ${chapter} 章`]
    if (existsSync(draftPath)) {
      const raw = readFileSync(draftPath, 'utf-8')
      // 剥离 front matter，取正文前 2000 字
      const body = raw.replace(/^---[\s\S]*?---\n?/, '')
      parts.push(body.slice(0, 2000))
    }
    currentChapter = parts.join('\n')
  }

  return { settings, currentChapter }
}

/**
 * 按完整回合截断对话历史（方案 §3.5）。
 *
 * 一个回合 = user → [assistant(tool_use) → user(tool_result)]* → assistant(text)
 * 截断点不能落在 tool_use 和 tool_result 之间（Anthropic 会 400）。
 *
 * 实现上从末尾往前找到最近的「纯文本 user 消息」作为安全切点。
 *
 * @param history 完整历史
 * @param maxTurns 保留最近 N 个完整回合（默认 10）
 */
export function trimHistory(history: ChatMsg[], maxTurns = 10): ChatMsg[] {
  if (history.length <= maxTurns * 2) return history // 粗估：每回合至少 2 条消息

  // 从尾部往前找 maxTurns 个「纯文本 user 消息」作为回合边界
  let turnBoundaries = 0
  let cutIdx = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!
    if (m.role === 'user') {
      turnBoundaries++
      if (turnBoundaries >= maxTurns) {
        cutIdx = i
        break
      }
    }
  }

  return history.slice(cutIdx)
}
