/**
 * C2+C3+C4（批 3）上下文域收口测试：
 * - C2 卷摘要按需生成（章摘要链完整才生成 / 不完整 fail-closed / 链变动过期重生成）
 * - C3 细纲 prompt「当前卷进展」段（有卷摘要注入 / 缺失整段省略 / 第 1 卷无段）
 * - C4 token 系数（查表/前缀匹配/兜底）+ 拟合函数与报告快照
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateChapterSummary,
  generateVolumeSummary,
  selfHealVolumeSummary,
  volumeChainState,
  volumeSummaryPath,
  chapterSummaryPath,
  effectiveConfig,
} from '../../src/process/summary.js'
import { computeRevision } from '../../src/document/revision.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { volumeProgressOf, buildOutlinePrompt } from '../../src/studio/server/api/outline.js'
import { estimateTokens, TOKEN_COEFFICIENTS, DEFAULT_TOKEN_COEFF } from '../../src/process/prepare.js'
import { fitCoefficients, renderCalibrationReport, type CalibrationSample } from '../../src/ai/token-calibration.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

const dirs: string[] = []

beforeEach(() => {
  process.env['CLWRITING_DRIVER'] = 'mock'
})

afterEach(() => {
  delete process.env['CLWRITING_DRIVER']
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 造书：volumeSize=2（卷 1 = 章 1/2，卷 2 = 章 3/4……便于小规模测卷边界）；finalizedN 章落定稿基线 */
function makeBook(chapters: number, finalizedN: number, volumeSize = 2): string {
  const root = mkdtempSync(join(tmpdir(), 'clw-volumesum-'))
  dirs.push(root)
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    `spec_version: 1\nkind: long\nbook:\n  title: 卷摘要测试书\n  volume_size: ${volumeSize}\nhost: cc\nleads:\n  enabled: []\n`,
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= chapters; no++) {
    const pad = String(no).padStart(3, '0')
    const p = join(root, '写作', '正文', `${pad}-第${no}章.md`)
    writeFileSync(p, `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第${no}章正文。\n`, 'utf-8')
    const id = generateDocId()
    upsertEntry(m, { id, nodeType: 'document', path: `写作/正文/${pad}-第${no}章.md`, parentId: null })
    if (no <= finalizedN) {
      const e = m.entries.get(id)!
      e.finalizedRevision = computeRevision(p)
      e.finalizedAt = new Date().toISOString()
    }
  }
  writeManifest(manifestPath, m)
  return root
}

const bodyOf = (root: string, no: number): string => join(root, '写作', '正文', `${String(no).padStart(3, '0')}-第${no}章.md`)

async function genChapterSummaries(root: string, config: BookConfig, chapters: number[]): Promise<void> {
  for (const ch of chapters) {
    const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config, chapter: ch, bodyAbsPath: bodyOf(root, ch) })
    expect(r.ok).toBe(true)
  }
}

