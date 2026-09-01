/**
 * R-16（第十六轮）回归：verdict 写回与三审完成的读改写竞态。
 *
 * 场景：POST /review-verdict 首次 readAnalysis 拿到旧 payload（无三审结果），随后
 * （读稿/写盘之间）三审恰好完成落盘新 collected/lenses。修复前 verdict 用旧读的
 * payload 整体回写 → 新三审结果被静默写丢。修复后写前重读、以磁盘最新值浅合并，
 * 只覆盖 verdict 字段。
 *
 * 注入方式：vi.mock document/analysis.js 的 readAnalysis 为序列桩（第 1 次返旧、
 * 第 2 次返三审落盘后的新值——精确模拟竞态窗口），writeAnalysis 走真实实现；
 * 断言以真实文件读回为准。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import type { Envelope } from '../../src/document/analysis.js'

const BOOK = '裁决竞态测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let docId = ''

// 旧读（verdict 首次 readAnalysis）：只有一条旧 collected
const OLD_ENV: Envelope = {
  generatedAt: '2026-08-01T00:00:00.000Z',
  model: 'cc/old',
  sourceHash: 'a'.repeat(64),
  payload: { collected: [{ lens: 'logic', level: 'yellow', text: '旧意见' }] },
}
// 新落盘（三审恰在竞态窗口完成）：全新 collected + lenses
const NEW_ENV: Envelope = {
  generatedAt: '2026-08-22T00:00:00.000Z',
  model: 'cc/new',
  sourceHash: 'b'.repeat(64),
  payload: { collected: [{ lens: 'consistency', level: 'red', text: '新三审意见' }], lenses: ['consistency'] },
}

const readAnalysisSeq = vi.fn()

vi.mock('../../src/document/analysis.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/document/analysis.js')>()
  return {
    ...orig,
    readAnalysis: (...args: Parameters<typeof orig.readAnalysis>) =>
      readAnalysisSeq(...args) as ReturnType<typeof orig.readAnalysis>,
  }
})

function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = body ? JSON.stringify(body) : ''
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          'x-studio-token': token,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-verdict-race-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '定稿', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 裁决竞态测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf8',
  )
  writeFileSync(
    join(bookRoot, '定稿', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场。\n',
    'utf8',
  )
  const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null })
  writeManifest(join(bookRoot, '项目', '文档清单.jsonl'), m)

  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R-16: verdict 与三审完成读改写竞态', () => {
  it('三审恰在 verdict 读后写前落盘 → verdict 落盘且新 collected/lenses 保留不丢', async () => {
    // 预置旧信封（真实写盘，模拟此前已有一次旧三审）
    const { writeAnalysis } = await import('../../src/document/analysis.js')
    writeAnalysis(join(workDir, BOOK), docId, 'review', OLD_ENV)

    // 序列桩：第 1 次（verdict 首读）= 旧值；第 2 次（R-16 写前重读）= 三审刚落盘的新值
    readAnalysisSeq.mockReturnValueOnce(OLD_ENV).mockReturnValueOnce(NEW_ENV)

    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/review-verdict`, {
      approved: true,
    })
    expect(r.status).toBe(200)
    expect(readAnalysisSeq).toHaveBeenCalledTimes(2) // 首读 + 写前重读（竞态防护点）
    expect((r.json as { verdict: { approved: boolean } }).verdict.approved).toBe(true)

    // 真实文件读回（绕开 mock）：verdict 在 + 新三审 collected/lenses 在 + 旧意见不残留
    const raw = JSON.parse(readFileSync(join(workDir, BOOK, '项目', '分析', `${docId}.json`), 'utf-8')) as {
      review: Envelope
    }
    const payload = raw.review.payload as {
      collected: { lens: string; level: string; text: string }[]
      lenses: string[]
      verdict: { approved: boolean }
    }
    expect(payload.verdict.approved).toBe(true) // R-16：verdict 不丢
    expect(payload.collected).toEqual((NEW_ENV.payload as { collected: unknown[] }).collected) // 新三审结果不被旧读覆写
    expect(payload.lenses).toEqual(['consistency'])
  })
})
