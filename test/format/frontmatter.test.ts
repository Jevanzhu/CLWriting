import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseValue,
  stringifyValue,
  splitFrontMatter,
  bodyOf,
  parseFlat,
  stringifyFlat,
  joinFrontMatter,
  readFile,
  writeFile,
  parseRealmSystems,
  stringifyRealmSystems,
} from '../../src/format/frontmatter.js'

// ── 值类型推断 ──────────────────────────────────

test('parseValue: int / 数组 / 字符串', () => {
  expect(parseValue('12')).toBe(12)
  expect(parseValue('0')).toBe(0)
  expect(parseValue('[炼气, 筑基, 金丹]')).toEqual(['炼气', '筑基', '金丹'])
  expect(parseValue('[]')).toEqual([])
  expect(parseValue('伏笔-031')).toBe('伏笔-031')
  expect(parseValue('"带引号"')).toBe('带引号')
  expect(parseValue('')).toBe('')
})

test('stringifyValue: round-trip', () => {
  expect(stringifyValue(12)).toBe('12')
  expect(stringifyValue([1, 2, 3])).toBe('[1, 2, 3]')
  expect(stringifyValue('伏笔-031')).toBe('伏笔-031')
  // 纯数字串需加引号防歧义
  expect(stringifyValue('031')).toBe('"031"')
})

// ── front matter 提取 ──────────────────────────

test('splitFrontMatter: 提取头与正文', () => {
  const md = '---\n编号: 伏笔-031\n状态: 进行中\n---\n\n正文内容'
  const r = splitFrontMatter(md)
  expect(r).not.toBeNull()
  expect(r!.fmRaw).toBe('编号: 伏笔-031\n状态: 进行中')
  expect(r!.body).toBe('\n正文内容')
})

test('splitFrontMatter: 无 front matter 返回 null', () => {
  expect(splitFrontMatter('只有正文')).toBeNull()
  expect(splitFrontMatter('---\n没有闭合')).toBeNull()
})

// ── 平铺解析往返（#3 容错核心：未知字段保留、顺序不重排）────

test('parseFlat + stringifyFlat: 往返不丢字段、保留顺序', () => {
  const fmRaw = '编号: 伏笔-031\n标题: 灭门真凶\n类型: 伏笔\n状态: 进行中\n开启章: 12'
  const map = parseFlat(fmRaw)
  expect(map.get('编号')).toBe('伏笔-031')
  expect(map.get('开启章')).toBe(12)
  // 回写顺序不变
  expect(stringifyFlat(map)).toBe(fmRaw)
})

test('parseFlat: 未知字段原样保留', () => {
  const fmRaw = '编号: X-001\n未知字段: 保留我\n状态: 进行中'
  const map = parseFlat(fmRaw)
  expect(map.get('未知字段')).toBe('保留我')
  expect(stringifyFlat(map)).toBe(fmRaw)
})

// ── 文件读写（容错：坏文件不崩）──────────────────

