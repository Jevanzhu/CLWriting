import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readPiece,
  writePiece,
  parsePieceFileName,
  readPieceDir,
  countPieces,
} from '../../src/format/pieces.js'
import type { PieceMeta } from '../../src/format/types.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clwriting-piece-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// ── readPiece / writePiece 往返 ──────────────────

test('writePiece + readPiece: 最小字段往返', () => {
  const piece: PieceMeta = { 篇号: 1, 标题: '雪夜来客', 目标情绪: '压抑到释然', 核心反转: '来客即凶手' }
  const fp = join(tmp, '正文.md')
  writePiece(fp, piece, '正文内容')

  const r = readPiece(fp)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.piece.篇号).toBe(1)
  expect(r.piece.标题).toBe('雪夜来客')
  expect(r.piece.目标情绪).toBe('压抑到释然')
  expect(r.piece.核心反转).toBe('来客即凶手')
  expect(r.piece._wordCount).toBeGreaterThan(0)
})

test('readPiece: 缺必填篇号 → 容错错误', () => {
  const fp = join(tmp, '正文.md')
  writeFileSync(fp, '---\n标题: 无篇号\n---\n正文', 'utf-8')
  const r = readPiece(fp)
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.error.message).toContain('篇号')
})

test('readPiece: 未知字段进 _raw 容错保留', () => {
  const fp = join(tmp, '正文.md')
  writeFileSync(
    fp,
    '---\n篇号: 3\n标题: x\n自定义备注: 作者手写\n---\n正文',
    'utf-8',
  )
  const r = readPiece(fp)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.piece._raw?.['自定义备注']).toBe('作者手写')
})

// ── parsePieceFileName ───────────────────────────

test('parsePieceFileName: 子路径取目录名段', () => {
  expect(parsePieceFileName('篇/001-雪夜来客/正文.md')).toEqual({ 篇号: 1, 标题: '雪夜来客' })
  expect(parsePieceFileName('001-雪夜来客')).toEqual({ 篇号: 1, 标题: '雪夜来客' })
  expect(parsePieceFileName('无篇号目录/正文.md')).toBeNull()
})

// ── readPieceDir + countPieces ───────────────────

test('readPieceDir: 扫 篇/ 子目录读正文', () => {
  const 篇Root = join(tmp, '篇')
  mkdirSync(join(篇Root, '001-雪夜来客'), { recursive: true })
  mkdirSync(join(篇Root, '002-暗河'), { recursive: true })
  writePiece(join(篇Root, '001-雪夜来客', '正文.md'), { 篇号: 1, 标题: '雪夜来客' }, '正文一')
  writePiece(join(篇Root, '002-暗河', '正文.md'), { 篇号: 2, 标题: '暗河' }, '正文二')

  const r = readPieceDir(篇Root)
  expect(r.pieces).toHaveLength(2)
  expect(r.pieces.map((p) => p.篇号).sort((a, b) => a - b)).toEqual([1, 2])
})

test('countPieces: 只计 篇号-标题 格式目录', () => {
  const 篇Root = join(tmp, '篇')
  mkdirSync(join(篇Root, '001-标题'), { recursive: true })
  mkdirSync(join(篇Root, '002-标题'), { recursive: true })
  mkdirSync(join(篇Root, '散文件目录'), { recursive: true }) // 不计：无篇号前缀
  mkdirSync(join(篇Root, '.隐藏'), { recursive: true }) // 不计

  expect(countPieces(篇Root)).toBe(2)
  expect(countPieces(join(tmp, '不存在'))).toBe(0)
})
