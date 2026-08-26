/**
 * 工具面扩展单测：rewrite 工具入参校验与选段定位（不触发 AI）。
 * RB-AI-P1-1：补成功路径（mock runSpec）——改写全文 spill 落盘 + summary 带路径与字数。
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { rewriteChapter, rewriteSelection, applySpill } from '../../../src/ai/tools/rewrite.js'
import { writeSpillFile } from '../../../src/process/spill.js'
import { runSpec } from '../../../src/ai/tasks/spec.js'
import type { ToolContext } from '../../../src/ai/tools/context.js'

vi.mock('../../../src/ai/tasks/spec.js', () => ({ runSpec: vi.fn() }))

let bookRoot: string
let workDir: string

beforeEach(() => {
  workDir = makeDualTrackWorkdir()
  bookRoot = join(workDir, '长篇', LONG_BOOK)
  vi.mocked(runSpec).mockReset()
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function ctx(): ToolContext {
  return { bookRoot, bookName: LONG_BOOK, userDataPath: null }
}

describe('rewrite_chapter 入参校验', () => {
  it('缺 chapter → 拒绝', async () => {
    const r = await rewriteChapter(ctx(), { instruction: '压缩' })
    expect(r.ok).toBe(false)
  })
  it('缺 instruction → 拒绝', async () => {
    const r = await rewriteChapter(ctx(), { chapter: 1 })
    expect(r.ok).toBe(false)
  })
  it('章不存在 → 拒绝', async () => {
    const r = await rewriteChapter(ctx(), { chapter: 99, instruction: '压缩' })
    expect(r.ok).toBe(false)
  })
})

describe('rewrite_selection 入参校验', () => {
  it('缺 selection → 拒绝', async () => {
    const r = await rewriteSelection(ctx(), { chapter: 1, instruction: '改' })
    expect(r.ok).toBe(false)
  })
  it('选段不在正文 → 拒绝', async () => {
    const r = await rewriteSelection(ctx(), { chapter: 1, selection: '不存在的原文', instruction: '改' })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('未在')
  })
})

// ── RB-AI-P1-1：成功路径全文 spill（此前全文只余 600 字预览，确认后落盘物理不可达）──

describe('RB-AI-P1-1 改写全文 spill 落盘', () => {
  it('rewrite_chapter 成功 → 全文写入 工作区/spills，summary 含路径与字数', async () => {
    const produced = '改写后的第 1 章全文。' + '新稿内容。'.repeat(200)
    vi.mocked(runSpec).mockResolvedValue({
      ok: true,
      data: { input: { '正文': produced }, text: '', stopReason: 'tool_use' },
      ctrl: new AbortController(),
      usage: null,
      runId: 'rb-ai-p1-1',
      model: null,
    })
    const r = await rewriteChapter(ctx(), { chapter: 1, instruction: '压缩' })
    expect(r.ok).toBe(true)
    const spillDir = join(bookRoot, '工作区', 'spills')
    const files = readdirSync(spillDir).filter((f) => f.endsWith('.md'))
    expect(files).toHaveLength(1)
    expect(readFileSync(join(spillDir, files[0]!), 'utf8')).toBe(produced)
    // M-3：sidecar 溯源同落（章号 + 基线指纹）
    expect(readdirSync(spillDir)).toContain(files[0]!.replace(/\.md$/, '.meta.json'))
    expect(r.summary).toContain('工作区/spills/')
    expect(r.summary).toContain(String(produced.length))
    expect(r.summary).toContain('【未保存】')
  })

  it('rewrite_selection 成功 → spill 拼回后的全文（第九轮 H-1：选段稿不得单独成文）', async () => {
    const produced = '改写后的选段。' + '润色稿。'.repeat(200)
    vi.mocked(runSpec).mockResolvedValue({
      ok: true,
      data: { input: { '正文': produced }, text: '', stopReason: 'tool_use' },
      ctrl: new AbortController(),
      usage: null,
      runId: 'rb-ai-p1-1',
      model: null,
    })
    const selection = '玉佩在胸前微微发光'
    const r = await rewriteSelection(ctx(), {
      chapter: 1,
      selection,
      instruction: '改',
    })
    expect(r.ok).toBe(true)
    const files = readdirSync(join(bookRoot, '工作区', 'spills')).filter((f) => f.endsWith('.md'))
    expect(files).toHaveLength(1)
    const spilled = readFileSync(join(bookRoot, '工作区', 'spills', files[0]!), 'utf8')
    // spill 是整章维度：选段前后的正文必须原样保留（旧实现只存选段稿 → apply_spill 整章覆盖）
    const body = readFileSync(join(bookRoot, '写作/正文/0001-初入宗门.md'), 'utf-8').split('---').pop()!.trim()
    const selStart = body.indexOf(selection)
    expect(spilled).toBe(body.slice(0, selStart) + produced + body.slice(selStart + selection.length))
    expect(r.summary).toContain('工作区/spills/')
    expect(r.summary).toContain(String(spilled.length))
  })

  it('rewrite_selection 选段出现多次 → 拒绝（AMBIGUOUS 同口径，第九轮 H-1 子项）', async () => {
    const selection = '玉佩在胸前微微发光'
    const chapterPath = join(bookRoot, '写作/正文/0001-初入宗门.md')
    const raw = readFileSync(chapterPath, 'utf-8')
    // 同选段在正文出现第二次 → 无法定位替换点
    const doubled = raw.replace(selection, selection + '\n' + selection)
    writeFileSync(chapterPath, doubled, 'utf-8')
    const r = await rewriteSelection(ctx(), { chapter: 1, selection, instruction: '改' })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('出现多次')
    writeFileSync(chapterPath, raw, 'utf-8')
  })
})

// ── 低-3（第十轮）：选段 raw 定位（与端点 X-P2-13 同口径）──
// 修复背景：工具侧先 .trim() 再定位——首尾空白被剥掉后定位串与正文不一致：
// trim 后的短串可能在正文别处再次出现（唯一性误判被拒），或定位到更早的错误出现处
// （拼回全文替换错位置）。端点 X-P2-13 的口径是 raw 串定位 + raw 串唯一性校验。

describe('低-3（第十轮）：rewrite_selection 选段 raw 定位（对齐端点 X-P2-13）', () => {
  const produced = '改写后的选段文本。'
  beforeEach(() => {
    vi.mocked(runSpec).mockResolvedValue({
      ok: true,
      data: { input: { '正文': produced }, text: '', stopReason: 'tool_use' },
      ctrl: new AbortController(),
      usage: null,
      runId: 'low3-raw',
      model: null,
    })
  })

  it('选段带首部空白（raw 唯一、trim 后多义）→ raw 串定位成功，不再误报「出现多次」', async () => {
    // 正文追加第二处裸引语：trim 后的「"你是新弟子？"」出现两次（多义），
    // raw 串「\n\n"你是新弟子？"」（段落首）仍唯一——旧实现 trim 定位会误拒
    const chapterPath = join(bookRoot, '写作/正文/0001-初入宗门.md')
    const rawFile = readFileSync(chapterPath, 'utf-8')
    writeFileSync(chapterPath, rawFile + '\n\n夜里他反复回想那句"你是新弟子？"，久久无法入睡。', 'utf-8')
    try {
      const selection = '\n\n"你是新弟子？"'
      const r = await rewriteSelection(ctx(), { chapter: 1, selection, instruction: '改' })
      expect(r.ok).toBe(true)
      // spill 拼回全文：替换点必须是 raw 串命中的段落首出现（含首部 \n\n 的完整跨度）
      const body = readFileSync(chapterPath, 'utf-8').split('---').pop()!.trim()
      const selStart = body.indexOf(selection)
      const files = readdirSync(join(bookRoot, '工作区', 'spills')).filter((f) => f.endsWith('.md'))
      expect(readFileSync(join(bookRoot, '工作区', 'spills', files[0]!), 'utf8')).toBe(
        body.slice(0, selStart) + produced + body.slice(selStart + selection.length),
      )
    } finally {
      writeFileSync(chapterPath, rawFile, 'utf-8')
    }
  })

  it('选段带尾部空白 → 拼回跨度按 raw 长度计（尾部空行不被重复保留）', async () => {
    // 选段以段末 \n\n 结尾：trim 实现会丢掉尾部空白导致 splice 跨度偏短、
    // 拼回后旧段落残留——raw 口径下完整跨度替换
    const selection = '忽然一颤。\n\n'
    const chapterPath = join(bookRoot, '写作/正文/0001-初入宗门.md')
    const r = await rewriteSelection(ctx(), { chapter: 1, selection, instruction: '改' })
    expect(r.ok).toBe(true)
    const body = readFileSync(chapterPath, 'utf-8').split('---').pop()!.trim()
    const selStart = body.indexOf(selection)
    expect(selStart).toBeGreaterThanOrEqual(0)
    const files = readdirSync(join(bookRoot, '工作区', 'spills')).filter((f) => f.endsWith('.md'))
    const spilled = readFileSync(join(bookRoot, '工作区', 'spills', files[0]!), 'utf8')
    expect(spilled).toBe(body.slice(0, selStart) + produced + body.slice(selStart + selection.length))
    // 尾部空行不重复：produced 之后直接接「林远点头」段，中间只保留原有的一条 \n\n
    expect(spilled).toContain(produced + '林远点头')
  })
})


// ── GG-P2-2：apply_spill 确认落盘通道（「确认满意后再说一声」承诺的兑现件）──

describe('apply_spill 确认落盘', () => {
  it('合法 locator → 全文替换正文落盘，front matter 原样保留', async () => {
    const chapterPath = join(bookRoot, '写作/正文/0001-初入宗门.md')
    const before = readFileSync(chapterPath, 'utf-8')
    expect(before).toContain('章号: 1') // fixture 带fm
    const produced = '确认后的改写全文。' + '新内容。'.repeat(50)
    const locator = writeSpillFile(bookRoot, produced, metaFor(1))!
    const r = await applySpill(ctx(), { chapter: 1, locator })
    expect(r.ok).toBe(true)
    const after = readFileSync(chapterPath, 'utf-8')
    expect(after).not.toContain(before.split('---').pop()!.trim().slice(0, 10)) // 旧正文已被替换
    expect(after).toContain('确认后的改写全文。')
    expect(after).toContain('章号: 1') // fm 保留（未随 body 丢失）
  })
  it('locator 形状不合法 → 拒绝（路径穿越防御）', async () => {
    const r = await applySpill(ctx(), { chapter: 1, locator: '工作区/spills/../../book.yaml' })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('路径不合法')
  })
  it('locator 不存在 → 拒绝', async () => {
    const r = await applySpill(ctx(), { chapter: 1, locator: '工作区/spills/0123456789abcdef.md' })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('不存在')
  })
  it('章不存在 → 拒绝', async () => {
    const produced = 'x'
    const locator = writeSpillFile(bookRoot, produced, metaFor(1))!
    const r = await applySpill(ctx(), { chapter: 99, locator })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('不存在')
  })
})

// ── M-3（第十轮）：apply_spill 溯源校验（归属 / 新鲜度 / 无 meta fail-closed）──

/** 与 src 侧 rewriteMeta 同式：章号 + 当前第 1 章正文 sha256 */
function metaFor(chapter: number) {
  const raw = readFileSync(join(bookRoot, '写作/正文/0001-初入宗门.md'), 'utf-8')
  const body = raw.split('---').pop()!.trim()
  return { kind: 'rewrite' as const, chapter, baseSha: createHash('sha256').update(body, 'utf8').digest('hex') }
}