describe('C2 卷摘要按需生成', () => {
  it('章摘要链完整 → 生成卷摘要（fm volume + sourceHash 绑链指纹）', async () => {
    const root = makeBook(2, 2)
    await genChapterSummaries(root, DEFAULT_CONFIG, [1, 2])
    expect(volumeChainState(root, 1, 2)).toMatchObject({ missing: [] })
    const r = await generateVolumeSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, volume: 1 })
    expect(r.ok).toBe(true)
    const raw = readFileSync(volumeSummaryPath(root, 1), 'utf-8')
    expect(raw).toContain('volume: 1')
    expect(raw).toContain('sourceHash: sha256:')
    // 再次生成：链未变 → skipped
    const again = await generateVolumeSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, volume: 1 })
    expect(again.ok && again.skipped).toBe(true)
  })

  it('链不全（有定稿章缺章摘要）→ 不强行生成（二阶误差红线），missing 留痕', async () => {
    const root = makeBook(2, 2)
    await genChapterSummaries(root, DEFAULT_CONFIG, [1]) // 章 2 缺
    const st = volumeChainState(root, 1, 2)
    expect(st.chain).toBeNull()
    expect(st.missing).toEqual([2])
    const r = await generateVolumeSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, volume: 1 })
    expect(r.ok).toBe(false)
    expect(existsSync(volumeSummaryPath(root, 1))).toBe(false)
  })

  it('链变动（某章摘要重生成）→ 卷摘要过期重生成', async () => {
    const root = makeBook(2, 2)
    await genChapterSummaries(root, DEFAULT_CONFIG, [1, 2])
    await generateVolumeSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, volume: 1 })
    // 手动改章摘要内容（模拟重生成）→ 链指纹变
    writeFileSync(chapterSummaryPath(root, 1), '---\nchapter: 1\nsourceHash: 旧\n---\n新的第 1 章摘要内容。', 'utf-8')
    const r = await generateVolumeSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, volume: 1 })
    expect(r.ok && !r.skipped).toBe(true)
  })

  it('selfHealVolumeSummary：写作第 2 卷 → 上一卷缺失按需生成；已有（含手写）跳过；第 1 卷无上一卷', async () => {
    const root = makeBook(2, 2)
    const config = effectiveConfig(root, null) // 读 book.yaml 的 volume_size: 2
    await genChapterSummaries(root, config, [1, 2])
    // 章 3 属卷 2（volumeSize=2）→ 触发卷 1 生成
    const vol = await selfHealVolumeSummary(root, null, config, 3)
    expect(vol).toBe(join('定稿', '摘要', '卷摘要', '1.md'))
    expect(existsSync(volumeSummaryPath(root, 1))).toBe(true)
    // 已有 → null（不重复）
    expect(await selfHealVolumeSummary(root, null, config, 3)).toBeNull()
    // 第 1 卷写作中（章 1/2）→ 无上一卷
    expect(await selfHealVolumeSummary(root, null, config, 1)).toBeNull()
  })

  // ── M-7（第六轮）：过期重生成在本挂点可达；手写产物不受侵扰 ──

  it('M-7: 程序生成但链已变（章摘要更新）→ selfHealVolumeSummary 过期重生成', async () => {
    const root = makeBook(2, 2)
    const config = effectiveConfig(root, null)
    await genChapterSummaries(root, config, [1, 2])
    await selfHealVolumeSummary(root, null, config, 3) // 首次按需生成卷 1
    const before = readFileSync(volumeSummaryPath(root, 1), 'utf8')
    // 模拟章摘要重生成（链指纹变）——修复前此处因「文件存在」直接 return null，重生成不可达
    writeFileSync(chapterSummaryPath(root, 1), '---\nchapter: 1\nsourceHash: 旧\n---\n新的第 1 章摘要内容。', 'utf-8')
    const vol = await selfHealVolumeSummary(root, null, config, 3)
    expect(vol).toBe(join('定稿', '摘要', '卷摘要', '1.md'))
    const after = readFileSync(volumeSummaryPath(root, 1), 'utf8')
    expect(after).not.toBe(before)
    expect(after).toContain('sourceHash: sha256:') // 新链指纹落 fm
  })

  it('M-7: 手写卷摘要（无 sourceHash）→ 永不重生成，作者产物原样保留', async () => {
    const root = makeBook(2, 2)
    const config = effectiveConfig(root, null)
    await genChapterSummaries(root, config, [1, 2])
    const hand = '# 第 1 卷\n\n作者手写的卷摘要，一字不动。\n'
    mkdirSync(join(root, '定稿', '摘要', '卷摘要'), { recursive: true })
    writeFileSync(volumeSummaryPath(root, 1), hand, 'utf-8')
    expect(await selfHealVolumeSummary(root, null, config, 3)).toBeNull()
    expect(readFileSync(volumeSummaryPath(root, 1), 'utf8')).toBe(hand)
  })
})

describe('C3 细纲卷进展段', () => {
  it('有卷摘要 → 段注入 + file 登记；缺失 → 整段省略；第 1 卷 → 无段', async () => {
    const root = makeBook(2, 2)
    // 未生成卷摘要：第 1 卷 → null
    expect(volumeProgressOf(root, 1)).toEqual({ section: null, file: null })
    expect(volumeProgressOf(root, 2)).toEqual({ section: null, file: null })
    await genChapterSummaries(root, DEFAULT_CONFIG, [1, 2])
    await generateVolumeSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, volume: 1 })
    // 章 3（卷 2）→ 卷 1 摘要注入
    const p = volumeProgressOf(root, 3)
    expect(p.section).toContain('## 当前卷进展')
    expect(p.section).toContain('第 1 卷摘要')
    expect(p.file).toBe(join('定稿', '摘要', '卷摘要', '1.md'))
    // prompt 含该段
    const prompt = buildOutlinePrompt(root, 3, 'long')
    expect(prompt).toContain('## 当前卷进展')
    // 仍在卷 1 的章 → 不注入
    const promptVol1 = buildOutlinePrompt(root, 2, 'long')
    expect(promptVol1).not.toContain('## 当前卷进展')
  })
})

