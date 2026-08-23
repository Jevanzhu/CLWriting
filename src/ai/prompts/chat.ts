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
import { normalizeMaxMessages } from './window.js'
import { spillIfLarge, writeSpillFile } from '../../process/spill.js'
import { listSkills, formatSkillIndex } from '../../process/skills.js'
// P-6（第十四轮）：章正文剥 fm 与 format 层同源——此前手写宽松正则
// /^---[\s\S]*?---\n?/ 会把「无 fm 但正文含两处 --- 分隔线」的手写稿吞掉中段
import { bodyOf } from '../../format/frontmatter-core.js'
// G2-2 链路侧接线：可见注入收集器用 events 层的指纹/类型（lineage 只依赖 node:crypto
// 与自身 types，无环；ai 层引 events 与 orchestrate/chat.ts 既有方向一致）
import { digest16, type VisibleInjection } from '../../events/lineage.js'

/** 对话上下文（注入 system prompt 的稳定前段） */
export interface ChatContext {
  /** 角色设定 + 境界体系摘要（buildSettingsContext 产出） */
  settings: string
  /** 作者指定讨论的章节信息（未选则 undefined） */
  currentChapter?: string
  /** 写作技巧包索引（DSH-18：一行一包的元信息目录；空库为 undefined 不注入） */
  skillsIndex?: string
  /** T2-1：本次注入实际引用的文件清单（相对书根，spill 外置时为其 locator）——
   *  经 runChat → runTask promptFiles 进 llm/call promptMeta.files，文件级「模型可见
   *  ⟺ 已记录」的登记来源；无文件注入（未选章/章文件不存在）为空数组 */
  files: string[]
  /** T2-1：章正文注入的 revision/ref 登记路径——spill 外置时为 locator，否则为草稿
   *  相对路径；未注入章正文时 undefined（登记侧据此不落 revision/ref 或落空 path） */
  chapterFile?: string
}

