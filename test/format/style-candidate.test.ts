/**
 * 文风候选箱单测（文风系统重整 S4）：往返 / 过期 / 确认忽略 / 四源转换 / 查重落盘。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readCandidate,
  writeCandidate,
  readCandidates,
  effectiveStatus,
  addCandidate,
  confirmCandidate,
  ignoreCandidate,
  aggregateSignals,
  mapDriftsToCandidates,
  mapAnalysisToCandidates,
  persistCandidates,
  CANDIDATES_DIR,
  type StyleCandidate,
  type DocSignals,
} from '../../src/format/style-candidate.js'
import { collectDocSignals } from '../../src/process/style-harvest.js'
import { addEntry, readEntries, ENTRIES_DIR } from '../../src/format/style-entry.js'
import { recordAiVersion } from '../../src/git/ai-track.js'
import { git } from '../../src/git/exec.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-candidate-'))
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const sampleCandidate: StyleCandidate = {
  类型: '样章',
  场景: '通用',
  来源: '改稿行为',
  正文: '他把烟摁灭。「说吧。」',
  状态: '待确认',
  创建: '2026-07-31',
  章号: 42,
  相似度: 31,
  AI版: '他深吸一口气，缓缓开口，眼中闪过一丝复杂的神色。',
}

describe('候选读写往返', () => {
  it('样章候选全字段往返（含 AI版 证据节 / 章号 / 相似度）', () => {
    const fp = join(root, 'c.md')
    writeCandidate(fp, sampleCandidate)
    const r = readCandidate(fp)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.candidate.类型).toBe('样章')
    expect(r.candidate.正文).toBe(sampleCandidate.正文)
    expect(r.candidate.AI版).toBe(sampleCandidate.AI版)
    expect(r.candidate.章号).toBe(42)
    expect(r.candidate.相似度).toBe(31)
    expect(r.candidate.创建).toBe('2026-07-31')
    expect(r.candidate.状态).toBe('待确认')
  })

  it('禁词候选（频次）往返；缺省容错：场景通用/来源收割/状态待确认', () => {
    const fp = join(root, 'b.md')
    writeCandidate(fp, {
      类型: '禁词',
      场景: '通用',
      来源: '改稿行为',
      正文: '深吸一口气',
      状态: '待确认',
      创建: '2026-07-31',
      频次: 6,
    })
    const r = readCandidate(fp)
    expect(r.ok && r.candidate.频次).toBe(6)
    expect(r.ok && r.candidate.AI版).toBeUndefined()

    // 手拼最简 fm：只有类型+正文
    const fp2 = join(root, 'm.md')
    writeCandidate(fp2, { 类型: '手法', 场景: '', 来源: '导入', 正文: 'x', 状态: '待确认', 创建: '' })
    const raw = readFileSync(fp2, 'utf-8').replace('来源: 导入', '来源: 天上掉的')
    rmSync(fp2)
    const fp3 = join(root, 'n.md')
    writeFileSync(fp3, raw, 'utf-8')
    const r3 = readCandidate(fp3)
    expect(r3.ok && r3.candidate.场景).toBe('通用')
    expect(r3.ok && r3.candidate.来源).toBe('收割')
    expect(r3.ok && r3.candidate.状态).toBe('待确认')
  })

  it('类型非法 → 结构化错误；候选目录不存在 → 空', () => {
    const fp = join(root, 'bad.md')
    writeCandidate(fp, { ...sampleCandidate })
    const raw = readFileSync(fp, 'utf-8').replace('类型: 样章', '类型: 妙笔')
    writeFileSync(fp, raw, 'utf-8')
    expect(readCandidate(fp).ok).toBe(false)
    expect(readCandidates(join(root, '不存在')).candidates).toHaveLength(0)
  })
})

describe('effectiveStatus 过期', () => {
  const base: StyleCandidate = { ...sampleCandidate, 创建: '2026-07-01' }
  it('30 天内待确认；超 30 天呈现已忽略；已忽略/无创建原样', () => {
    expect(effectiveStatus(base, '2026-07-31')).toBe('待确认') // 恰 30 天不过期
    expect(effectiveStatus(base, '2026-08-01')).toBe('已忽略') // 31 天
    expect(effectiveStatus({ ...base, 状态: '已忽略' }, '2026-07-02')).toBe('已忽略')
    expect(effectiveStatus({ ...base, 创建: '' }, '2027-01-01')).toBe('待确认')
  })
})

describe('确认 / 忽略', () => {
  it('addCandidate 落盘 <源>-<ulid>.md；confirm → 条目库 + 删候选 + 出处=第N章', () => {
    const rel = addCandidate(root, sampleCandidate)
    expect(rel).toMatch(/^文风\/候选\/改稿行为-[0-9A-Z]{26}\.md$/)
    const entryPath = confirmCandidate(root, rel)
    expect(entryPath).toBe(`${ENTRIES_DIR}/样章/通用-001.md`)
    expect(existsSync(join(root, rel))).toBe(false)
    const { entries } = readEntries(join(root, ENTRIES_DIR))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.正文).toBe(sampleCandidate.正文)
    expect(entries[0]!.出处).toBe('第42章')
    expect(entries[0]!.来源).toBe('改稿行为')
  })

  it('ignore：状态落盘已忽略，文件保留；confirm 读不出 → null', () => {
    const rel = addCandidate(root, sampleCandidate)
    expect(ignoreCandidate(root, rel)).toBe(true)
    const r = readCandidate(join(root, rel))
    expect(r.ok && r.candidate.状态).toBe('已忽略')
    expect(existsSync(join(root, rel))).toBe(true)
    expect(confirmCandidate(root, '文风/候选/不存在.md')).toBeNull()
  })

  it('M-7：穿越 / 书外绝对路径 / symlink 越出 → confirm null + ignore false（内层统一委托 resolveWithinRoot）', () => {
    // 字面穿越
    expect(confirmCandidate(root, '../outside.md')).toBeNull()
    expect(ignoreCandidate(root, '文风/候选/../../outside.md')).toBe(false)
    // 书外绝对路径
    expect(confirmCandidate(root, '/etc/passwd')).toBeNull()
    // symlink：字面路径在候选目录内、realpath 指向书外——旧手写 relative 检查放行，
    // confirm 会把书外文件内容读入条目库
    const outside = join(root, '..', 'clwriting-candidate-outside.md')
    writeFileSync(outside, '书外内容', 'utf8')
    const linkRel = addCandidate(root, sampleCandidate)
    rmSync(join(root, linkRel))
    symlinkSync(outside, join(root, linkRel))
    try {
      expect(confirmCandidate(root, linkRel)).toBeNull()
      expect(ignoreCandidate(root, linkRel)).toBe(false)
      expect(existsSync(outside)).toBe(true) // 书外目标未被触碰
    } finally {
      rmSync(outside, { force: true })
    }
  })
})

describe('源1 · 改稿轨迹', () => {
  // 段1 微调（surface，供词级）；段2 作者全重写 ≥50 字（gap → 样章候选）
  const P1_AI =
    '他深吸一口气，推开大门。院子里静得出奇，落叶铺了一地，墙角的灯笼在风里轻轻摇晃，映出一圈昏黄的光。他放轻脚步，沿着回廊往里走，每一步都踩在自己的心跳上。'
  const P1_AU = P1_AI.replace('他深吸一口气，', '他顿了顿，')
  const P2_AI =
    '他心中涌起一股难以言喻的感动，这一刻他终于明白了坚持的意义，原来所有的付出都是值得的。'
  const P2_AU =
    '巷口的馄饨摊还亮着一盏昏灯，老板娘往锅里下了最后一把面，蒸汽腾起来，糊住了她半张脸。他数出六个铜板放在案上，没说话。'

  it('collectDocSignals：gap 段 + surface 词级信号；无轨迹 → null', () => {
    git(['init'], root)
    git(['config', 'user.email', 't@t.com'], root)
    git(['config', 'user.name', 't'], root)
    recordAiVersion(root, 'doc_A', `${P1_AI}\n\n${P2_AI}`)
    const s = collectDocSignals(root, 'doc_A', `${P1_AU}\n\n${P2_AU}`, 42)
    expect(s).not.toBeNull()
    expect(s!.章号).toBe(42)
    expect(s!.gapParas).toHaveLength(1)
    expect(s!.gapParas[0]!.authorPara).toBe(P2_AU)
    expect(s!.missing.some((g) => g.includes('深吸'))).toBe(true)
    expect(collectDocSignals(root, 'doc_没轨迹', '正文')).toBeNull()
  })

  it('aggregateSignals：gap → 样章候选（证据齐）；missing 跨 3 档 → 禁词候选', () => {
    const mk = (docId: string, missing: string[]): DocSignals => ({ docId, gapParas: [], missing })
    const signals: DocSignals[] = [
      {
        docId: 'doc_A',
        章号: 42,
        gapParas: [{ authorPara: P2_AU, aiPara: P2_AI, sim: 0.31 }],
        missing: ['深吸一口气'],
      },
      mk('doc_B', ['深吸一口气', '缓缓']),
      mk('doc_C', ['深吸一口气']),
    ]
    const out = aggregateSignals(signals, '2026-07-31', 3)
    const sample = out.find((c) => c.类型 === '样章')
    expect(sample).toEqual(expect.objectContaining({ 类型: '样章', 正文: P2_AU, AI版: P2_AI, 相似度: 31 }))
    expect(sample!.AI版).toBe(P2_AI)
    expect(sample!.相似度).toBe(31)
    expect(sample!.章号).toBe(42)
    expect(sample!.来源).toBe('改稿行为')
    const banned = out.filter((c) => c.类型 === '禁词')
    expect(banned).toHaveLength(1) // 「缓缓」只 1 档，不过门槛
    expect(banned[0]!.正文).toBe('深吸一口气')
    expect(banned[0]!.频次).toBe(3)
  })
})

describe('源2 / 源3 转换', () => {
  it('漂移映射：三 metric 固定话术，未知忽略，同 metric 去重，说明=证据', () => {
    const out = mapDriftsToCandidates(
      [
        { metric: 'dialogueTag', message: '对话标签占比连续 5 章超 0.5' },
        { metric: 'dialogueTag', message: '重复漂移' },
        { metric: 'variance', message: '句长方差后段攀升' },
        { metric: 'unknown', message: 'x' },
      ],
      '2026-07-31',
    )
    expect(out).toHaveLength(2)
    expect(out[0]!.类型).toBe('手法')
    expect(out[0]!.正文).toBe('对话不用提示语，用动作断句')
    expect(out[0]!.说明).toBe('对话标签占比连续 5 章超 0.5')
    expect(out[0]!.来源).toBe('收割')
  })

  it('分析转换：口癖→禁词、建议→手法、空串滤除', () => {
    const out = mapAnalysisToCandidates(
      { 口癖: ['竟然', '  ', '仿佛'], 建议: ['开头别用天气起手'] },
      '2026-07-31',
    )
    expect(out.filter((c) => c.类型 === '禁词').map((c) => c.正文)).toEqual(['竟然', '仿佛'])
    expect(out.filter((c) => c.类型 === '手法')).toHaveLength(1)
  })
})

describe('persistCandidates 查重闸', () => {
  it('重复收割不再骚扰：候选箱已有（含已忽略）/ 条目库已有 / 本批内重复 → 跳过', () => {
    const banned: StyleCandidate = {
      类型: '禁词',
      场景: '通用',
      来源: '改稿行为',
      正文: '深吸一口气',
      状态: '待确认',
      创建: '2026-07-31',
      频次: 3,
    }
    const first = persistCandidates(root, [banned, { ...banned }]) // 本批内重复
    expect(first.created).toHaveLength(1)
    expect(first.skipped).toBe(1)

    // 作者忽略后再收割 → 仍跳过
    expect(ignoreCandidate(root, first.created[0]!)).toBe(true)
    const second = persistCandidates(root, [banned])
    expect(second.created).toHaveLength(0)
    expect(second.skipped).toBe(1)

    // 条目库已有同正文 → 跳过
    addEntry(root, { 类型: '禁词', 场景: '通用', 来源: '作者标注', 正文: '缓缓' })
    const third = persistCandidates(root, [{ ...banned, 正文: '缓缓' }])
    expect(third.created).toHaveLength(0)
    expect(third.skipped).toBe(1)

    // 候选目录内文件数 = 1（只有最初那条）
    expect(readdirSync(join(root, CANDIDATES_DIR)).filter((f) => f.endsWith('.md'))).toHaveLength(1)
  })
})
