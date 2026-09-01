/**
 * 三十三轮修复批 B 组回归（R33-1 / R33-5 / R33-6 / R33-29 / R33-30 / R33-32）。
 *
 * 根因-语义-测法：
 * - R33-1 围栏剥除正则无 m 标志：CRLF 文件按 \n 切行后行尾残留 \r，`.` 不匹配 \r 且
 *   $ 只认串尾 → "```js\r" 匹配失败 → fence 恒 null → 围栏内 ## 全计节数（win 主平台
 *   R27-25 语义整体反转，短篇 strict 假红拦定稿）。修复 = 尾部 `\r?`。测：CRLF 与 LF
 *   同内容同结果；开栏/闭栏/围栏内 ## 三态均含 \r。
 * - R33-5 兑现侧三态读：读失败（EISDIR 模拟瞬态占用）≠「明确无推进」——ok:false 让
 *   调用方跳过两端闭合（对齐声明侧 R70-15）；正常读与文件不存在仍 ok:true。
 * - R33-6 分组标题段前备注不折入：R75-2 只护住标题行本身，标题与首个后随条目之间的
 *   备注行此前折入上一条证据（污染→假红→持久落履历）。节终标题（后无条目）既有
 *   break 行为不回归。
 * - R33-29 SIMILE_RE 排他集补「群像」；R33-30 文件名前缀分隔符双侧；R33-32 开头窗口
 *   码点口径（astral 字符不再缩短窗口）。
 */
import { test, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSectionCount, checkOpeningNoEnv, checkFrontMatter, checkSimile } from '../../src/check/count.js'
import { parseLeadUpdateLines, readChapterUpdatesForChapterChecked } from '../../src/check/lead-updates.js'
import type { ChapterMeta } from '../../src/format/types.js'

const META = { 章号: 1, 标题: '开篇', 钩子类型: '悬念', 钩子强弱: '强', 情绪定位: '紧张' } as unknown as ChapterMeta

// ── R33-1：围栏剥除 CRLF 容忍 ────────────────────────────────

test('R33-1: CRLF 围栏内 ## 不计节（修复前整体反转），与 LF 同口径', () => {
  const lf = ['## 第一节', '正文。', '', '```md', '## 示例（围栏内）', '```', '', '## 第二节', '正文。'].join('\n')
  const crlf = lf.replaceAll('\n', '\r\n')
  // 围栏内 ## 示例 不计 → 恰 2 节守恒无黄；期望 3 → 报「正文 2 节」
  expect(checkSectionCount(lf, 2).items).toHaveLength(0)
  expect(checkSectionCount(crlf, 2).items).toHaveLength(0)
  expect(checkSectionCount(crlf, 3).items.find((it) => it.checkId === 'section-count')?.message).toContain('正文 2 节')
})

test('R33-1: CRLF 带信息串开栏 ```js\\r 与 \\r 闭栏行照常识别', () => {
  // 5 个真节 + 围栏内 1 个 ##：围栏内不计 → 恰 5 节守恒无黄（修复前围栏内 ## 计入 → 6 节假黄）
  const body = [
    '## 开头钩子', '钩子。', '', '```js', '## 代码内注释示例', 'const a = 1;', '```', '',
    '## 铺垫', '铺垫。', '', '## 升级', '升级。', '', '## 反转', '反转。', '', '## 余韵', '余韵。',
  ].join('\r\n')
  expect(checkSectionCount(body, 5).items).toHaveLength(0)
})

// ── R33-5：兑现侧三态读 ─────────────────────────────────────

test('R33-5: 读失败（EISDIR 瞬态占用模拟）→ unreadable:true；无文件 → 已读空推进', () => {
  const root = mkdtempSync(join(tmpdir(), 'r33-lead-'))
  try {
    // 无任何文件：已读、无推进（已知态，不跳过闭合）
    expect(readChapterUpdatesForChapterChecked(root, 3)).toEqual({ updates: [], unreadable: false })
    // 主文件被目录占用（readFileSync 对目录抛错）→ unreadable:true（修复前返回 [] 被
    // leadClosureItems 判「声明了没做」假红；win 线 {ok} 形状合并入 unreadable 形状）
    mkdirSync(join(root, '工作区', '账本推进.md'), { recursive: true })
    const r = readChapterUpdatesForChapterChecked(root, 3)
    expect(r.unreadable).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R33-6：分组标题段前备注不折入 ────────────────────────────

test('R33-6: 分组标题与后随条目之间的备注行不折入上一条证据', () => {
  const text = [
    '- 成长线-001 突破：他终于迈出了那一步',
    '## 备注',
    '手工备注内容不要污染证据',
    '- 悬念-002 树立：井底的灯又亮了',
  ].join('\n')
  const out = parseLeadUpdateLines(text)
  expect(out).toHaveLength(2)
  expect(out[0]!.证据).toBe('他终于迈出了那一步')
  expect(out[1]!.证据).toBe('井底的灯又亮了')
})

test('R33-6: 非标题场景的续行折入（R73-23）与节终标题 break（R75-2）不回归', () => {
  // R73-23 折入：无标题介入的多行证据仍折入
  expect(parseLeadUpdateLines('- A-1 兑现：第一句\n第二句续行')).toEqual([
    { leadId: 'A-1', 动词: '兑现', 证据: '第一句 第二句续行' },
  ])
  // R75-2 节终标题：标题后无条目 → 整节终止，不产生新条目
  expect(parseLeadUpdateLines('- A-1 兑现：证据在先\n## 手记\n散文备注')).toEqual([
    { leadId: 'A-1', 动词: '兑现', 证据: '证据在先' },
  ])
})

// ── R33-29 / R33-30 / R33-32 ────────────────────────────────

test('R33-29: 「群像」不再计入比喻密度', () => {
  expect(checkSimile('这幅群像描写刻画了众生。', 1).items).toHaveLength(0)
})

test('R33-30: 反斜杠路径的章号前缀识别（fm-chapter-mismatch）', () => {
  const items = checkFrontMatter(META, '正文\\0002-x.md').items
  expect(items.find((it) => it.checkId === 'fm-chapter-mismatch')).toBeDefined()
})

test('R33-32: 开头零环境窗口按码点截（astral 字符不缩短窗口）', () => {
  // 290 个 astral 码点 + 环境词落在 291-292 码点处（窗口 300 内）：
  // 修复前 UTF-16 slice(0,300) 只覆盖 150 码点 → 环境词落窗外不报；修复后按码点截足 300 → 报黄
  const filler = '𝄞'.repeat(290)
  const body = filler + '夜色渐深，环境词在此，后续正文继续。'
  const items = checkOpeningNoEnv(body, 300, ['夜色']).items
  expect(items.length).toBeGreaterThan(0)
})