test('readFile: 正常文件', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境的雪-'))
  const fp = join(dir, '伏笔-031-灭门真凶.md')
  writeFileSync(fp, '---\n编号: 伏笔-031\n---\n正文', 'utf-8')
  const r = readFile(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.fmRaw).toBe('编号: 伏笔-031')
    expect(r.body).toBe('正文')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('readFile: 坏文件返回结构化错误不崩', () => {
  // 不存在的文件
  const r1 = readFile(join(tmpdir(), '不存在-' + Date.now() + '.md'))
  expect(r1.ok).toBe(false)
  if (!r1.ok) {
    expect(typeof r1.error.file).toBe('string')
    expect(r1.error.message).toContain('无法读取')
  }

  // 无 front matter 的文件
  const dir = mkdtempSync(join(tmpdir(), '北境的雪-'))
  const fp = join(dir, '无头.md')
  writeFileSync(fp, '只有正文没有 front matter', 'utf-8')
  const r2 = readFile(fp)
  expect(r2.ok).toBe(false)
  if (!r2.ok) {
    expect(r2.error.message).toContain('front matter')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('writeFile + readFile 往返', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境的雪-'))
  const fp = join(dir, '伏笔-031.md')
  writeFile(fp, '编号: 伏笔-031\n开启章: 12', '正文在这里')
  const r = readFile(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.fmRaw).toBe('编号: 伏笔-031\n开启章: 12')
    expect(r.body).toBe('正文在这里')
  }
  rmSync(dir, { recursive: true, force: true })
})

// ── 境界体系嵌套（#6 第 2 节）────────────────────

test('parseRealmSystems: 嵌套体系数组', () => {
  const fmRaw = [
    '体系:',
    '  - 名称: 修真境界',
    '    序列: [炼气, 筑基, 金丹, 元婴]',
    '  - 名称: 武者等级',
    '    序列: [后天, 先天, 宗师]',
  ].join('\n')
  const systems = parseRealmSystems(fmRaw)
  expect(systems).toHaveLength(2)
  expect(systems[0]!.名称).toBe('修真境界')
  expect(systems[0]!.序列).toEqual(['炼气', '筑基', '金丹', '元婴'])
  expect(systems[1]!.名称).toBe('武者等级')
  expect(systems[1]!.序列).toEqual(['后天', '先天', '宗师'])
})

test('stringifyRealmSystems: 往返', () => {
  const systems = [
    { 名称: '修真境界', 序列: ['炼气', '筑基'] },
  ]
  const text = stringifyRealmSystems(systems)
  const reparsed = parseRealmSystems(text)
  expect(reparsed).toEqual(systems)
})

test('joinFrontMatter: 包裹完整 markdown', () => {
  expect(joinFrontMatter('编号: X', '正文')).toBe('---\n编号: X\n---\n正文')
  expect(joinFrontMatter('', '正文')).toBe('正文')
})

// ── 块标量多行值（fm 多行根治）────────────────────

test('parseFlat: 块标量 literal（key: |）保留换行', () => {
  const fmRaw = '标题: 短\n背景: |\n  第一行\n  第二行\n状态: 进行中'
  const map = parseFlat(fmRaw)
  expect(map.get('标题')).toBe('短')
  expect(map.get('背景')).toBe('第一行\n第二行')
  expect(map.get('状态')).toBe('进行中')
})

test('parseFlat: 块标量 folded（key: >）换行转空格', () => {
  const fmRaw = '摘要: >\n  一句话\n  接着说'
  const map = parseFlat(fmRaw)
  expect(map.get('摘要')).toBe('一句话 接着说')
})

test('stringifyFlat: 多行值用块标量', () => {
  const map = new Map<string, unknown>()
  map.set('标题', '短')
  map.set('背景', '第一行\n第二行')
  expect(stringifyFlat(map)).toBe('标题: 短\n背景: |\n  第一行\n  第二行')
})

test('块标量往返（parse → stringify → parse 一致）', () => {
  const map = new Map<string, unknown>()
  map.set('背景', '行1\n行2\n行3')
  const text = stringifyFlat(map)
  const reparsed = parseFlat(text)
  expect(reparsed.get('背景')).toBe('行1\n行2\n行3')
})

test('旧平铺 fm（无块标量）parseFlat 不受影响', () => {
  const fmRaw = '编号: 伏笔-031\n状态: 进行中\n开启章: 12'
  const map = parseFlat(fmRaw)
  expect(map.get('编号')).toBe('伏笔-031')
  expect(map.get('状态')).toBe('进行中')
  expect(map.get('开启章')).toBe(12)
  expect(stringifyFlat(map)).toBe(fmRaw)
})

test('X-P2-18: 数组逐项序列化——含逗号/引号/纯数字/空项往返不丢', () => {
  const cases: unknown[][] = [
    ['科幻', '悬疑,推理', '带"引号"', '123', ''],
    ['a', 'b'],
    [],
  ]
  for (const arr of cases) {
    expect(parseValue(stringifyValue(arr))).toEqual(arr)
  }
  // 序列化形态：含逗号项带引号（与解析端 K17 的引号跳过对称）
  expect(stringifyValue(['科幻', '悬疑,推理'])).toBe('[科幻, "悬疑,推理"]')
})

// ── Q-15/16/17（第十五轮）：格式族三修复回归 ──────────────────────

// Q-16：闭合 --- 判零缩进——块标量值内的缩进 `  ---` 不再误判 fm 结束（往返不截断）
test('Q-16: 块标量值含缩进 --- 行 → 往返无损（trim 判定曾把 `  ---` 当闭合）', () => {
  const m = new Map<string, unknown>()
  m.set('钩子', '第一段\n  ---\n第二段') // 块标量里出现缩进 --- 分隔线
  m.set('标题', '正常值')
  const file = joinFrontMatter(stringifyFlat(m), '正文')
  // 写盘再读回（splitFrontMatter + parseFlat 全链）
  const split = splitFrontMatter(file)
  expect(split).not.toBeNull()
  const back = parseFlat(split!.fmRaw)
  // 值完整往返（块内 --- 行不截断 fm）；缩进按既有逐行 dedent 语义归一（非本次修复面）
  expect(back.get('钩子')).toBe('第一段\n---\n第二段')
  expect(back.get('标题')).toBe('正常值')
  expect(split!.body).toBe('正文')
})

// Q-17：块标量 chomping 变体（`|-`/`|+`/`>-`）按块标量解析，不再当字面串漏块内容
test('Q-17: `钩子: |-` / `>-` 变体 → 走块标量分支（值不含块内容混入的伪键）', () => {
  const fm = ['钩子: |-', '  第一段', '  第二段', '标题: 收束'].join('\n')
  const m = parseFlat(fm)
  expect(m.get('钩子')).toBe('第一段\n第二段')
  expect(m.get('标题')).toBe('收束')
  expect(m.size).toBe(2) // 缩进块行不再被当成顶层伪键
  const fmFolded = ['概要: >-', '  甲', '  乙'].join('\n')
  expect(parseFlat(fmFolded).get('概要')).toBe('甲 乙')
})

// Q-15：含 \n 值强制引号 + \n 转义，unquote 对称还原（不劈断 yaml 行）
test('Q-15: stringifyValue 含换行值 → 引号内 \\n 转义，parseValue 对称还原', () => {
  const s = '第一行\n第二行'
  const wire = stringifyValue(s)
  expect(wire.startsWith('"')).toBe(true)
  expect(wire).not.toMatch(/\n/) // 线上一行，行结构不破坏
  expect(wire).toContain('\\n')
  expect(parseValue(wire)).toBe(s)
  // 数组项含换行同链（splitInlineArray 逐项 unquote）
  const arrWire = stringifyValue(['甲', '乙\n丙'])
  expect(parseValue(arrWire)).toEqual(['甲', '乙\n丙'])
})

// ── R-11（第十六轮）：引号值反/转义对称（含反斜杠）──────────────────

test('R-11: 含反斜杠值往返不腐化（C:\\new\\repo / a\\"b / 字面 \\n 三例）', () => {
  const cases = ['C:\\new\\repo', 'a\\"b', '含字面\\n序列', '尾反斜杠\\']
  for (const v of cases) {
    const fm = new Map([['值', v]])
    const s = stringifyFlat(fm)
    expect(s).not.toMatch(/\n/) // 落盘一行
    expect(parseFlat(s).get('值')).toBe(v) // 一次往返原样
    // 反复往返（渐进腐化检测）
    let cur = s
    for (let i = 0; i < 5; i++) cur = stringifyFlat(parseFlat(cur))
    expect(parseFlat(cur).get('值')).toBe(v)
  }
})

test('R-11: unquote 单遍解码 \\\\" → \\，\\n 字面不再被误解成换行', () => {
  expect(parseValue('"C:\\\\new\\\\repo"')).toBe('C:\\new\\repo')
  expect(parseValue('"a\\\\\\"b"')).toBe('a\\"b')
  expect(stringifyValue('C:\\new\\repo')).toBe('"C:\\\\new\\\\repo"')
})

// ── R-12（第十六轮）：fm 起始判定收紧（整行精确 ---）────────────────

test('R-12: 正文首行为 ---- 或 --- 分隔（裸 md）→ 不当 fm 开，bodyOf 不误剥', () => {
  const dashed = '----\n正文第一行\n----\n第二行'
  expect(splitFrontMatter(dashed)).toBeNull()
  expect(bodyOf(dashed)).toBe(dashed)
  const sep = '--- 分隔\n正文第一行\n--- \n第二行'
  expect(splitFrontMatter(sep)).toBeNull()
  expect(bodyOf(sep)).toBe(sep)
})

test('R-12: 整行精确 ---（含 \r 尾）仍正常识别 fm', () => {
  expect(splitFrontMatter('---\r\n标题: 甲\n---\r\n正文')).toEqual({ fmRaw: '标题: 甲', body: '正文' })
  expect(splitFrontMatter('---\n标题: 甲\n---\n正文')).toEqual({ fmRaw: '标题: 甲', body: '正文' })
})
