/**
 * 泄露关键词派生（deriveLeakKeywords）：fm 键位冒号双认 + 进程级指纹缓存。
 *
 * 档源（2 档并 1，按被测行为合并；断言逐条保留、去重 0 条——提取口径与缓存行为
 * 是同一函数的两面）：
 * - r35-leak-keywords-colon.test.ts（R35-21）
 * - r47-leak-derive-cache.test.ts（R47-26）
 *
 * - R35-21（三十五轮）：leak_keywords 两处正则只认半角冒号——手写全角冒号的账本 fm
 *   条目（单行数组与逐行列表两形态）整条静默漏收，info-leak 机检假绿（R31-2/R34D-10
 *   冒号双认家族漏改点）。
 * - R47-26（四十七轮）：修复前 runAllChecks 每章在三级供给末级都全量重扫 布线/
 *   （递归 walk + 每文件 readFileSync 解析 fm）——数百章书一次树聚合 O(章数×布线
 *   文件数) 重复 IO。修复后：布线目录指纹命中直接回缓存（零 readFileSync），指纹
 *   失配（文件增/改）自动重算。dev←recover 合并批收档：R47-26 与 dev 在位 R46-10
 *   指纹缓存同题，择 dev 在位版（leakDeriveCache；命中返回共享数组系 dev 口径——
 *   机检消费面只读比对零拷贝，R47-26 的「返回拷贝」语义不采，其用例 5 一并删除）。
 *   范式（R73-31 先例同款）：mock readFileSync 计数观测「是否重读」。
 */
import { test, expect, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

import { readFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { deriveLeakKeywords } from '../../src/check/leak-derive.js'

const readMock = vi.mocked(readFileSync)

function writeWiringDoc(root: string, name: string, fm: string): void {
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  writeFileSync(join(root, '布线', '悬念', name), `---\n编号: 悬念-001\n标题: 密室之主\n类型: 悬念\n状态: 进行中\n开启章: 1\n${fm}\n---\n\n正文无关。\n`, 'utf-8')
}

function writeWiringDocIn(root: string, sub: string, name: string, fm: string): void {
  mkdirSync(join(root, '布线', sub), { recursive: true })
  writeFileSync(
    join(root, '布线', sub, name),
    `---\n编号: ${sub}-001\n标题: 条目\n类型: ${sub}\n状态: 进行中\n开启章: 1\n${fm}\n---\n\n## 履历\n`,
    'utf-8',
  )
}

// ── R35-21：键位冒号双认 `:`/`：` ────────────────────────────────

test('R35-21: 全角冒号单行数组条目入词表（修复前静默漏收 → 假绿）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'leak-keywords-'))
  try {
    writeWiringDoc(root, '悬念-001-密室之主.md', 'leak_keywords：[玄铁令, 密室机关]')
    expect(deriveLeakKeywords(root)).toEqual(['玄铁令', '密室机关'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R35-21: 全角冒号逐行列表条目入词表', () => {
  const root = mkdtempTracked(join(tmpdir(), 'leak-keywords-'))
  try {
    writeWiringDoc(root, '悬念-001-密室之主.md', 'leak_keywords：\n  - 玉佩\n  - 旧案')
    expect(deriveLeakKeywords(root)).toEqual(['玉佩', '旧案'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R35-21: 半角冒号既有口径不回归（单行数组 + 逐行列表照收）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'leak-keywords-'))
  try {
    writeWiringDoc(root, '悬念-001-密室之主.md', 'leak_keywords: [半角词]')
    writeWiringDoc(root, '悬念-002-另线.md', 'leak_keywords:\n  - 列表词')
    const kws = deriveLeakKeywords(root)
    expect(kws).toContain('半角词')
    expect(kws).toContain('列表词')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R47-26：进程级指纹缓存 ──────────────────────────────────────

test('R47-26: 同指纹二次调用零重读（readFileSync 计数），结果等值', () => {
  const root = mkdtempTracked(join(tmpdir(), 'leak-keywords-'))
  try {
    writeWiringDocIn(root, '悬念', '悬念-001-密室之主.md', 'leak_keywords: [玉佩, 旧案]')
    readMock.mockClear()
    const first = deriveLeakKeywords(root)
    expect(first).toEqual(['玉佩', '旧案'])
    expect(readMock.mock.calls.length).toBe(1) // 首调：读 1 个布线 md
    // 二次：布线 stat 指纹未变 → 命中缓存，零 readFileSync
    readMock.mockClear()
    expect(deriveLeakKeywords(root)).toEqual(['玉佩', '旧案'])
    expect(readMock.mock.calls.length).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R47-26: 布线文件内容变更（指纹失配）→ 重算重读，新词入表', () => {
  const root = mkdtempTracked(join(tmpdir(), 'leak-keywords-'))
  try {
    writeWiringDocIn(root, '悬念', '悬念-001-密室之主.md', 'leak_keywords: [玉佩]')
    expect(deriveLeakKeywords(root)).toEqual(['玉佩'])
    // 重写（内容变 → size/mtimeNs 变 → 指纹失配）
    writeWiringDocIn(root, '悬念', '悬念-001-密室之主.md', 'leak_keywords: [玉佩, 密室机关]')
    readMock.mockClear()
    expect(deriveLeakKeywords(root)).toEqual(['玉佩', '密室机关'])
    expect(readMock.mock.calls.length).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R47-26: 新增布线 md（count 变）→ 指纹失配重算，跨子目录照收', () => {
  const root = mkdtempTracked(join(tmpdir(), 'leak-keywords-'))
  try {
    writeWiringDocIn(root, '悬念', '悬念-001-密室之主.md', 'leak_keywords: [玉佩]')
    expect(deriveLeakKeywords(root)).toEqual(['玉佩'])
    writeWiringDocIn(root, '感情线', '感情线-001-师徒债.md', 'leak_keywords:\n  - 血脉之秘')
    readMock.mockClear()
    expect(deriveLeakKeywords(root)).toEqual(['玉佩', '血脉之秘'])
    expect(readMock.mock.calls.length).toBe(2) // miss → 重扫全部布线 md
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R47-26: 无布线书 → 空数组且缓存（二次调用零读），降级语义不变', () => {
  const root = mkdtempTracked(join(tmpdir(), 'leak-keywords-none-'))
  try {
    readMock.mockClear()
    expect(deriveLeakKeywords(root)).toEqual([])
    expect(readMock.mock.calls.length).toBe(0) // existsSync 短路，本就不读文件
    readMock.mockClear()
    expect(deriveLeakKeywords(root)).toEqual([])
    expect(readMock.mock.calls.length).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
