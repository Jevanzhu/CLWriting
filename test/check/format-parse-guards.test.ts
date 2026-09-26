/**
 * format 层解析守卫（机检输入侧）：境界边界 / yaml 段头直挂 / frontmatter 同名键 /
 * 铁律缓存拷贝 / 分句半角标点。
 *
 * 档源：原 r27-batch-b.test.ts（二十七轮修复批 B）——R27-25（围栏）与 R27-23
 * （maxAdjStack 夹取）按被测行为分别并入 section-count-fence.test.ts 与
 * adjstack-backtrack-guard.test.ts，余下五组同属「format 解析面守卫」一族成档；
 * 断言逐条保留、去重 0 条。
 *
 * - R27-22 isRealmBoundary 缺直角/弯引号：引述形态「筑基」「元婴” 的闭合引号不
 *   在边界集，证据提取整类失败 → 测引述前后邻均命中、提取成功。
 * - R27-24 段头直挂块列表：leads: 下直接 - 项被拼进段 value，子键读取全落空且
 *   零警告 → 测顶层段直挂 warn 留痕、合法缩进子键挂法不 warn。
 * - R27-26（parseFlat 同名键后胜留痕）——R27-28（注释口径）为纯注释改动不设测。
 * - R27-27 readIronRules 缓存浅拷贝漏 unparsedBannedEntries：调用方 mutate 污染
 *   缓存（与函数头承诺不符）→ 测返回数组 mutate 后二次读取不受污染。
 * - R27-29 splitSentences 不切半角 !?：中英混排句长虚高 → 测半角收尾照切、
 *   includeColon 变体含 ；+ ! 组合口径。
 *
 * 并入档：原 r31b-machine-correctness.test.ts（三十一轮）的 R31-2 组（front matter /
 * book.yaml 键位冒号双认 `:`/`：` + patchFlatFm 原地更新——R35-21 冒号双认家族的
 * format 层面）、R31-10 组（分句纳入省略号）、R31-15 组（章号安全守卫 fail-loud）、
 * R31-18 组（ngram 滑窗 astral 码点路径）。R31-3 组并入
 * rebuild-advisory-strict-red.test.ts、R31-13 组并入 lead-updates-evidence-guards.test.ts。
 * 去重 0 条。
 */
import { test, expect, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractExactRealmFromEvidence } from '../../src/format/realms.js'
import { readIronRules } from '../../src/format/iron-rules.js'
import { parseBookConfig } from '../../src/format/yaml.js'
import { parseFlat, patchFlatFm } from '../../src/format/frontmatter.js'
import { splitSentences, ngramRepeatRate } from '../../src/format/sentences.js'
import { readChapter } from '../../src/format/chapters.js'
import { readBookConfig } from '../../src/format/yaml.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const SEQ = ['炼气', '筑基', '金丹', '元婴']

// R27-22：引述形态的境界词（闭合直角/弯引号做后边界）照常提取
test('R27-22: isRealmBoundary 补直角/弯引号——「筑基」「元婴” 引述形态提取成功', () => {
  // 修复前：后邻是 」/” 不在边界集 → 整类返回 null
  expect(extractExactRealmFromEvidence('他终于懂了「筑基」二字的分量', SEQ)).toBe('筑基')
  expect(extractExactRealmFromEvidence('所谓“元婴”不过如此', SEQ)).toBe('元婴')
  expect(extractExactRealmFromEvidence('『金丹』？', SEQ)).toBe('金丹')
  // 前邻引号同样不构成连接语素误配；既有否定语义不回归
  expect(extractExactRealmFromEvidence('「伪金丹」', SEQ)).toBeNull()
  expect(extractExactRealmFromEvidence('突破至筑基', SEQ)).toBe('筑基')
})

// R27-24：顶层段头直挂块列表 warn 留痕（子键读取全落空的预防性提示）
test('R27-24: book.yaml 段头直挂块列表 warn，合法缩进挂法不 warn', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const r = parseBookConfig('leads:\n- 主线\n- 支线\n')
    expect(r.ok).toBe(true)
    // warn 留痕（未 initLogging 时镜像 console.warn）
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('直挂块列表'))).toBe(true)

    // 合法形态（列表型子键下挂）不产直挂 warn（悬念 为合法账本类，过 X-P3a 过滤）
    warnSpy.mockClear()
    const r2 = parseBookConfig('leads:\n  enabled:\n  - 悬念\n')
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.config.leads.enabled).toEqual(['悬念'])
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('直挂块列表'))).toBe(false)
  } finally {
    warnSpy.mockRestore()
  }
})

