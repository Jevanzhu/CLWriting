/**
 * R47-26（四十七轮）回归：deriveLeakKeywords 进程级指纹缓存。
 *
 * 修复前：runAllChecks 每章在三级供给末级都全量重扫 布线/（递归 walk + 每文件
 * readFileSync 解析 fm）——数百章书一次树聚合 O(章数×布线文件数) 重复 IO。
 * 修复后：套用 readIronRules 的 R73-31 范式——布线目录 (mtimeNs,size) 指纹命中
 * 直接回缓存（零 readFileSync），指纹失配（文件增/改）自动重算。
 * 范式（R73-31 先例同款）：mock readFileSync 计数观测「是否重读」。
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

function writeWiringDoc(root: string, sub: string, name: string, fm: string): void {
  mkdirSync(join(root, '布线', sub), { recursive: true })
  writeFileSync(
    join(root, '布线', sub, name),
    `---\n编号: ${sub}-001\n标题: 条目\n类型: ${sub}\n状态: 进行中\n开启章: 1\n${fm}\n---\n\n## 履历\n`,
    'utf-8',
  )
}

test('R47-26: 同指纹二次调用零重读（readFileSync 计数），结果等值', () => {
  const root = mkdtempTracked(join(tmpdir(), 'r47-leak-'))
  try {
    writeWiringDoc(root, '悬念', '悬念-001-密室之主.md', 'leak_keywords: [玉佩, 旧案]')
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
  const root = mkdtempTracked(join(tmpdir(), 'r47-leak-'))
  try {
    writeWiringDoc(root, '悬念', '悬念-001-密室之主.md', 'leak_keywords: [玉佩]')
    expect(deriveLeakKeywords(root)).toEqual(['玉佩'])
    // 重写（内容变 → size/mtimeNs 变 → 指纹失配）
    writeWiringDoc(root, '悬念', '悬念-001-密室之主.md', 'leak_keywords: [玉佩, 密室机关]')
    readMock.mockClear()
    expect(deriveLeakKeywords(root)).toEqual(['玉佩', '密室机关'])
    expect(readMock.mock.calls.length).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R47-26: 新增布线 md（count 变）→ 指纹失配重算，跨子目录照收', () => {
  const root = mkdtempTracked(join(tmpdir(), 'r47-leak-'))
  try {
    writeWiringDoc(root, '悬念', '悬念-001-密室之主.md', 'leak_keywords: [玉佩]')
    expect(deriveLeakKeywords(root)).toEqual(['玉佩'])
    writeWiringDoc(root, '感情线', '感情线-001-师徒债.md', 'leak_keywords:\n  - 血脉之秘')
    readMock.mockClear()
    expect(deriveLeakKeywords(root)).toEqual(['玉佩', '血脉之秘'])
    expect(readMock.mock.calls.length).toBe(2) // miss → 重扫全部布线 md
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R47-26: 无布线书 → 空数组且缓存（二次调用零读），降级语义不变', () => {
  const root = mkdtempTracked(join(tmpdir(), 'r47-leak-none-'))
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

test('R47-26: 返回值是拷贝——调用方 mutate 不污染缓存（R27-27 口径）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'r47-leak-clone-'))
  try {
    writeWiringDoc(root, '悬念', '悬念-001-密室之主.md', 'leak_keywords: [玉佩]')
    const first = deriveLeakKeywords(root)
    first.push('污染词')
    first.sort()
    expect(deriveLeakKeywords(root)).toEqual(['玉佩'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
