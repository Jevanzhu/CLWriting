/**
 * R64-25（十二轮批 B）：readGlobalBookDefaults (mtimeMs,size) 指纹缓存。
 *
 * 同指纹 → 不再读盘（readFileSync 调用数不增）；指纹变化（size 变）→ 重新读盘。
 * 单独成文：需 mock node:fs 统计 readFileSync 次数，避免污染其他用例的 fs 观测。
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>()
  return {
    ...orig,
    readFileSync: vi.fn(orig.readFileSync),
  }
})

// 注：vi.mock 提升后，被测模块经此 import 才会拿到 mock 版 node:fs
import { readFileSync } from 'node:fs'
import { readGlobalBookDefaults } from '../../src/format/global-defaults.js'

const readCalls = () => vi.mocked(readFileSync).mock.calls.length

let userData: string
beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'clw-r64-gd-'))
  mkdirSync(userData, { recursive: true })
})
afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
  vi.mocked(readFileSync).mockClear()
})

test('R64-25：同指纹命中缓存不读盘；size 变化后重读新值', () => {
  const p = join(userData, 'global.json')
  writeFileSync(p, JSON.stringify({ defaultGenre: '玄幻', defaultTargetWords: 2000000 }), 'utf-8')

  const first = readGlobalBookDefaults(userData)
  expect(first.defaultGenre).toBe('玄幻')
  const callsAfterFirst = readCalls()
  expect(callsAfterFirst).toBeGreaterThanOrEqual(1)

  // 同指纹：再次读取直接回缓存（不再 readFileSync global.json）
  const second = readGlobalBookDefaults(userData)
  expect(second.defaultGenre).toBe('玄幻')
  expect(readCalls()).toBe(callsAfterFirst)

  // 写坏 JSON（size 变 → 指纹失效）→ 重新读盘；解析失败不缓存，回落空对象
  writeFileSync(p, '{ 损坏', 'utf-8')
  expect(readGlobalBookDefaults(userData).defaultGenre).toBeUndefined()
  expect(readCalls()).toBeGreaterThan(callsAfterFirst)

  // 修好且值变（size 不同）→ 读到新值
  writeFileSync(p, JSON.stringify({ defaultGenre: '悬疑' }), 'utf-8')
  const third = readGlobalBookDefaults(userData)
  expect(third.defaultGenre).toBe('悬疑')
})