describe('M-3（第十轮）：apply_spill 归属与新鲜度校验', () => {
  it('归属不符（spill 产自第 1 章，请求落第 2 章）→ 拒绝且第 2 章正文不动', async () => {
    const ch2Path = join(bookRoot, '写作/正文/0002-玉佩之秘.md')
    const ch2Before = readFileSync(ch2Path, 'utf-8')
    const produced = '第 1 章的改写全文。' + '内容。'.repeat(50)
    const locator = writeSpillFile(bookRoot, produced, metaFor(1))!
    const r = await applySpill(ctx(), { chapter: 2, locator })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('归属校验失败')
    expect(r.summary).toContain('第 1 章')
    expect(readFileSync(ch2Path, 'utf-8')).toBe(ch2Before) // 目标章未被覆写
  })

  it('新鲜度不符（改写后作者编辑了该章）→ 拒绝落盘防覆盖新编辑', async () => {
    const chapterPath = join(bookRoot, '写作/正文/0001-初入宗门.md')
    const before = readFileSync(chapterPath, 'utf-8')
    const produced = '基于旧正文的改写稿。' + '内容。'.repeat(50)
    const locator = writeSpillFile(bookRoot, produced, metaFor(1))!
    // 模拟作者在改写确认窗口内编辑该章（正文变化 → 基线指纹失配）
    writeFileSync(chapterPath, before.replace('玉佩', '古镜'), 'utf-8')
    const r = await applySpill(ctx(), { chapter: 1, locator })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('新鲜度校验失败')
    expect(readFileSync(chapterPath, 'utf-8')).toContain('古镜') // 新编辑未被覆盖
    writeFileSync(chapterPath, before, 'utf-8')
  })

  it('无溯源 meta（chat 上下文 spill / 手写文件）→ fail-closed 拒绝', async () => {
    const produced = '来历不明的全文。' + '内容。'.repeat(50)
    const locator = writeSpillFile(bookRoot, produced)! // 不带 meta（spillIfLarge 同款形态）
    const r = await applySpill(ctx(), { chapter: 1, locator })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('溯源')
  })

  it('工具链路端到端：rewrite_chapter 落 spill 带 meta → 同章未编辑 apply 成功', async () => {
    const produced = '端到端改写稿。' + '内容。'.repeat(100)
    vi.mocked(runSpec).mockResolvedValue({
      ok: true,
      data: { input: { '正文': produced }, text: '', stopReason: 'tool_use' },
      ctrl: new AbortController(),
      usage: null,
      runId: 'm3-e2e',
      model: null,
    })
    const rw = await rewriteChapter(ctx(), { chapter: 1, instruction: '压缩' })
    expect(rw.ok).toBe(true)
    const locator = rw.summary.match(/工作区\/spills\/[0-9a-f]{16}\.md/)![0]
    const r = await applySpill(ctx(), { chapter: 1, locator })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(bookRoot, '写作/正文/0001-初入宗门.md'), 'utf-8')).toContain('端到端改写稿。')
  })
})

