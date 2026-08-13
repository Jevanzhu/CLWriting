/**
 * 对话助手 system prompt + 上下文组装 + 历史截断（方案 §3.4.3 / §3.5）。
 *
 * 与写稿 prompt 完全隔离——不含工具指令、不含 clwriting 命令、不继承全局配置。
 * 讨论伙伴人格，不是代笔。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMsg, ContentBlock } from '../provider/types.js'
import { buildSettingsContext } from '../../process/settings-context.js'
import { resolveDraftPath } from '../../format/draft.js'

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
    const draftPath = join(bookRoot, resolveDraftPath(bookRoot, chapter).relPath)
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
    if (m.role === 'user' && typeof m.content === 'string') {
      turnBoundaries++
      if (turnBoundaries >= maxTurns) {
        cutIdx = i
        break
      }
    }
  }

  return history.slice(cutIdx)
}

/**
 * 发送前历史消毒（方案 §6.4，治 #3a/#3b；学 cherry-studio ensureValidHistory）。
 *
 * 多轮带 tools 往返后历史可能出现四类非法序列（Anthropic/OpenAI 硬性 400）：
 * - 空 content 消息（reasoning-only assistant 被过滤后）→ 剔除（#3a）
 * - 连续同 role（user/assistant 交替被打断，如中断回滚后）→ 插入占位 user（#3b）
 * - 孤儿 tool_result（对应 tool_use 被裁掉）→ 删除
 * - 首条非 user（悬空 assistant）→ 剔除
 *
 * 纯函数，不修改入参，返回新数组。chat.ts 的 5 处手工回滚是第一道防线，
 * 此消毒是第二道兜底。
 */
export function sanitizeHistory(history: ChatMsg[]): ChatMsg[] {
  if (history.length === 0) return history

  let result: ChatMsg[] = []
  // 已知的 tool_use id（遍历中记录，靠前 assistant 消息的 tool_use）
  const knownToolUseIds = new Set<string>()

  for (const m of history) {
    // 空 content 消息 → 剔除（reasoning-only 被过滤后留下的空壳）
    if (typeof m.content === 'string') {
      if (m.content.trim() === '') continue
    } else if (m.content.length === 0) {
      continue
    }

    // assistant 消息的 tool_use 记录进集合
    if (m.role === 'assistant') {
      for (const b of m.content as ContentBlock[]) {
        if (b.type === 'tool_use') knownToolUseIds.add(b.id)
      }
    }

    // 孤儿 tool_result（对应 tool_use 未出现过）→ 删除
    if (m.role === 'user' && typeof m.content !== 'string') {
      const blocks = m.content as ContentBlock[]
      if (blocks.some((b) => b.type === 'tool_result')) {
        const kept = blocks.filter(
          (b) => b.type !== 'tool_result' || knownToolUseIds.has(b.toolUseId),
        )
        if (kept.length === 0) continue
        result.push({ ...m, content: kept })
        continue
      }
    }

    result.push(m)
  }

  // 首条必须 user → 不是则剔除首部悬空 assistant
  while (result.length > 0 && result[0]!.role !== 'user') {
    result.shift()
  }

  // 连续同 role → 在断点插占位 user（保持 user/assistant 交替，治 #3b）
  // 注意：必须在「首条剔除」之后——否则悬空 assistant 被占位插入会当上首条
  const fixed: ChatMsg[] = []
  for (const m of result) {
    if (fixed.length > 0 && fixed[fixed.length - 1]!.role === m.role) {
      fixed.push({ role: 'user', content: '[对话继续]' })
    }
    fixed.push(m)
  }

  return fixed
}
