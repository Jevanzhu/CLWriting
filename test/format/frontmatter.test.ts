import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseValue,
  stringifyValue,
  splitFrontMatter,
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
    expect(r1.error.file).toBeTruthy()
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
