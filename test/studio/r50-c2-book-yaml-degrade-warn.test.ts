/**
 * R50-C-2（五十轮）回归：book.yaml 损坏时读配置端点降级留痕（log.warn）。
 *
 * 修复前 overview / draft-prompt / rhythm / style config（读 book.yaml 后未判 ok
 * 直接用 .config）在 book.yaml 损坏时静默回落 DEFAULT_CONFIG 骨架——无任何诊断
 * 痕迹（对照 state.ts P3-2 既有口径：log.warn('state', 'book.yaml 解析降级: ...')）。
 * 修复后五处消费点（overview / draft / rhythm / outline 卷进度 volumeProgressOf /
 * style）各自 log.warn 留痕，响应仍 200 正常降级（不崩端点）。
 *
 * 断言模式：vi.spyOn(log, 'warn')（先例 r37-task-gate-lockroot-warn.test.ts），
 * 按各模块 tag（'overview'/'draft'/'rhythm'/'outline'/'style'）断言留痕。
 * outline 卷进度走导出函数 buildOutlinePromptWithFiles 直测（其端点 POST /outline
 * 会触发分钟级 AI 生成，不在本测面）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { buildOutlinePromptWithFiles } from '../../src/studio/server/api/outline.js'
import { log } from '../../src/log/index.js'

const BOOK = 'R50坏配置书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function get(path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      { host: u.hostname, port: u.port, path, method: 'GET', headers: { 'x-studio-token': token } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
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
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r50-c2-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  // 损坏的 book.yaml：顶层段重复——本项目自研行式解析器（format/yaml.ts parseSections）
  // 对「顶层段重复」显式抛错（宁红不错挂）→ readBookConfig ok:false 回落 DEFAULT_CONFIG
  // 骨架；启动自愈 detectBookName 对 ok:false 回落目录名，登记名稳定（书可解析）
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: R50坏配置书\nbook:\n  title: 重复段\n')
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

/** 按模块 tag 断言留痕（log.warn(tag, 'book.yaml 解析降级: ...')）。 */
function warnCallsWithTag(tag: string): string[] {
  return vi.mocked(log.warn).mock.calls
    .filter((c) => c[0] === tag)
    .map((c) => String(c[1] ?? ''))
}

describe('R50-C-2：book.yaml 损坏 → 端点 200 降级 + log.warn 留痕（state.ts P3-2 同款口径）', () => {
  it('GET /overview → 200 且 log.warn("overview") 留痕', async () => {
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const r = await get(`/api/books/${encodeURIComponent(BOOK)}/overview`)
      expect(r.status).toBe(200)
      const calls = warnCallsWithTag('overview')
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls.some((m) => m.includes('book.yaml 解析降级'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('GET /draft-prompt → 200 且 log.warn("draft") 留痕', async () => {
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const r = await get(`/api/books/${encodeURIComponent(BOOK)}/draft-prompt?chapter=1`)
      expect(r.status).toBe(200)
      const calls = warnCallsWithTag('draft')
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls.some((m) => m.includes('book.yaml 解析降级'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('GET /rhythm → 200 且 log.warn("rhythm") 留痕', async () => {
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const r = await get(`/api/books/${encodeURIComponent(BOOK)}/rhythm`)
      expect(r.status).toBe(200)
      const calls = warnCallsWithTag('rhythm')
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls.some((m) => m.includes('book.yaml 解析降级'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('GET /style/config → 200 且 log.warn("style") 留痕', async () => {
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const r = await get(`/api/books/${encodeURIComponent(BOOK)}/style/config`)
      expect(r.status).toBe(200)
      const calls = warnCallsWithTag('style')
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls.some((m) => m.includes('book.yaml 解析降级'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('outline 卷进度（buildOutlinePromptWithFiles → volumeProgressOf）→ 正常产出且 log.warn("outline") 留痕', () => {
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const d = buildOutlinePromptWithFiles(join(workDir, BOOK), 60, 'long')
      expect(d.prompt.length).toBeGreaterThan(0)
      const calls = warnCallsWithTag('outline')
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls.some((m) => m.includes('book.yaml 解析降级'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
