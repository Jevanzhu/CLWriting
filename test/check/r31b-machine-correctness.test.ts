/**
 * R31-2 / R31-3 / R31-10 / R31-13 / R31-15 / R31-18（三十一轮）回归——
 *
 * - R31-2 [P2]：front matter / book.yaml 键位冒号双认 `:`/`：`——手写全角冒号键行
 *   （`章号：152`、`title：测试`）此前整行静默跳过 → 整章必填字段假缺 / 配置键丢失；
 *   patchFlatFm 同口径（否则全角键行被当不存在走追加分支造成同键重复）。
 * - R31-3 [P2]：账本推进「兑现侧」读失败 ≠「无推进」——细纲声明在而 账本推进.md
 *   不可读（chmod 000 模拟权限/瞬态占用）时，两端闭合跳过（不产 lead-declared-not-done
 *   红硬阻断定稿），改报 lead-updates-unreadable 黄（fail-noisy）。对齐声明侧 R70-15。
 * - R31-10：分句纳入省略号 …（`……` 连写等效单边界）。
 * - R31-13：证据针串最短 2 码位（1 字针串正文几乎恒命中 → 兑现判定 trivially 通过）。
 * - R31-15：章号安全守卫（负数/超安全整数 fail-loud）。
 * - R31-18：ngram 滑窗 astral 字符走码点路径（纯 BMP 快路径行为不变）。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readChapter } from '../../src/format/chapters.js'
import { readBookConfig } from '../../src/format/yaml.js'
import { patchFlatFm } from '../../src/format/frontmatter.js'
import { splitSentences, ngramRepeatRate } from '../../src/format/sentences.js'
import { evidenceNeedles } from '../../src/check/leads.js'
import { runCheckForDocument } from '../../src/check/run.js'
import { getRedItems } from '../../src/check/runner.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// ── R31-2：全角冒号键行 ──────────────────────────────────────────────

test('R31-2: 章 fm 全角冒号键行可读（不再假缺必填字段）', () => {
  const fm = '---\n章号：7\n标题：夜行\n钩子类型：悬念钩\n钩子强弱：中\n情绪定位：铺垫\n---\n\n正文。\n'
  const r = readChapter(join(tmpdir(), 'r31-nonexist.md'), true, fm)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.chapter.章号).toBe(7)
    expect(r.chapter.标题).toBe('夜行')
  }
})

test('R31-2: 半角冒号行为不变 + 值中全角冒号不误切', () => {
  const r = readChapter(join(tmpdir(), 'r31-nonexist.md'), true, '---\n章号: 8\n标题: 夜行\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n备注: 时间：子夜\n---\n\n正文。\n')
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.chapter.章号).toBe(8)
    expect(String(r.chapter._raw?.['备注'])).toBe('时间：子夜')
  }
})

test('R31-2: book.yaml 全角冒号键可读（parseSections 同口径）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'r31-yaml-'))
  try {
    const fp = join(root, 'book.yaml')
    writeFileSync(fp, 'spec_version: 1\nkind: long\nbook:\n  title：全角书名\n', 'utf-8')
    const r = readBookConfig(fp)
    expect(r.ok).toBe(true)
    expect((r.config.book as { title?: string }).title).toBe('全角书名')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R31-2: patchFlatFm 对全角键行原地更新（不产生同键重复行）', () => {
  const fmRaw = '章号：7\n标题：旧名\n'
  const r = patchFlatFm(fmRaw, { 标题: '新名' })
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.text).toContain('标题: 新名')
    expect(r.text.match(/标题/g)).toHaveLength(1)
    expect(r.text).toContain('章号：7')
  }
})

// ── R31-3：兑现侧读失败降级 ─────────────────────────────────────────

/** 造一本有布线的完整书（同 two-end-closure 骨架） */
function makeWiringBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'r31-lead-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '写作', '正文', '001-夜访.md'),
    '---\n章号: 1\n标题: 夜访\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的钟声在雨夜里连响了三下。\n',
    'utf-8',
  )
  writeFileSync(join(root, '大纲', '章纲', '001-夜访.md'), '---\n章号: 1\n标题: 夜访\n---\n\n## 反转线索表\n- 核心反转：x\n', 'utf-8')
  return root
}

