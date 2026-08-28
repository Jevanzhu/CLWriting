/**
 * B-6（第六十轮）回归：createFileExclusive 独占创建语义（tmp + linkSync）。
 *
 * doCreate 的 existsSync → atomicWriteFile(rename) 存在跨进程双建覆盖 TOCTOU：
 * 双进程同 relPath 并发新建时后到者 rename 静默覆盖先到者内容且双方返回成功
 * （两个 docId 先后 upsert 成同路径双认领态）。link 不覆盖——EEXIST → 'exists'，
 * 调用方判 ALREADY_EXISTS；创建成功返回 'created'。
 */
import { test, expect } from 'vitest'
import { rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileExclusive } from '../../src/fs/atomic.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

test('B-6: 全新路径 → created，内容落盘且无 tmp 残留', () => {
  const d = mkdtempTracked(join(tmpdir(), 'clw-b6-'))
  const r = createFileExclusive(join(d, 'a.md'), '内容', { fsync: true })
  expect(r).toBe('created')
  expect(readFileSync(join(d, 'a.md'), 'utf-8')).toBe('内容')
  expect(readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([])
  rmSync(d, { recursive: true, force: true })
})

test('B-6: 目标已存在 → exists 且不覆盖既有内容（rename 覆盖语义的对照）', () => {
  const d = mkdtempTracked(join(tmpdir(), 'clw-b6-'))
  const fp = join(d, 'a.md')
  writeFileSync(fp, '先到者')
  const r = createFileExclusive(fp, '后到者')
  expect(r).toBe('exists')
  // 修复前 atomicWriteFile 的 rename 会静默覆盖成「后到者」
  expect(readFileSync(fp, 'utf-8')).toBe('先到者')
  expect(readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([])
  rmSync(d, { recursive: true, force: true })
})

test('B-6: 同路径两次创建 → 先 created 后 exists，双方各自明确不再双成功', () => {
  const d = mkdtempTracked(join(tmpdir(), 'clw-b6-'))
  const fp = join(d, 'a.md')
  const first = createFileExclusive(fp, 'A')
  const second = createFileExclusive(fp, 'B')
  expect(first).toBe('created')
  expect(second).toBe('exists')
  expect(readFileSync(fp, 'utf-8')).toBe('A')
  rmSync(d, { recursive: true, force: true })
})
