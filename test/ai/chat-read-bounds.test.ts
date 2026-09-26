/**
 * chat 读侧工具有界返回域单测（R0916-5b 拆分件，2026-09-16）。
 *
 * 拆分来源：test/ai/chat.test.ts（原「W2 对话助手 agent 编排器测试」，原头注沿革
 * 见残核 chat.test.ts）——本件承接读侧工具外置/截断四域整块搬移零改动：
 * RB-AI-P2-5 read_chapter 超长截断 / 低-4 截断口径如实（spill 暂存指引）/
 * R0910-W read_skill 正文有界返回 / A1 read_chapter 剥 fm 走 bodyOf 单源。
 */
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat } from '../../src/ai/orchestrate/chat.js'
import { chatTools } from '../../src/ai/contract/chat.js'
import { writeSpillFile } from '../../src/process/spill.js'
import { resolveDraftPath } from '../../src/document/draft-path.js'
import type { DriverEvent } from '../../src/driver/types.js'

let fake: FakeProvider
const dirs: string[] = []
let bookRoot: string

beforeAll(async () => {
  fake = await createFakeProvider()
})

afterAll(async () => {
  await fake.close()
})

beforeEach(() => {
  bookRoot = makeDualTrackWorkdir()
  dirs.push(bookRoot)
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 带 fake provider 的 userData */
function setup(): string {
  const ud = tempUserData()
  dirs.push(ud)
  delete process.env.CLWRITING_DRIVER
  withFakeProvider(ud, fake.url)
  return ud
}

// ─── RB-AI-P2-5 read_chapter 超长章节截断 ───────────

describe('RB-AI-P2-5: read_chapter 整章无上限灌上下文', () => {
  it('数万字章节 → tool_result 截断到头尾上限并注明全文字数与正文路径', async () => {
    // 覆写 fixture 第 1 章为 3 万字正文
    const longRoot = join(bookRoot, '长篇', '长篇测试书')
    writeFileSync(
      join(longRoot, '写作', '正文', '0001-初入宗门.md'),
      '---\n章号: 1\n标题: 初入宗门\n---\n' + '长'.repeat(30_000),
      'utf8',
    )
    fake.setScript([
      { type: 'tool', name: 'read_chapter', input: { chapter: 1 } },
      { type: 'text', content: '读完了。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot: longRoot,
      bookName: 'testP25',
      message: '读第 1 章',
    })

    const result = events.find((e) => e.type === 'chat_tool_result') as { summary?: string } | undefined
    expect(result).toBeTruthy()
    // 截断生效：返回量 < 2 万字上限（3 万字全量灌进 tool_result 会撑爆上下文）
    expect(result!.summary!.length).toBeLessThan(20_000)
    expect(result!.summary!.startsWith('长')).toBe(true) // 头部保留
    expect(result!.summary!.endsWith('长')).toBe(true) // 尾部保留
    expect(result!.summary).toContain('已截断至')
    expect(result!.summary).toContain('30000') // 全章字数
    expect(result!.summary).toContain('写作/正文/0001-初入宗门.md') // 全文路径
  })

  it('上限内章节 → 原文透传（不带截断提示）', async () => {
    fake.setScript([
      { type: 'tool', name: 'read_chapter', input: { chapter: 1 } },
      { type: 'text', content: '读完了。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot: join(bookRoot, '长篇', '长篇测试书'),
      bookName: 'testP25b',
      message: '读第 1 章',
    })

    const result = events.find((e) => e.type === 'chat_tool_result') as { summary?: string } | undefined
    expect(result).toBeTruthy()
    expect(result!.summary).not.toContain('已截断至')
    expect(result!.summary).toContain('林远踏入宗门') // fixture 原文
  })
})

// ─── 低-4（第十轮）：read_chapter 截断口径如实化 ──────────
// 修复背景：spill 通知（「已省略…调用 read_chapter 工具取回」）与工具契约描述
// 都承诺「取回全文」，但 read_chapter 有 RB-AI-P2-5 的 2 万字上限——超长章中段
// 不可达，承诺与现实矛盾。口径改为如实：截断通知写明截断 + 全文去处（优先
// spill 暂存——上下文注入外置的同一份全文，内容寻址同名；无 spill 只报草稿路径）。

describe('低-4（第十轮）：read_chapter 超长截断口径如实', () => {
  it('超长正文截断通知带 spill 暂存路径（与上下文外置的全文同源）', async () => {
    const longRoot = join(bookRoot, '长篇', '长篇测试书')
    const body = '长'.repeat(30_000)
    writeFileSync(join(longRoot, '写作/正文', '0001-初入宗门.md'), '---\n章号: 1\n标题: 初入宗门\n---\n' + body, 'utf8')
    // 模拟 buildChatContext 的上下文外置：同一 body 落 spill（内容寻址同名）
    const locator = writeSpillFile(longRoot, body)!

    fake.setScript([
      { type: 'tool', name: 'read_chapter', input: { chapter: 1 } },
      { type: 'text', content: '读完了。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot: longRoot,
      bookName: 'low4-trunc',
      message: '读第 1 章',
    })

    const result = events.find((e) => e.type === 'chat_tool_result') as { summary?: string } | undefined
    expect(result).toBeTruthy()
    expect(result!.summary).toContain('已截断至') // 截断如实写明（不再假装取回全文）
    expect(result!.summary).toContain('工作区/spills/') // spill 暂存指引（全文以此为准）
    expect(result!.summary).toContain(locator)
    expect(result!.summary).toContain('写作/正文/0001-初入宗门.md') // 草稿路径仍告知
  })

  it('工具契约描述如实注明截断（不再承诺「完整正文」）', () => {
    const def = chatTools.find((t) => t.name === 'read_chapter')
    expect(def).toBeTruthy()
    expect(def!.description).toContain('截断')
    expect(def!.description).not.toContain('完整正文')
  })
})

// ─── R0910-W read_skill 正文有界返回 ───────────────
// 修复背景：read_skill 直接 summary = skill.content 无上限，与 read_chapter（RB-AI-P2-5）
// 同属模型可控外置内容——病理长技巧包可整段灌 tool_result 撑爆上下文。
describe('R0910-W: read_skill 正文有界返回', () => {
  it('超长技巧包 → tool_result 截断至上限并注明截断量', async () => {
    const longRoot = join(bookRoot, '长篇', '长篇测试书')
    mkdirSync(join(longRoot, '设定', '技巧'), { recursive: true })
    writeFileSync(join(longRoot, '设定', '技巧', '长包.md'), '---\nname: 长包\n---\n' + '技'.repeat(30_000), 'utf8')
    fake.setScript([
      { type: 'tool', name: 'read_skill', input: { name: '长包' } },
      { type: 'text', content: '读完了。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot: longRoot,
      bookName: 'r0910w-skill',
      message: '读技巧包',
    })

    const result = events.find((e) => e.type === 'chat_tool_result') as { summary?: string } | undefined
    expect(result).toBeTruthy()
    // 3 万字全量灌进 tool_result 会撑爆上下文：截断后正文 ≤ 上限，另有通知行
    expect(result!.summary!.length).toBeLessThan(20_200)
    expect(result!.summary!.startsWith('技')).toBe(true)
    expect(result!.summary).toContain('已截断至')
    expect(result!.summary).toContain('30000')
  })

  it('上限内技巧包 → 原文透传（不带截断提示）', async () => {
    const longRoot = join(bookRoot, '长篇', '长篇测试书')
    mkdirSync(join(longRoot, '设定', '技巧'), { recursive: true })
    writeFileSync(join(longRoot, '设定', '技巧', '短包.md'), '---\nname: 短包\n---\n短技巧正文', 'utf8')
    fake.setScript([
      { type: 'tool', name: 'read_skill', input: { name: '短包' } },
      { type: 'text', content: '读完了。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot: longRoot,
      bookName: 'r0910w-skill2',
      message: '读技巧包',
    })

    const result = events.find((e) => e.type === 'chat_tool_result') as { summary?: string } | undefined
    expect(result).toBeTruthy()
    expect(result!.summary).toBe('短技巧正文')
  })
})

// ─── A1（五十九轮）：read_chapter 剥 fm 与 prompts/chat.ts 同源（bodyOf）──────────
// 修复背景：read_chapter 仍用旧宽松正则 /^---[\s\S]*?---\n?/ 剥 fm（P-6 已在
// buildChatContext 改 bodyOf，此处是漏网点）——手写稿正文含非整行 ---（表格分隔行等）
// 被吞中段喂给模型；且 spill 哈希与 writeSpillFile（对 bodyOf(raw) 哈希）不同源，
// 超长章截断通知的 fullAt 判定恒 miss。

describe('A1（五十九轮）：read_chapter 剥 fm 走 bodyOf 单源', () => {
  it('无 fm 但正文含非整行 ---（表格分隔行）→ 不吞中段，全文返回', async () => {
    const longRoot = join(bookRoot, '长篇', '长篇测试书')
    const raw =
      '---\n雨夜开场，主角登场，这段正文足够长也可正常返回。\n\n| 场景 | 人物 |\n|---|---|\n| 破庙 | 主角 |\n\n结尾钩子。'
    // 无 fm 手写稿不被 readChapterDir 按 fm 章号识别——写到 resolveDraftPath 预测的
    // 新章路径（与 prompts.test.ts 的 P-6 用例同手法），read_chapter 按此路径读
    const rel = resolveDraftPath(longRoot, 9).relPath
    mkdirSync(dirname(join(longRoot, rel)), { recursive: true })
    writeFileSync(join(longRoot, rel), raw, 'utf8')
    fake.setScript([
      { type: 'tool', name: 'read_chapter', input: { chapter: 9 } },
      { type: 'text', content: '读完了。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot: longRoot,
      bookName: 'a1-noFm',
      message: '读第 9 章',
    })

    const result = events.find((e) => e.type === 'chat_tool_result') as { summary?: string } | undefined
    expect(result).toBeTruthy()
    // 修复前宽松正则从首行 --- 一路吞到表格分隔行的 ---：开场段与表头全丢
    expect(result!.summary).toContain('雨夜开场')
    expect(result!.summary).toContain('破庙')
    expect(result!.summary).toContain('结尾钩子')
  })

  it('spill 哈希与 buildChatContext/writeSpillFile 同源——截断通知 fullAt 命中 spill 暂存', async () => {
    const longRoot = join(bookRoot, '长篇', '长篇测试书')
    // fm 章 + 超长正文（正文含 --- 表格分隔行：旧正则剥出的 body 与 bodyOf 不同 → 哈希必 miss）
    const tail = '长'.repeat(30_000)
    const body = '---\n雨夜开场，主角登场。\n\n| 场景 | 人物 |\n|---|---|\n| 破庙 | 主角 |\n\n' + tail
    writeFileSync(
      join(longRoot, '写作', '正文', '0001-初入宗门.md'),
      '---\n章号: 1\n标题: 初入宗门\n---\n' + body,
      'utf8',
    )
    // 模拟 buildChatContext 的上下文外置：对 bodyOf 口径的同一全文落 spill
    const locator = writeSpillFile(longRoot, body)!

    fake.setScript([
      { type: 'tool', name: 'read_chapter', input: { chapter: 1 } },
      { type: 'text', content: '读完了。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot: longRoot,
      bookName: 'a1-hash',
      message: '读第 1 章',
    })

    const result = events.find((e) => e.type === 'chat_tool_result') as { summary?: string } | undefined
    expect(result).toBeTruthy()
    expect(result!.summary).toContain('已截断至')
    // 修复前哈希口径不同源 → fullAt 恒 miss，只报草稿路径；现同源命中 spill 暂存
    expect(result!.summary).toContain(locator)
  })
})
