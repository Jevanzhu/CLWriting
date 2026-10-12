/**
 * 知识层对话面注入单测(语料重建批:catalog 序取篇)。
 *
 * 取篇口径:**候选篇 = `BUNDLED_CATALOG` 中 `faces` 含 `chat` 者,按声明序**;
 * 帽内取前 N(声明序即优先级序,合计帽即止);书级同 rel 覆盖随包(rank 单源在
 * `resolveCorpusFile`)。不再按目录名扫描——**不在 catalog 的书级自建篇不进任何面**,
 * 作者按书改内容走「覆盖同名篇」。注入源登记走 files(书级 = `知识层/<rel>`,
 * 随包 = `知识层(内置)/<rel>`)。
 * 装配面(单篇截断 / 合计即止 / 缺失 / 开关关 / 空候选 / 多篇序 / 标题提取)单源在
 * test/knowledge/inject.test.ts 面表;本件不再重复同一族断言。
 *
 * 本件锁定:声明序取篇 + 帽内即止、非声明件不入段、书级同名覆盖随包、
 * 书级件为空回落随包、越界符号链接 fail-closed、chatSystem 渲染、
 * files 登记面(「模型可见 ⟺ 已记录」通道)。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildChatContext, chatSystem } from '../../src/ai/prompts/chat.js'
import { BUNDLED_SOURCE_PREFIX } from '../../src/knowledge/corpus.js'

const dirs: string[] = []
const strays: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const f of strays.splice(0)) rmSync(f, { force: true })
})

function makeBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'clw-kb-'))
  dirs.push(root)
  return root
}

/** 造书级知识层篇(rel 与随包同构:<类目>/<篇>.md) */
function seedPiece(bookRoot: string, rel: string, content: string): void {
  const abs = join(bookRoot, '知识层', ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

describe('知识层对话面注入(catalog 序)', () => {
  it('声明序取篇:合计帽内前两篇入段,第三篇起即止;files 登记与段序一致', () => {
    const root = makeBook()
    const ctx = buildChatContext(root)
    expect(ctx.knowledge).toBeDefined()
    expect(ctx.knowledge).toContain('## 本书知识层方法论')
    expect(ctx.knowledge).toContain('与本书设定冲突时以设定为准')
    // 声明序前两篇(情节推演 → 冲突结构);体量帽(6000 码点)容不下第三篇 → 即止
    expect(ctx.knowledge).toContain('### 情节推演速查')
    expect(ctx.knowledge).toContain('### 冲突结构速查')
    expect(ctx.knowledge).not.toContain('### 人物设计速查')
    const idxPlot = ctx.knowledge!.indexOf('### 情节推演速查')
    const idxConflict = ctx.knowledge!.indexOf('### 冲突结构速查')
    expect(idxConflict).toBeGreaterThan(idxPlot)
    // 登记面:注入序 = 段序,随包件带内置前缀
    expect(ctx.files).toEqual([
      `${BUNDLED_SOURCE_PREFIX}通用/情节推演速查.md`,
      `${BUNDLED_SOURCE_PREFIX}通用/冲突结构速查.md`,
    ])
    // chatSystem 渲染:knowledge 段进 system prompt
    expect(chatSystem(ctx)).toContain('情节推演速查')
  })

  it('非声明件不入段:不在 catalog 的书级自建篇不进对话面,不阻断随包兜底', () => {
    const root = makeBook()
    seedPiece(root, '方法论/自建纪律.md', '本书自建纪律正文。')
    seedPiece(root, '题材/仙侠.md', '仙侠题材套路大全。')
    seedPiece(root, '通用/自建速查.md', '通用类目自建篇正文。')
    const ctx = buildChatContext(root)
    expect(ctx.knowledge).toBeDefined()
    expect(ctx.knowledge).not.toContain('本书自建纪律正文')
    expect(ctx.knowledge).not.toContain('仙侠题材套路大全')
    expect(ctx.knowledge).not.toContain('通用类目自建篇正文')
    expect(ctx.files.some((f) => f.includes('自建'))).toBe(false)
    expect(ctx.files).toContain(`${BUNDLED_SOURCE_PREFIX}通用/情节推演速查.md`)
  })

  it('书级同 rel 覆盖随包(同名篇以书级为准,不重复注入)', () => {
    const root = makeBook()
    seedPiece(root, '通用/情节推演速查.md', '本书自制情节推演:只此一条。')
    const ctx = buildChatContext(root)
    expect(ctx.knowledge).toContain('本书自制情节推演')
    expect(ctx.knowledge).not.toContain('三层套娃') // 随包同名篇正文标志词
    expect(ctx.files[0]).toBe('知识层/通用/情节推演速查.md')
  })

  it('书级同名篇为空 → 回落随包(rank 不是「存在即命中」)', () => {
    const root = makeBook()
    seedPiece(root, '通用/情节推演速查.md', '')
    const ctx = buildChatContext(root)
    expect(ctx.knowledge).toContain('三层套娃')
    expect(ctx.files[0]).toBe(`${BUNDLED_SOURCE_PREFIX}通用/情节推演速查.md`)
  })

  it.skipIf(process.platform === 'win32')(
    '防越界 fail-closed:书级同名篇为库外符号链接 → 不注入库外内容(回落随包,不崩)',
    () => {
      const root = makeBook()
      const outside = join(tmpdir(), `clw-outside-${process.pid}-${Date.now()}.md`)
      strays.push(outside)
      writeFileSync(outside, '库外文件正文:不得进 prompt。')
      const abs = join(root, '知识层', '通用', '情节推演速查.md')
      mkdirSync(join(root, '知识层', '通用'), { recursive: true })
      symlinkSync(outside, abs)

      const ctx = buildChatContext(root)
      expect(ctx.knowledge).not.toContain('不得进 prompt')
      expect(ctx.knowledge).toContain('三层套娃')
      expect(ctx.files[0]).toBe(`${BUNDLED_SOURCE_PREFIX}通用/情节推演速查.md`)
    },
  )
})
