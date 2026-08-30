/**
 * 二十七轮修复批 B 回归（R27-22~25 / 27 / 29）——根因-语义-测法：
 * - R27-22 isRealmBoundary 缺直角/弯引号：引述形态「筑基」「元婴” 的闭合引号不
 *   在边界集，证据提取整类失败 → 测引述前后邻均命中、提取成功。
 * - R27-23 maxAdjStack 无上界：手滑多打 0 直通 `{N+1,}` 量词指数回退（实测秒级）
 *   → 测 200 夹到 20、常规值不变形。
 * - R27-24 段头直挂块列表：leads: 下直接 - 项被拼进段 value，子键读取全落空且
 *   零警告 → 测顶层段直挂 warn 留痕、合法缩进子键挂法不 warn。
 * - R27-25 节数计数吃代码围栏：设定块内 `## 示例` 被当节计入虚高 → 测围栏内
 *   标题不计、围栏外五段恰好守恒不产黄。
 * - R27-27 readIronRules 缓存浅拷贝漏 unparsedBannedEntries：调用方 mutate 污染
 *   缓存（与函数头承诺不符）→ 测返回数组 mutate 后二次读取不受污染。
 * - R27-29 splitSentences 不切半角 !?：中英混排句长虚高 → 测半角收尾照切、
 *   includeColon 变体含 ；+ ! 组合口径。
 * R27-26（parseFlat 同名键后胜留痕）与 R27-28（注释口径）分别锚在
 * frontmatter 与 imagery-seed——R27-26 测在本文件，R27-28 为纯注释改动不设测。
 */
import { test, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractExactRealmFromEvidence } from '../../src/format/realms.js'
import { parseIronRules, readIronRules } from '../../src/format/iron-rules.js'
import { parseBookConfig } from '../../src/format/yaml.js'
import { parseFlat } from '../../src/format/frontmatter.js'
import { splitSentences } from '../../src/format/sentences.js'
import { checkSectionCount } from '../../src/check/count.js'
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

// R27-23：maxAdjStack 夹取 [0,20]——手滑 200 不再直通指数量词
test('R27-23: parseIronRules maxAdjStack 上界夹取', () => {
  expect(parseIronRules('形容词连续堆叠上限: 200').maxAdjStack).toBe(20)
  expect(parseIronRules('形容词连续堆叠上限：3').maxAdjStack).toBe(3)
  // 未配置语义不变
  expect(parseIronRules('无配置文本').maxAdjStack).toBeUndefined()
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

// R27-25：节数计数剥代码围栏——设定块内 ## 示例不再虚高
test('R27-25: checkSectionCount 不计代码围栏内 ## 标题', () => {
  const body = [
    '## 开头钩子', '钩子正文。', '',
    '## 铺垫', '铺垫正文。', '',
    '```md', '## 示例结构一', '## 示例结构二', '```', '',
    '## 升级', '升级正文。', '',
    '## 反转', '反转正文。', '',
    '## 余韵', '余韵正文。',
  ].join('\n')
  const r = checkSectionCount(body, 5)
  // 修复前：围栏内 2 个 ## 计入 → 7 节黄项；修复后 5===5 无黄
  expect(r.items.find((it) => it.checkId === 'section-count')).toBeUndefined()

  // 对照：真实 4 节（围栏内标题不算数）仍按 4 报黄——剥围栏不掩盖真实缺失
  const body4 = [
    '## 开头钩子', '钩子正文。', '',
    '## 铺垫', '铺垫正文。', '',
    '```md', '## 示例结构一', '```', '',
    '## 升级', '升级正文。', '',
    '## 余韵', '余韵正文。',
  ].join('\n')
  const r4 = checkSectionCount(body4, 5)
  expect(r4.items.find((it) => it.checkId === 'section-count')?.message).toContain('正文 4 节')
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
  const root = mkdtempTracked(join(tmpdir(), '铁律缓存-'))
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