// R27-26：parseFlat 同名键后胜留痕（后胜语义不变，warn 可追溯）
test('R27-26: parseFlat 同名键 warn 且后值覆盖前值', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const m = parseFlat('标题: 旧名\n标题: 新名\n')
    expect(m.get('标题')).toBe('新名')
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('同名键') && String(c[0]).includes('标题'))).toBe(true)
    // 无重复不 warn
    parseFlat('标题: 唯一\n视角: 三称\n')
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('同名键')).length).toBe(1)
  } finally {
    warnSpy.mockRestore()
  }
})

// R27-27：readIronRules 缓存命中拷贝含 unparsedBannedEntries——mutate 不污染缓存
test('R27-27: readIronRules 缓存返回值 mutate unparsedBannedEntries 不污染二次读取', () => {
  const root = mkdtempTracked(join(tmpdir(), 'iron-rules-cache-'))
  mkdirSync(join(root, '文风', '条目', '禁词'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '单句上限字数: 60\n', 'utf-8')
  // 正文行以 > 开头 → parseBannedWordsLine 返回空 → 整条进 unparsedBannedEntries
  writeFileSync(
    join(root, '文风', '条目', '禁词', '失明-001.md'),
    '---\n类型: 禁词\n场景: 失明场景\n---\n\n> 示例说明性文字，不构成禁词\n',
    'utf-8',
  )
  const first = readIronRules(root)
  expect(first.unparsedBannedEntries).toEqual(['失明场景'])
  // 调用方 mutate（污染注入）
  first.unparsedBannedEntries!.push('污染值')
  // 同指纹二次读取走缓存——不得见到污染值
  const second = readIronRules(root)
  expect(second.unparsedBannedEntries).toEqual(['失明场景'])
})

// R27-29：splitSentences 补半角 !?——中英混排收尾照切
test('R27-29: splitSentences 半角 !/参与切句，半角句号不切', () => {
  expect(splitSentences('他顿住!太快了。真的?是。')).toEqual(['他顿住', '太快了', '真的', '是'])
  // 半角 . 不切（小数/缩写保护）：3.14 不断句
  expect(splitSentences('数值是3.14没错')).toEqual(['数值是3.14没错'])
  // includeColon 变体：；与 ! 同切
  expect(splitSentences('第一；第二!', true)).toEqual(['第一', '第二'])
})

// ── R31-2（并入档）：front matter / book.yaml 键位冒号双认 `:`/`：` ──
// 手写全角冒号键行（`章号：152`、`title：测试`）此前整行静默跳过 → 整章必填字段
// 假缺 / 配置键丢失；patchFlatFm 同口径（否则全角键行被当不存在走追加分支造成同键重复）。

test('R31-2: 章 fm 全角冒号键行可读（不再假缺必填字段）', () => {
  const fm = '---\n章号：7\n标题：夜行\n钩子类型：悬念钩\n钩子强弱：中\n情绪定位：铺垫\n---\n\n正文。\n'
  const r = readChapter(join(tmpdir(), 'nonexist-fm.md'), true, fm)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.chapter.章号).toBe(7)
    expect(r.chapter.标题).toBe('夜行')
  }
})

test('R31-2: 半角冒号行为不变 + 值中全角冒号不误切', () => {
  const r = readChapter(
    join(tmpdir(), 'nonexist-fm.md'),
    true,
    '---\n章号: 8\n标题: 夜行\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n备注: 时间：子夜\n---\n\n正文。\n',
  )
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.chapter.章号).toBe(8)
    expect(String(r.chapter._raw?.['备注'])).toBe('时间：子夜')
  }
})

test('R31-2: book.yaml 全角冒号键可读（parseSections 同口径）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'yaml-fullwidth-colon-'))
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

// ── R31-10 / R31-18（并入档）：分句省略号边界 + ngram astral 码点路径 ──

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

// ── R31-15（并入档）：章号安全守卫 ────────────────────────────

test('R31-15: 章号负数/超安全整数 → fail-loud 格式错误', () => {
  for (const fm of [
    '---\n章号: -3\n标题: 夜行\n---\n\n正文。\n',
    '---\n章号: 99999999999999999999\n标题: 夜行\n---\n\n正文。\n',
  ]) {
    const r = readChapter(join(tmpdir(), 'nonexist-fm.md'), true, fm)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('章号格式不符')
  }
  // 合法章号不受影响
  expect(
    readChapter(
      join(tmpdir(), 'nonexist-fm.md'),
      true,
      '---\n章号: 1\n标题: 夜行\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文。\n',
    ).ok,
  ).toBe(true)
})