/** 构建 system prompt（前段稳定 → 利于前缀缓存） */
export function chatSystem(ctx: ChatContext): string {
  return `你是 CLWriting 的写作助手。你正在协助一位中文网文作者。

## 当前作品设定
${ctx.settings}

${ctx.currentChapter ? `## 作者指定讨论的章节\n${ctx.currentChapter}` : ''}
${ctx.skillsIndex ? `\n${ctx.skillsIndex}\n` : ''}
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
 * 「模型可见」注入收集器（G2-2 链路侧接线）：把 ctx 中实际进 system prompt 的
 * 段落折成 {scope, digest} 清单——verifyVisibleRecorded 的 visible 入参唯一生产来源。
 *
 * 口径与 chatSystem 的注入条件一一镜像：settings 恒注入；currentChapter / skillsIndex
 * 非空才注入（chatSystem 的两个三元分支），非空才产出注入项。digest 直接取注入原文
 * （chatSystem 拼进 prompt 的同一 ctx 字段），不二次拼接；登记侧（runChat）必须对
 * 同一字段做同源 digest16，任一侧改拼接源即破坏「模型可见 ⟺ 已记录」。
 */
export function visibleInjections(ctx: ChatContext): VisibleInjection[] {
  const out: VisibleInjection[] = [{ scope: 'settings', digest: digest16(ctx.settings) }]
  if (ctx.currentChapter) out.push({ scope: 'chapter', digest: digest16(ctx.currentChapter) })
  if (ctx.skillsIndex) out.push({ scope: 'skills', digest: digest16(ctx.skillsIndex) })
  return out
}

/**
 * 组装对话上下文。
 *
 * @param bookRoot 书库根
 * @param chapter 作者选定的章号（可选；未选则只注入设定不注入正文）
 * @param opts 用户数据根（DSH-18：技巧包用户根发现用；缺省只扫项目根 + 捆绑根）
 */
export function buildChatContext(
  bookRoot: string,
  chapter?: number,
  opts?: { userDataPath?: string },
): ChatContext {
  const settings = buildSettingsContext(bookRoot)
  let currentChapter: string | undefined
  const files: string[] = []
  let chapterFile: string | undefined

  if (chapter !== undefined && chapter >= 1) {
    // 尝试读取章节正文前 2000 字
    const draftRel = resolveDraftPath(bookRoot, chapter).relPath
    const draftPath = join(bookRoot, draftRel)
    const parts: string[] = [`第 ${chapter} 章`]
    if (existsSync(draftPath)) {
      const raw = readFileSync(draftPath, 'utf-8')
      // 剥离 front matter，取正文（P-6：bodyOf 同源结构化解析——首行必须 --- 且逐行找闭合，
      // 无 fm 的裸 md 原样返回；不再用宽松正则误吞正文中的 --- 分隔线）
      const body = bodyOf(raw)
      // B3：超长正文外置（工作区/spills/）+ 头尾预览 + read_chapter 取回指引，
      // 替代 slice(0,2000) 无通知硬切（可切半句、章尾不可见）
      const spilled = spillIfLarge(body, { maxInlineChars: 2000, headChars: 1200, tailChars: 400 }, (full) =>
        writeSpillFile(bookRoot, full),
      )
      parts.push(spilled.preview)
      // T2-1：章正文注入的文件级溯源——revision/ref 登记路径取实际注入源
      //（外置成功记 spill locator，否则记草稿文件本身），同一路径并入 files 清单
      chapterFile = spilled.locator ?? draftRel
      files.push(chapterFile)
    }
    currentChapter = parts.join('\n')
  }

  // DSH-18 技巧包索引：只注入元信息目录（预算 800 code points），正文由 read_skill 按名取
  const skillsIndex = formatSkillIndex(listSkills({ bookRoot, userDataPath: opts?.userDataPath }))

  return { settings, currentChapter, skillsIndex: skillsIndex || undefined, files, chapterFile }
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
  // A1（CS-12）：窗口参数入口归一——非法值（0/负/NaN/分数/非数）归 null = 不设限，
  // 防设置项化后脏值静默丢上下文；当前调用方传常量，属前置防线
  const window = normalizeMaxMessages(maxTurns)
  if (window === null) return history
  if (history.length <= window * 2) return history // 粗估：每回合至少 2 条消息

  // 从尾部往前找 window 个「纯文本 user 消息」作为回合边界
  let turnBoundaries = 0
  let cutIdx = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!
    if (m.role === 'user' && typeof m.content === 'string') {
      turnBoundaries++
      if (turnBoundaries >= window) {
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
 * 多轮带 tools 往返后历史可能出现的非法序列（Anthropic/OpenAI 硬性 400）：
 * - 空 content 消息 → 剔除；reasoning-only assistant（剔 reasoning 后无
 *   text/tool_use）同样剔除——anthropic 适配器会丢 reasoning 块致 content:[]（#3a）
 * - 连续同 role（user/assistant 交替被打断，如中断回滚后）→ 插入互补角色占位（#3b）
 * - 孤儿 tool_result（对应 tool_use 未出现）→ 删除
 * - 尾部孤儿 tool_use（中断残留、无 tool_result 回应）→ 从块中剔除
 * - 首条非 user（悬空 assistant）→ 剔除
 *
 * reasoning 块本体保留（openai 协议 DeepSeek/Kimi 的 echoReasoning 硬要求：
 * 多轮带 tools 时须回传 reasoning_content），只作判空口径。
 *
 * 纯函数，不修改入参，返回新数组。chat.ts 的 5 处手工回滚是第一道防线，
 * 此消毒是第二道兜底。
 */
export function sanitizeHistory(history: ChatMsg[]): ChatMsg[] {
  if (history.length === 0) return history

  // 全量预扫：有 tool_result 回应的 tool_use id（供孤儿 tool_use 判定——
  // 尾部中断残留的 tool_use 无回应，Anthropic 硬 400）
  const answeredToolUseIds = new Set<string>()
  for (const m of history) {
    if (m.role === 'user' && typeof m.content !== 'string') {
      for (const b of m.content as ContentBlock[]) {
        if (b.type === 'tool_result') answeredToolUseIds.add(b.toolUseId)
      }
    }
  }

  let result: ChatMsg[] = []
  // 已出现的 tool_use id（供后续孤儿 tool_result 判定；时序上 use 先于 result）
  const knownToolUseIds = new Set<string>()

  for (const m of history) {
    // 空 content 消息 → 剔除（reasoning-only 被过滤后留下的空壳）
    if (typeof m.content === 'string') {
      if (m.content.trim() === '') continue
    } else if (m.content.length === 0) {
      continue
    }

    // assistant 块级消毒：无回应的孤儿 tool_use 剔除；判空口径 = 剔 reasoning 后
    // 无有效载荷（无 tool_use 且 text 全空白）→ 整条丢弃
    let msg = m
    if (m.role === 'assistant' && typeof m.content !== 'string') {
      const blocks = (m.content as ContentBlock[]).filter(
        (b) => b.type !== 'tool_use' || answeredToolUseIds.has(b.id),
      )
      const hasPayload = blocks.some(
        (b) => b.type === 'tool_use' || (b.type === 'text' && b.text.trim() !== ''),
      )
      if (!hasPayload) continue
      if (blocks.length !== (m.content as ContentBlock[]).length) msg = { ...m, content: blocks }
    }

    // assistant 消息的 tool_use 记录进集合
    if (msg.role === 'assistant' && typeof msg.content !== 'string') {
      for (const b of msg.content as ContentBlock[]) {
        if (b.type === 'tool_use') knownToolUseIds.add(b.id)
      }
    }

    // 孤儿 tool_result（对应 tool_use 未出现过/已被剔）→ 删除
    if (msg.role === 'user' && typeof msg.content !== 'string') {
      const blocks = msg.content as ContentBlock[]
      if (blocks.some((b) => b.type === 'tool_result')) {
        const kept = blocks.filter(
          (b) => b.type !== 'tool_result' || knownToolUseIds.has(b.toolUseId),
        )
        if (kept.length === 0) continue
        result.push({ ...msg, content: kept })
        continue
      }
    }

    result.push(msg)
  }

  // 首条必须 user → 不是则剔除首部悬空 assistant
  while (result.length > 0 && result[0]!.role !== 'user') {
    result.shift()
  }

  // 连续同 role → 插入与当前消息角色互补的占位（保持交替，治 #3b）。
  // 占位角色必须互补：写死 user 会在连续 user 场景插出三连 user（防线失效）
  const fixed: ChatMsg[] = []
  for (const m of result) {
    if (fixed.length > 0 && fixed[fixed.length - 1]!.role === m.role) {
      fixed.push(
        m.role === 'user'
          ? { role: 'assistant', content: '[收到]' }
          : { role: 'user', content: '[对话继续]' },
      )
    }
    fixed.push(m)
  }

  return fixed
}