// ── R64-6（十二轮）：预览切片与字数换码点口径（slice 会劈开增补平面代理对） ──

describe('R64-6：改写预览码点口径（孤立代理对不出现、字数按码位）', () => {
  it('rewrite_chapter：第 600 码位边界落在增补平面字符上 → 完整保留该字符、计数 619 非 639', async () => {
    // 599 个 BMP 字符 + 20 个增补平面字符（各 2 码元）：码位 619、码元 639；
    // 旧 slice(0,600) 恰把第 600 码元劈成孤立高代理
    const produced = '前'.repeat(599) + '\u{1D11E}'.repeat(20)
    vi.mocked(runSpec).mockResolvedValue({
      ok: true,
      data: { input: { '正文': produced }, text: '', stopReason: 'tool_use' },
      ctrl: new AbortController(),
      usage: null,
      runId: 'r64-6',
      model: null,
    })
    const r = await rewriteChapter(ctx(), { chapter: 1, instruction: '压缩' })
    expect(r.ok).toBe(true)
    // 精确锚定预览：599 前 + 1 个完整 𝄞（第 600 码位）接省略行——孤立代理对会在此现形
    expect(r.summary).toContain('新稿开头：\n\n' + '前'.repeat(599) + '\u{1D11E}\n……（全文共 619 字）')
    expect(r.summary).toContain('（619 字）') // unsavedNote 同码点口径（非 639）
  })

  it('rewrite_selection：同款边界 → 预览完整字符、计数按码位', async () => {
    const produced = '稿'.repeat(599) + '\u{1D11E}'.repeat(20)
    vi.mocked(runSpec).mockResolvedValue({
      ok: true,
      data: { input: { '正文': produced }, text: '', stopReason: 'tool_use' },
      ctrl: new AbortController(),
      usage: null,
      runId: 'r64-6',
      model: null,
    })
    const r = await rewriteSelection(ctx(), { chapter: 1, selection: '玉佩在胸前微微发光', instruction: '改' })
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('选段改写完成：\n\n' + '稿'.repeat(599) + '\u{1D11E}\n……（改写稿共 619 字）')
  })
})