describe('C4 token 系数', () => {
  it('estimateTokens：默认 0.6；查表前缀最长命中；未知模型兜底', () => {
    expect(estimateTokens('abc')).toBe(Math.ceil(3 * DEFAULT_TOKEN_COEFF))
    // 表当前为空（未实测）——用注入方式验证查表逻辑
    TOKEN_COEFFICIENTS['claude-sonnet'] = 0.5
    TOKEN_COEFFICIENTS['claude-sonnet-4'] = 0.4
    try {
      expect(estimateTokens('abcd', 'claude-sonnet-4-5')).toBe(Math.ceil(4 * 0.4)) // 最长前缀
      expect(estimateTokens('abcd', 'claude-sonnet-3')).toBe(Math.ceil(4 * 0.5))
      expect(estimateTokens('abcd', 'gpt-x')).toBe(Math.ceil(4 * DEFAULT_TOKEN_COEFF)) // 兜底
      expect(estimateTokens('abcd')).toBe(Math.ceil(4 * DEFAULT_TOKEN_COEFF)) // 无模型
    } finally {
      delete TOKEN_COEFFICIENTS['claude-sonnet']
      delete TOKEN_COEFFICIENTS['claude-sonnet-4']
    }
  })

  it('fitCoefficients：过原点最小二乘 + 样本不足不给建议 + 脏样本过滤', () => {
    const samples: CalibrationSample[] = []
    // model-a：coeff=0.5 的 40 个干净样本
    for (let i = 1; i <= 40; i++) samples.push({ model: 'model-a', chars: i * 100, inputTokens: Math.round(i * 100 * 0.5) })
    // model-b：只有 5 个样本（< 30 → coeff null）
    for (let i = 1; i <= 5; i++) samples.push({ model: 'model-b', chars: i * 100, inputTokens: i * 60 })
    // 脏样本：chars=0 / tokens=0 丢弃
    samples.push({ model: 'model-a', chars: 0, inputTokens: 100 }, { model: 'model-a', chars: 100, inputTokens: 0 })
    const fits = fitCoefficients(samples)
    const a = fits.get('model-a')!
    expect(a.n).toBe(40)
    expect(a.coeff).toBeCloseTo(0.5, 6)
    expect(a.r).toBeCloseTo(1, 6)
    const b = fits.get('model-b')!
    expect(b.n).toBe(5)
    expect(b.coeff).toBeNull()
  })

  it('renderCalibrationReport：快照（表头/行/空态）', () => {
    const fits = fitCoefficients([
      { model: 'model-a', chars: 100, inputTokens: 50 },
      { model: 'model-a', chars: 200, inputTokens: 101 },
    ])
    const report = renderCalibrationReport(fits, '2026-08-20')
    expect(report).toContain('# token 系数校准报告（C4）')
    expect(report).toContain('| model-a | 2 | —（样本不足） |')
    const empty = renderCalibrationReport(new Map(), '2026-08-20')
    expect(empty).toContain('（无样本——事件库里没有可用的 llm/call 记账对）')
  })
})

// ── R65-31（第六十五轮）：卷摘要 sourceHash 重读失败降级（不直穿自愈链）────────

describe('R65-31: 卷摘要读失败降级', () => {
  it('selfHealVolumeSummary：卷摘要文件不可读（EACCES）→ 按手写产物跳过（null）且不覆盖不抛', async () => {
    const root = makeBook(2, 2)
    const config = effectiveConfig(root, null)
    await genChapterSummaries(root, config, [1, 2])
    await generateVolumeSummary({ bookRoot: root, userDataPath: null, config, volume: 1 })
    const fp = volumeSummaryPath(root, 1)
    const before = readFileSync(fp, 'utf8')
    chmodSync(fp, 0o000) // 自然故障注入：sourceHash 重读 EACCES
    try {
      // 修复前：裸 readFileSync 直穿抛 EACCES；修复后按手写产物降级（宁不动不可见文件）
      expect(await selfHealVolumeSummary(root, null, config, 3)).toBeNull()
    } finally {
      chmodSync(fp, 0o644)
    }
    // 文件内容原样未被覆盖
    expect(readFileSync(fp, 'utf8')).toBe(before)
  })

  it('generateVolumeSummary：卷摘要文件不可读（EACCES）→ 按缺失降级重生成（skipped 判定不再直穿）', async () => {
    const root = makeBook(2, 2)
    const config = effectiveConfig(root, null)
    await genChapterSummaries(root, config, [1, 2])
    await generateVolumeSummary({ bookRoot: root, userDataPath: null, config, volume: 1 })
    const fp = volumeSummaryPath(root, 1)
    chmodSync(fp, 0o000)
    try {
      // 修复前：existsSync 通过后裸 readFileSync 抛 EACCES；修复后按指纹不匹配降级走重生成
      const r = await generateVolumeSummary({ bookRoot: root, userDataPath: null, config, volume: 1 })
      expect(r.ok).toBe(true)
    } finally {
      chmodSync(fp, 0o644)
    }
  })
})
