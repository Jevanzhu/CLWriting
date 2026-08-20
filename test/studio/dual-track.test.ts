/**
 * 双轨回归测（#13.1）：长篇八阶段数据链 + 短篇 P1–P4 数据链，端到端验 GUI API 不崩。
 *
 * 用 fixtures.ts 造的双轨工作目录起 server，fetch 各域 API 验关键字段。
 * 守护长短篇双轨（每次改 GUI 跑此，防单轨回归）。不涉 driver/大模型。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { rmSync } from 'node:fs'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { makeDualTrackWorkdir, LONG_BOOK, SHORT_BOOK } from './fixtures.js'

let workDir = ''
let server: http.Server | undefined
let baseUrl = ''

beforeAll(async () => {
  workDir = makeDualTrackWorkdir()
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

const enc = (s: string): string => encodeURIComponent(s)

describe('双轨回归 · 书架', () => {
  it('GET /api/books 含长篇 + 短篇', async () => {
    const r = await fetch(`${baseUrl}/api/books`)
    const d = (await r.json()) as { books: { name: string; kind: string }[] }
    expect(d.books.some((b) => b.name === LONG_BOOK && b.kind === 'long')).toBe(true)
    expect(d.books.some((b) => b.name === SHORT_BOOK && b.kind === 'short')).toBe(true)
  })
})

describe('双轨回归 · 长篇八阶段数据链', () => {
  it('总览：身份 + 进度(4章) + 状态机 + 卷结构', async () => {
    const r = await fetch(`${baseUrl}/api/books/${enc(LONG_BOOK)}/overview`)
    const d = (await r.json()) as {
      identity: { title: string; kind: string }
      progress: { chapters: number }
      state: { state: number }
    }
    expect(d.identity.title).toBe('长篇测试书')
    // 4 章 = 0001/0002 + 定稿观察 0003（finalize e2e 源）+ 收割样源 0004（learn e2e 源）
    expect(d.progress.chapters).toBe(4)
    expect(typeof d.state.state).toBe('number')
  })

  it('节奏：字数曲线 4 章 + 钩子/情绪分布', async () => {
    const r = await fetch(`${baseUrl}/api/books/${enc(LONG_BOOK)}/rhythm`)
    const d = (await r.json()) as { kind: string; wordCurve: unknown[]; written: { hookTypeDist: Record<string, number>; sceneDist: Record<string, number> } }
    expect(d.kind).toBe('long')
    expect(d.wordCurve).toHaveLength(4)
    expect(d.written.hookTypeDist['悬念钩']).toBe(3) // 0001 + 0003 + 0004
    expect(d.written.sceneDist['对话']).toBe(2) // 0001 + 0004
    expect(d.written.sceneDist['战斗']).toBe(1)
  })

  it('设定：角色卡（林远）+ 境界体系', async () => {
    const r = await fetch(`${baseUrl}/api/books/${enc(LONG_BOOK)}/settings`)
    const d = (await r.json()) as {
      kind: string
      characters: { 姓名: string; 境界: string }[]
      realm: { 体系: { 名称: string; 序列: string[] }[] } | null
      characterRelations: { from: string; to: string; type: string }[]
    }
    expect(d.kind).toBe('long')
    expect(d.characters.some((c) => c.姓名 === '林远' && c.境界 === '练气')).toBe(true)
    expect(d.realm?.体系[0]?.序列).toContain('金丹')
    expect(d.characterRelations.some((rel) => rel.from === '林远' && rel.to === '赵长老' && rel.type === '师徒')).toBe(true)
  })

  it('配置：book.yaml 读回', async () => {
    const r = await fetch(`${baseUrl}/api/books/${enc(LONG_BOOK)}/config`)
    const d = (await r.json()) as { config: { kind: string; book: { title: string }; leads: { enabled: string[] } } }
    expect(d.config.kind).toBe('long')
    expect(d.config.book.title).toBe('长篇测试书')
    expect(d.config.leads.enabled).toContain('成长线')
  })
})

describe('双轨回归 · 短篇 P1–P4 数据链', () => {
  it('总览：短篇身份 + 章数(2)', async () => {
    const r = await fetch(`${baseUrl}/api/books/${enc(SHORT_BOOK)}/overview`)
    const d = (await r.json()) as { identity: { kind: string }; progress: { chapters: number } }
    expect(d.identity.kind).toBe('short')
    expect(d.progress.chapters).toBe(2)
  })

  it('节奏：核心反转 2 章', async () => {
    const r = await fetch(`${baseUrl}/api/books/${enc(SHORT_BOOK)}/rhythm`)
    const d = (await r.json()) as { kind: string; reversals: { 章号: number }[] }
    expect(d.kind).toBe('short')
    expect(d.reversals).toHaveLength(2)
  })

  it('配置：短篇 book.yaml 读回', async () => {
    const r = await fetch(`${baseUrl}/api/books/${enc(SHORT_BOOK)}/config`)
    const d = (await r.json()) as { config: { kind: string; book: { title: string } } }
    expect(d.config.kind).toBe('short')
    expect(d.config.book.title).toBe('短篇测试集')
  })
})
