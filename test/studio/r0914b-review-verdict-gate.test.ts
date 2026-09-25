/**
 * P2-1（全库重评-0914）回归：review-verdict 端点的三审运行竞窗闸。
 *
 * 场景：三审完成写（POST /review）的 payload 不含 verdict 且整体覆盖写盘——三审
 * 分钟级运行窗内作者的裁决会被随后的完成写静默清除（R-16 写前重读只防反向：verdict
 * 写丢三审结果，防不了本向）。修复后 review-verdict 在解析出 name+docId 后、写盘前
 * 查 reviewRunning，命中 409 REVIEW_RUNNING（与三审端点自身闸同码同文案）。
 *
 * 闸态经 __setReviewRunning 第三参（docId，P2-1 新增可选参）预置到真实文档键上
 * （不起真实三审，同 review-audit-gate.test.ts 装置形态）；每例用后同参清理。
 * 装置（手搭书脚手架 + startServerSafe）照抄 review-verdict-race.test.ts。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { __setReviewRunning } from '../../src/studio/server/api/task-gate.js' // R0916-7-P3-12：三审登记表迁入 task-gate.ts

const BOOK = '裁决竞窗闸测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let docId = ''

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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-verdict-gate-'))
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
    'spec_version: 1\nkind: long\nbook:\n  title: 裁决竞窗闸测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
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
  // 闸态兜底清理（各用例已同参清理，此处防挂漏污染同进程其他测试）
  __setReviewRunning(BOOK, false, docId)
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('P2-1（全库重评-0914）: review-verdict 三审运行竞窗闸', () => {
  it('三审运行中（runKey=真实 docId 预置）裁决 → 409 REVIEW_RUNNING，且不落 verdict 信封', async () => {
    __setReviewRunning(BOOK, true, docId)
    try {
      const busy = await req(
        'POST',
        `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/review-verdict`,
        { approved: true },
      )
      expect(busy.status).toBe(409)
      expect((busy.json as { code?: string }).code ?? '').toBe('REVIEW_RUNNING')
      expect((busy.json as { error?: string }).error ?? '').toContain('三审进行中')
      // fail-closed 佐证：闸在写盘前，信封不得落盘
      const envelopePath = join(workDir, BOOK, '项目', '分析', `${docId}.json`)
      expect(existsSync(envelopePath)).toBe(false)
    } finally {
      __setReviewRunning(BOOK, false, docId) // 用后同参清理
    }
  })

  it('闸释放后裁决 → 200 正常落盘（闸不误伤空闲路径）', async () => {
    const ok = await req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/review-verdict`,
      { approved: false },
    )
    expect(ok.status).toBe(200)
    expect((ok.json as { verdict?: { approved?: boolean } }).verdict?.approved).toBe(false)
  })
})
