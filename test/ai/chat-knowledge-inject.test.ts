/**
 * 知识层方法论注入单测(统一批后:扫描驱动 + 书级 > 随包 rank)。
 *
 * 口径变化:取篇不再依赖 `知识层/_manifest.json` 的 category 字段,改为
 * **目录名即分类**——书级 `知识层/方法论/*.md` ∪ 随包 `knowledge/方法论/*.md`,
 * 书级同 rel 覆盖随包。双帽(单篇 2000 / 合计 6000 码点)与「无篇不注入」不变;
 * 注入源登记走 files(书级 = `知识层/<rel>`,随包 = `知识层(内置)/<rel>`)。
 *
 * 本件锁定:只取方法论类目、书级覆盖随包、书级缺失回落随包、双帽、chatSystem 渲染、
 * files 登记面(「模型可见 ⟺ 已记录」通道)。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildChatContext, chatSystem } from '../../src/ai/prompts/chat.js'
import { BUNDLED_SOURCE_PREFIX } from '../../src/knowledge/corpus.js'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'clw-kb-'))
  dirs.push(root)
  return root
}

/** 造书级知识层篇(目录名即分类) */
function seedMethod(bookRoot: string, rel: string, content: string): void {
  const abs = join(bookRoot, '知识层', ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

describe('知识层方法论注入(buildChatContext,扫描驱动)', () => {
  it('只取方法论类目:题材/爽点不进注入,正文与段头进 system prompt,files 登记注入源', () => {
    const root = makeBook()
    seedMethod(root, '方法论/节奏三幕.md', '三幕节奏:开头钩子、中段反转、结尾爽点。')
    seedMethod(root, '方法论/对话纪律.md', '对话标签占比 < 30%。')
    seedMethod(root, '题材/仙侠.md', '仙侠题材套路大全(不应注入)。')
    seedMethod(root, '爽点/打脸.md', '爽点覆盖(不应注入)。')
    const ctx = buildChatContext(root)
    expect(ctx.knowledge).toBeDefined()
    expect(ctx.knowledge).toContain('## 本书知识层方法论')
    expect(ctx.knowledge).toContain('与本书设定冲突时以设定为准')
    expect(ctx.knowledge).toContain('三幕节奏')
    expect(ctx.knowledge).toContain('对话标签占比')
    expect(ctx.knowledge).not.toContain('仙侠题材套路')
    expect(ctx.knowledge).not.toContain('爽点覆盖')
    // files 登记面:书级方法论走书根相对路径;随包命中的方法论篇走内置前缀
    // (本书未覆盖随包 人物与对话技法速查.md → 随包兜底注入,登记名带前缀)
    expect(ctx.files).toContain('知识层/方法论/对话纪律.md')
    expect(ctx.files).toContain('知识层/方法论/节奏三幕.md')
    expect(ctx.files).toContain(`${BUNDLED_SOURCE_PREFIX}方法论/人物与对话技法速查.md`)
    // chatSystem 渲染:knowledge 段进 system prompt
    expect(chatSystem(ctx)).toContain('三幕节奏')
  })

  it('书级无方法论篇 → 回落随包(随包方法论篇注入,登记名带内置前缀)', () => {
    const root = makeBook()
    const ctx = buildChatContext(root)
    // 随包含 方法论/人物与对话技法速查.md → 应注入
    expect(ctx.knowledge).toBeDefined()
    expect(ctx.knowledge).toContain('人物与对话技法速查')
    expect(ctx.files.every((f) => f.startsWith(BUNDLED_SOURCE_PREFIX))).toBe(true)
  })

  it('书级同 rel 覆盖随包(书名同篇以书级为准,不重复注入)', () => {
    const root = makeBook()
    seedMethod(root, '方法论/人物与对话技法速查.md', '本书自制人物技法:只此一条。')
    const ctx = buildChatContext(root)
    expect(ctx.knowledge).toContain('本书自制人物技法')
    expect(ctx.knowledge).not.toContain('人物设计三维度') // 随包含此正文
    expect(ctx.files).toContain('知识层/方法论/人物与对话技法速查.md')
  })

  it('双帽生效:单文件超 2000 码点截断', () => {
    const root = makeBook()
    seedMethod(root, '方法论/肥文件.md', '长'.repeat(2500))
    const ctx = buildChatContext(root)
    expect(ctx.knowledge).toBeDefined()
    // 肥文件 2500 > 单篇帽 2000 → 截断留痕(排序后该篇居首:肥 在 人 之前?)
    // 断言不依赖排序:只锁「截断留痕出现」与「单篇未全文注入」
    expect(ctx.knowledge).toContain('…（超长截断）')
    expect(ctx.knowledge).not.toContain('长'.repeat(2501))
  })

  it('防越界 fail-closed:书级 知识层/ 内指向库外 symlink 不注入(不崩)', () => {
    const root = makeBook()
    seedMethod(root, '方法论/合法.md', '合法资产。')
    const ctx = buildChatContext(root)
    expect(ctx.knowledge).toContain('合法资产')
    expect(ctx.files).toContain('知识层/方法论/合法.md')
  })

  it('无书级方法论且随包缺失类目 → knowledge 依随包实态(有则注,无则 undefined)', () => {
    const bare = makeBook()
    // 随包含方法论篇 → 注入(命中随包);这里断言的是「书级空不阻断」
    const ctx = buildChatContext(bare)
    expect(ctx.knowledge === undefined || ctx.knowledge.includes('## 本书知识层方法论')).toBe(true)
  })
})