test.skipIf(process.platform === 'win32')('R31-3: 账本推进读失败 → 黄项降级，不产 declared-not-done 红', () => {
  const root = makeWiringBook()
  try {
    // 细纲声明 悬念-001（若兑现侧可读且无推进 → 本应红 lead-declared-not-done）
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: [悬念-001]\n---\n\n本章细纲。\n', 'utf-8')
    // 账本推进.md 在但不可读（chmod 000 模拟权限/瞬态占用；存在≠无推进）
    const ledger = join(root, '工作区', '账本推进.md')
    writeFileSync(ledger, '# 第1章 账本推进\n- 悬念-001 推进：钟声三响\n', 'utf-8')
    chmodSync(ledger, 0o000)
    try {
      const outcome = runCheckForDocument(root, join(root, '写作', '正文', '001-夜访.md'))
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      // 红闸不触发：清单未知不冒充「已声明未兑现」
      expect(getRedItems(outcome.report).some((i) => i.checkId === 'lead-declared-not-done')).toBe(false)
      // fail-noisy：降级黄项随报告透出
      const yellows = outcome.report.sections.flatMap((s) => s.items).filter((i) => i.level === 'yellow')
      expect(yellows.some((i) => i.checkId === 'lead-updates-unreadable')).toBe(true)
    } finally {
      chmodSync(ledger, 0o644)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R31-3: 文件不存在仍属「无推进」已知态（declared-not-done 红照常，未回归）', () => {
  const root = makeWiringBook()
  try {
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: [悬念-001]\n---\n\n本章细纲。\n', 'utf-8')
    const outcome = runCheckForDocument(root, join(root, '写作', '正文', '001-夜访.md'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(getRedItems(outcome.report).some((i) => i.checkId === 'lead-declared-not-done')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R31-10 / R31-18：分句与 ngram ───────────────────────────────────

test('R31-10: 省略号切句，……连写等效单边界', () => {
  expect(splitSentences('她想说什么……')).toEqual(['她想说什么'])
  expect(splitSentences('第一句。第二句……第三句！')).toEqual(['第一句', '第二句', '第三句'])
  // `……` 两个 … 相邻不产生空段
  expect(splitSentences('说不出口………只好沉默。')).toEqual(['说不出口', '只好沉默'])
})

test('R31-18: astral 字符句走码点取窗（纯 BMP 快路径行为不变）', () => {
  // 纯 BMP：行为与旧口径一致
  const bmp = '这是一段完全普通的中文文本，没有任何特殊符号。'
  expect(ngramRepeatRate(bmp).rate).toBe(0)
  // astral（emoji 代理对）不炸、码点成窗：同句重复 → 重复可测
  const astral = '他发了个😀表情，又发了个😀表情，最后还是发了😀表情，全是😀表情。'
  const r = ngramRepeatRate(astral)
  expect(Number.isFinite(r.rate)).toBe(true)
  expect(r.total).toBeGreaterThan(0)
})

// ── R31-13：证据针串最短 2 码位 ─────────────────────────────────────

test('R31-13: 1 字候选被过滤，≥2 候选保留；全 1 字时回退剥引号串 ≥2 才用', () => {
  // 「雪」无声 → inner='雪'（1 字，滤除）；edgeStripped='雪」无声'、allStripped='雪无声'
  // （均 ≥2 码位，保留——edgeStripped 内引号保留是 R63-8 既有多候选设计）
  expect(evidenceNeedles('「雪」无声')).toEqual(['雪」无声', '雪无声'])
  // 正常证据多候选不变（2+ 字都保留）
  const needles = evidenceNeedles('「雪落无声」')
  expect(needles).toContain('雪落无声')
  // 整条证据只剩 1 字 → 空数组（消费方按空针串口径：引文红闸 unverifiable 黄）
  expect(evidenceNeedles('「雪」')).toEqual([])
})

// ── R31-15：章号安全守卫 ────────────────────────────────────────────

test('R31-15: 章号负数/超安全整数 → fail-loud 格式错误', () => {
  for (const fm of ['---\n章号: -3\n标题: 夜行\n---\n\n正文。\n', '---\n章号: 99999999999999999999\n标题: 夜行\n---\n\n正文。\n']) {
    const r = readChapter(join(tmpdir(), 'r31-nonexist.md'), true, fm)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('章号格式不符')
  }
  // 合法章号不受影响
  expect(readChapter(join(tmpdir(), 'r31-nonexist.md'), true, '---\n章号: 1\n标题: 夜行\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文。\n').ok).toBe(true)
})
