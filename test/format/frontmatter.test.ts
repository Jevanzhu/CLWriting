import { test, expect } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
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
  patchFlatFm,
} from '../../src/format/frontmatter.js'
import { readBookConfig } from '../../src/format/yaml.js'
import { stripInlineComment } from '../../src/format/frontmatter-core.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

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

// B-16（第六十轮）：单个 `"` 字符值 startsWith/endsWith 命中同一字符，
// slice(1, -1) 会归一成空串（值被吞）——length >= 2 守卫
test('B-16: 单字符引号值不归一为空串（length>=2 守卫）', () => {
  expect(parseValue('"')).toBe('"')
  expect(parseValue("'")).toBe("'")
  // 配对引号行为不变
  expect(parseValue('"ab"')).toBe('ab')
})

// B-17（第六十轮）：值内未配对引号后 `#` 不剥（引号状态机永不闭合）——
// 行末引号未闭合回落无引号感知裸扫；配对引号路径行为不变
test('B-17: 未闭合引号后的 # 仍剥（裸扫回落）；配对引号内 # 保留', () => {
  expect(stripInlineComment('备注: "未闭合 # 应剥')).toBe('备注: "未闭合')
  expect(stripInlineComment("备注: '未闭合 # 应剥")).toBe("备注: '未闭合")
  expect(stripInlineComment('备注: "a # b" # 尾注释')).toBe('备注: "a # b"')
  expect(stripInlineComment('备注: 无引号 # 注释')).toBe('备注: 无引号')
  // URL 字面 #（前无空白）保留——既有语义不回归
  expect(stripInlineComment('endpoint: http://x#y')).toBe('endpoint: http://x#y')
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
  const dir = mkdtempTracked(join(tmpdir(), '北境的雪-'))
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
  const dir = mkdtempTracked(join(tmpdir(), '北境的雪-'))
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
  const dir = mkdtempTracked(join(tmpdir(), '北境的雪-'))
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

// ── R65-1（十三轮）：平铺 fm 文本级补丁 ─────────────────────

const REALM_FM = [
  '名称: 境界体系',
  '体系:',
  '  - 名称: 修真境界',
  '    序列: [炼气, 筑基, 金丹, 元婴]',
  '  - 名称: 武者等级',
  '    序列: [后天, 先天, 宗师]',
  '备注: 作者手写',
].join('\n')

test('R65-1: patchFlatFm 补平铺键保留境界体系嵌套结构（旧 parseFlat RMW 会压平）', () => {
  const r = patchFlatFm(REALM_FM, { 名称: '境界体系v2', 标签: ['修真', '升级流'] })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  // 嵌套段逐字节保留：parseRealmSystems 仍完整解析（旧实现此处返回 [] 或只剩最后一组）
  expect(parseRealmSystems(r.text)).toEqual([
    { 名称: '修真境界', 序列: ['炼气', '筑基', '金丹', '元婴'] },
    { 名称: '武者等级', 序列: ['后天', '先天', '宗师'] },
  ])
  // 其余键行为：已存在键换行 / 缺失键追加 / 未知键原样保留
  const map = parseFlat(r.text)
  expect(map.get('名称')).toBe('境界体系v2')
  expect(map.get('标签')).toEqual(['修真', '升级流'])
  expect(map.get('备注')).toBe('作者手写')
})

test('R65-1: patchFlatFm 拒绝改写自带嵌套子行的键（fail-loud 防平铺化）', () => {
  const r = patchFlatFm(REALM_FM, { 体系: 'x' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.reason).toContain('体系')
})

test('R65-1: patchFlatFm 块标量键整体重渲染（含跨空行内容）', () => {
  const fmRaw = '钩子: |\n  第一段\n\n  第二段\n状态: 进行中'
  const r = patchFlatFm(fmRaw, { 钩子: '新\n内容' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(parseFlat(r.text).get('钩子')).toBe('新\n内容')
  expect(parseFlat(r.text).get('状态')).toBe('进行中')
})

test('R65-1: patchFlatFm 普通键后随空行不误判嵌套；多行值渲染块标量', () => {
  const fmRaw = '标题: 旧\n\n状态: 进行中'
  const r = patchFlatFm(fmRaw, { 标题: '新', 摘要: 'a\nb' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const map = parseFlat(r.text)
  expect(map.get('标题')).toBe('新')
  expect(map.get('状态')).toBe('进行中')
  expect(map.get('摘要')).toBe('a\nb')
})

test('R65-1: patchFlatFm 重复同名顶层键只保留首个改写', () => {
  const fmRaw = '状态: 旧a\n状态: 旧b'
  const r = patchFlatFm(fmRaw, { 状态: '新' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(parseFlat(r.text).get('状态')).toBe('新')
  expect(r.text.match(/状态:/g)).toHaveLength(1)
})

test('R65-1: patchFlatFm 空 fm 全量追加 + 注释行保留', () => {
  const fmRaw = '# 顶部注释\n标题: 旧'
  const r = patchFlatFm(fmRaw, { 标题: '新', 新键: 42 })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.text.startsWith('# 顶部注释\n')).toBe(true)
  expect(parseFlat(r.text).get('新键')).toBe(42)
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
  // 值完整往返（块内 --- 行不截断 fm）；E-9d（第五十三轮）后缩进按块内最小缩进
  // dedent——相对缩进保留，`  ---` 不再被逐行 dedent 抹平
  expect(back.get('钩子')).toBe('第一段\n  ---\n第二段')
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

// ── E-3（第五十三轮）：parseFlat 行内注释口径对齐 yaml.ts stripComment ──────

test('E-3: parseFlat 剥行内注释——`标题: 值 # 备注` 注释尾巴不进值', () => {
  const fm = parseFlat('标题: 灭门真凶 # 备注尾巴\n章号: 3')
  expect(fm.get('标题')).toBe('灭门真凶')
  expect(fm.get('章号')).toBe(3)
})

test('E-3: 引号内 # 不剥；# 前无空白视为字面值（对齐 yaml.ts 语义）', () => {
  expect(parseFlat('标题: "含 # 号 # 注"').get('标题')).toBe('含 # 号 # 注')
  expect(parseFlat("标题: 'a # b' # 注").get('标题')).toBe('a # b')
  // # 前无空白 → 字面（http://x#y 同理，与 yaml.ts stripComment 同口径）
  expect(parseFlat('链接: http://x#y').get('链接')).toBe('http://x#y')
})

test('E-3: 读改写往返不炸（注释丢失与 yaml.ts 读改写口径一致，属预期）', () => {
  const s = stringifyFlat(parseFlat('标题: 甲 # 注\n章号: 1'))
  expect(s).toBe('标题: 甲\n章号: 1')
  expect(parseFlat(s).get('标题')).toBe('甲')
})

// N-4（第五十四轮）：双入口行为一致——parseFlat（章 fm）与 readBookConfig（book.yaml）
// 共用 frontmatter-core.ts stripInlineComment 后，同一值串在两侧剥注释结果必须一致
test('N-4: 双入口（parseFlat / readBookConfig）行内注释剥除行为一致', () => {
  const dir = mkdtempTracked(join(tmpdir(), 'n4-双入口-'))
  try {
    const values = [
      '甲 # 注',        // 常规行内注释
      '"含 # 号 # 注"', // 引号内 # 不剥
      'http://x#y',     // # 前无空白 → 字面保留
      "'a # b' # 注",   // 单引号内不剥，引号外剥
    ]
    for (const v of values) {
      const fmVal = parseFlat(`标题: ${v}`).get('标题')
      const fp = join(dir, 'book.yaml')
      writeFileSync(fp, `book:\n  title: ${v}\n`, 'utf8')
      const r = readBookConfig(fp)
      expect(r.ok).toBe(true)
      const yamlVal = r.ok ? r.config.book.title : undefined
      expect(fmVal).toBe(yamlVal)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── E-9d（第五十三轮）：块标量按块内最小缩进去缩进 ──────────────────

test('E-9d: 按块内最小缩进去缩进，保留相对缩进，多行值往返不失真', () => {
  // 首行深(4)、后续行浅(2)：以最小缩进 2 为基准 → 保留「第一行」比「第二行」深 2 格的相对缩进
  const fmRaw = '钩子: |-\n    第一行\n  第二行'
  expect(parseFlat(fmRaw).get('钩子')).toBe('  第一行\n第二行')
  // 关键回归：相对缩进不丢——旧逻辑按每行自身缩进 slice，嵌套行的相对缩进被抹平，
  // 序列化（2 空格基准）再解析后回不到原值
  const v = '首行\n  嵌套行'
  expect(parseFlat(stringifyFlat(parseFlat('钩子: |\n  首行\n    嵌套行'))).get('钩子')).toBe(v)
})

test('E-9d: 首行缩进即最小缩进时行为不变（正常手写块）', () => {
  expect(parseFlat('钩子: |\n  a\n  b').get('钩子')).toBe('a\nb')
})
