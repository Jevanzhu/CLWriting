/**
 * contract 契约层单测（审查 §七：ai/contract 零单测）。
 *
 * assembleChapter：AI 结构化字段 → 宿主拼装 front matter + 正文。
 * 重点守卫：fm 由宿主拼装（章号宿主填）、正文纯文本透传、空正文拒收。
 * R28-6（二十八轮）：并入 contract/chat.ts 零参工具路由不变量锁（见文末 describe）。
 */
import { describe, expect, it } from 'vitest'
import {
  assembleChapter,
  chapterTool,
  chapterToolName,
  submitText,
} from '../../src/ai/contract/chapter.js'
import { chatTools } from '../../src/ai/contract/chat.js'
import {
  RELATION_MINE_SPEC,
  REWRITE_SPEC,
  analysisSpec,
  reviewSpec,
  selfHealSpec,
} from '../../src/ai/tasks/specs.js'

describe('assembleChapter 长篇', () => {
  it('结构化字段 → 宿主拼装 fm + 正文', () => {
    const r = assembleChapter(
      { 标题: '矿井深处', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '压抑', 场景: '战斗', 正文: '正文段落。\n\n第二段。' },
      7,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.content.startsWith('---\n章号: 7\n标题: 矿井深处')).toBe(true)
      expect(r.content).toContain('钩子类型: 悬念钩')
      expect(r.content).toContain('情绪定位: 压抑')
      expect(r.content.endsWith('---\n正文段落。\n\n第二段。')).toBe(true)
    }
  })

  it('章号宿主填（AI 不产出）；可空字段缺失时跳过', () => {
    const r = assembleChapter({ 标题: 'x', 正文: '正文' }, 3)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content).toContain('章号: 3')
  })

  it('空正文 → ok:false', () => {
    const r = assembleChapter({ 标题: 'x', 正文: '  ' }, 3)
    expect(r).toMatchObject({ ok: false, error: '正文字段为空' })
  })

  it('产出非对象 / 缺失 → ok:false', () => {
    expect(assembleChapter(null, 1)).toMatchObject({ ok: false })
    expect(assembleChapter('string', 1)).toMatchObject({ ok: false })
  })

  it('标题含换行 → sanitize 为单行（P2-8：fm 按行解析不被截断）', () => {
    const r = assembleChapter({ 标题: '第一行\n第二行', 正文: '正文' }, 1)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 换行转空格，fm 仍按行解析：标题行 = "标题: 第一行 第二行"
      expect(r.content).toContain('标题: 第一行 第二行')
      expect(r.content).not.toContain('标题: 第一行\n')
    }
  })
})

describe('assembleChapter 短篇', () => {
  it('章号宿主填 + 目标情绪/核心反转', () => {
    const r = assembleChapter({ 标题: '雨夜', 目标情绪: '温暖', 核心反转: '一切都在细节里', 正文: '短文正文' }, 2)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.content.startsWith('---\n章号: 2')).toBe(true)
      expect(r.content).toContain('目标情绪: 温暖')
      expect(r.content).toContain('核心反转: 一切都在细节里')
    }
  })
})

describe('写稿工具契约', () => {
  it('章节写作工具长短篇统一为 submit_chapter，名称与 tool_choice 一致', () => {
    expect(chapterToolName()).toBe('submit_chapter')
    expect(chapterTool().name).toBe('submit_chapter')
  })

  it('submit_text 只要求正文字段（改写契约）', () => {
    const t = submitText()
    expect(t.name).toBe('submit_text')
    const required = t.input_schema.required as string[]
    expect(required).toContain('正文')
    expect(required).not.toContain('标题')
  })

  it('章号/钩子类型等字段由宿主拼装——schema 不要求章号（AI 不产出）', () => {
    const t = chapterTool()
    const props = t.input_schema.properties as Record<string, unknown>
    expect('章号' in props).toBe(false)
    expect('钩子强弱' in props).toBe(true)
  })
})

describe('R28-6 零参 schema 工具路由不变量（chat ≠ generateTool）', () => {
  // 背景：零参工具（properties: {}）在 max_tokens 撞顶时 input 恒为 {}——这是完整
  // 合法调用，但 generateTool 的 toolInputEmpty 判据（gen.ts R27-4/R28-6）会把它误判
  // 成截断抛 MAX_TOKENS。现网不可达的前提是路由不变量：零参工具只出现在 chat agent
  // turns（turns.ts 对 max_tokens 整体拒收，不经 generateTool）。本 describe 把该
  // 不变量锁成机器门：清单漂移或零参工具混入工作流工具面即红。
  const propsOf = (t: { input_schema: Record<string, unknown> }) =>
    Object.keys((t.input_schema['properties'] ?? {}) as Record<string, unknown>)

  it('chat 零参工具清单锁死——新增零参工具须先确认路由路径', () => {
    const zeroArg = chatTools.filter((t) => propsOf(t).length === 0)
    expect(zeroArg.map((t) => t.name)).toEqual(['chapter_status', 'harvest_style'])
  })

  it('工作流 generateTool 路径（genMode=tool 的 TaskSpec）工具 schema 均声明 ≥1 属性', () => {
    const defs = [
      REWRITE_SPEC,
      RELATION_MINE_SPEC,
      reviewSpec('plot'),
      selfHealSpec('long'),
      selfHealSpec('short'),
      // analysis 全 kind 枚举（动态工具名，逐一验证 schema 非零参）
      ...(['score', 'emotion', 'hooks', 'style', 'tags', 'infer_meta'] as const).map((k) => analysisSpec(k)),
    ].map((spec) => spec.tool?.def)
    expect(defs.length).toBeGreaterThan(0)
    for (const def of defs) {
      expect(def).toBeDefined()
      expect(
        propsOf(def!),
        `工具 ${def!.name} 的 schema 声明了 0 个属性——零参工具不得走 generateTool（R28-6），请改走 chat turns 或补 schema`,
      ).not.toHaveLength(0)
    }
  })
})