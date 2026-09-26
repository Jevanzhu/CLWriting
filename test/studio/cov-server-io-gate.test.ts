/**
 * R1010c-COV-3（2026-09-10 全量独立复审修复批）：导出全局并发闸（acquireExportSlot
 * 排队/转移/超时/超限）+ export 端点入参与信封分支补测——此前 io.ts 分支覆盖 77.27%
 * （排队上限/等待超时/NO_WORKDIR/默认 format/platform/422/503 未触达）。
 *
 * Part A 直测 acquireExportSlot 导出测试钩子（io.ts 自注「仅供测试断言排队/放行」）；
 * Part B 走真实 startServer HTTP。R0916-7-P3-6 适配：等待超时改逐调用入参（原模块级
 * __setExportWaitTimeoutForTest 已删）；Part B 503 用例走专用实例经组装根 overrides
 * 注入短等待档，主实例保持 10min 缺省。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { acquireExportSlot, ExportSlotWaitError } from '../../src/studio/server/api/io.js'

let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

// 无 workDir（NO_WORKDIR 分支）
let noworkServer: http.Server | undefined
let noworkBaseUrl = ''
let noworkToken = ''

interface ReqOpts {
  method: string
  path: string
  body?: unknown
}
function request(base: string, tok: string, opts: ReqOpts): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base)
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: opts.path,
        method: opts.method,
        headers: {
          'x-studio-token': tok,
          ...(payload !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: any = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON 体 */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    if (payload !== undefined) r.write(payload)
    r.end()
  })
}
function req(opts: ReqOpts): Promise<{ status: number; json: any }> {
  return request(baseUrl, token, opts)
}
function noworkReq(opts: ReqOpts): Promise<{ status: number; json: any }> {
  return request(noworkBaseUrl, noworkToken, opts)
}

function makeBookIn(dir: string, name: string): string {
  const root = join(dir, 'books', name)
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'kind: long\nbook:\n  title: x\n')
  mkdirSync(join(dir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(dir, '.clwriting', 'books.jsonl'),
    `${JSON.stringify({ name, path: `books/${name}` })}\n`,
    { flag: 'a' },
  )
  return root
}

function makeBook(name: string): string {
  return makeBookIn(workDir, name)
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-cov-io-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-cov-io-ud-'))
  server = await startServerSafe({ port: 0, workDir, userDataPath })
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  token = ((await (await fetch(`${baseUrl}/api/boot`)).json()) as { token: string }).token
  noworkServer = await startServerSafe({ port: 0 })
  noworkBaseUrl = `http://127.0.0.1:${(noworkServer!.address() as AddressInfo).port}`
  noworkToken = ((await (await fetch(`${noworkBaseUrl}/api/boot`)).json()) as { token: string }).token
  makeBook('空书')
  makeBook('导出参数书')
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (noworkServer) await new Promise<void>((r) => noworkServer!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

// ── Part A：acquireExportSlot 排队语义（直测导出钩子）─────────────

describe('R1010c-COV-3：acquireExportSlot 排队/转移/超时/超限', () => {
  it('满 2 槽后排队；release 名额直接转移给 waiter（active 计数不自减）', async () => {
    // 本用例全部走转移/释放收口，5s 超时逐调用传入仅兜底
    const r1 = await acquireExportSlot()
    const r2 = await acquireExportSlot()
    try {
      const waiter = acquireExportSlot(5_000)
      let settled = false
      void waiter.then(() => (settled = true))
      await new Promise((r) => setTimeout(r, 30))
      expect(settled).toBe(false) // 无空位时 waiter 挂起
      r1() // 释放 → 名额转移（release 后 active 不自减）
      const waiterRelease = await waiter // waiter 恢复，拿到可用的 release
      expect(settled).toBe(true)
      // 转移语义：r1 已消费（幂等 no-op），active 仍是 2（r2 + waiter）→ 此刻无空位
      let probeSettled = false
      const probe = acquireExportSlot(5_000).then(
        (rel) => (probeSettled = true) && rel,
        () => (probeSettled = true) && null,
      )
      await new Promise((r) => setTimeout(r, 30))
      expect(probeSettled).toBe(false)
      // 收尾：逐级转移释放（probe ← r2；waiter 释放；active 归零）
      r2()
      const probeRelease = await probe
      probeRelease?.()
      waiterRelease()
    } finally {
      r1()
      r2()
    }
  })

  it('release 幂等：首次释放生效（无 waiter 自减），二次释放 no-op 不再多减', async () => {
    const r1 = await acquireExportSlot()
    const r2 = await acquireExportSlot()
    try {
      r1()
      r1() // 幂等 no-op——若误再多减，下方 probe 会立即放行而非排队（断言即红）
      // 现状 active=1（r2 仍持）→ 新请求 a 立即放行（active=2），probe 必须排队
      const relA = await acquireExportSlot()
      let settled = false
      const probe = acquireExportSlot(5_000).then(
        (rel) => (settled = true) && rel,
        () => (settled = true) && null,
      )
      await new Promise((r) => setTimeout(r, 30))
      expect(settled).toBe(false) // probe 仍排队 → 证明二次释放确未多减
      relA() // 名额转移给 probe（active 不自减）
      const probeRel = await probe
      expect(settled).toBe(true)
      probeRel?.() // 无 waiter 自减 → active=1（r2 仍持）
    } finally {
      r2() // 末额释放 → active=0
    }
  })

  it('等待超时 → ExportSlotWaitError（排队等待超时文案），超时者自摘队列', async () => {
    // 先满载（空位立即放行），再只给排队者逐调用传短超时（60ms）——满载两额
    // 不带超时入参，泄漏态下首个 acquire 自身超时抛错会跳过 finally 的恢复
    const r1 = await acquireExportSlot()
    const r2 = await acquireExportSlot()
    try {
      await expect(acquireExportSlot(60)).rejects.toThrow('导出排队等待超时')
      // 超时者自摘队列：r1/r2 释放走「无 waiter 自减」——若死 waiter 未摘除，
      // r1() 会把名额转移给已 settled 的死 waiter（no-op）→ 永不归还，
      // 下方立即放行断言即红
      r1()
      r2()
      const rel = await acquireExportSlot()
      expect(rel).toBeTypeOf('function')
      rel()
    } finally {
      r1()
      r2()
    }
  })

  it('排队上限（8 waiter）→ 第 9 个直接拒「导出排队已达上限」', async () => {
    // 满载不带超时入参（理由同上）；8 个 waiter 逐调用传 250ms 全走超时出口（自摘队列）收尾
    const r1 = await acquireExportSlot()
    const r2 = await acquireExportSlot()
    try {
      const waiters = Array.from({ length: 8 }, () => acquireExportSlot(250))
      await new Promise((r) => setTimeout(r, 30)) // 让 8 个全部入队
      const ninth = acquireExportSlot(250)
      await expect(ninth).rejects.toThrow('导出排队已达上限')
      await expect(ninth).rejects.toBeInstanceOf(ExportSlotWaitError)
      const results = await Promise.allSettled(waiters)
      expect(results.every((x) => x.status === 'rejected')).toBe(true)
    } finally {
      r1()
      r2()
    }
  })
})

// ── Part B：export 端点 HTTP 分支 ──────────────────────────────

describe('R1010c-COV-3：export 端点入参与信封分支', () => {
  it('无 workDir 服务 → 400 NO_WORKDIR；不存在的书 → 404 NOT_FOUND', async () => {
    const nw = await noworkReq({ method: 'POST', path: '/api/books/x/export', body: { format: 'merged' } })
    expect(nw.status).toBe(400)
    expect(nw.json.code).toBe('NO_WORKDIR')
    const miss = await req({ method: 'POST', path: `/api/books/${encodeURIComponent('无此书')}/export`, body: { format: 'merged' } })
    expect(miss.status).toBe(404)
    expect(miss.json.code).toBe('NOT_FOUND')
  })

  it('非法 format / 非法 platform → 400 BAD_INPUT 且文案列合法值', async () => {
    const p = `/api/books/${encodeURIComponent('导出参数书')}/export`
    const badFormat = await req({ method: 'POST', path: p, body: { format: 'pdf' } })
    expect(badFormat.status).toBe(400)
    expect(badFormat.json.code).toBe('BAD_INPUT')
    expect(badFormat.json.error).toContain('merged')
    const badPlatform = await req({ method: 'POST', path: p, body: { format: 'merged', platform: 'kobo' } })
    expect(badPlatform.status).toBe(400)
    expect(badPlatform.json.code).toBe('BAD_INPUT')
    expect(badPlatform.json.error).toContain('平台')
  })

  it('缺省 format/platform 兜底（both/generic）；无定稿正文 → 422 EXPORT_FAILED', async () => {
    const r = await req({ method: 'POST', path: `/api/books/${encodeURIComponent('空书')}/export`, body: {} })
    expect(r.status).toBe(422)
    expect(r.json.code).toBe('EXPORT_FAILED')
    expect(r.json.error).toContain('没有定稿正文')
  }, 60_000)

  it('全局闸满载时导出 → 排队等待超时映射 503 BUSY（可重试语义）', async () => {
    // 专用实例：组装根 overrides 注入 80ms 短等待档（原模块级 setter 已删，主实例保持缺省）
    const soloWork = mkdtempSync(join(tmpdir(), 'clwriting-cov-io-solo-'))
    const soloServer = await startServerSafe({ port: 0, workDir: soloWork, overrides: { exportWaitTimeoutMs: 80 } })
    const soloBase = `http://127.0.0.1:${(soloServer!.address() as AddressInfo).port}`
    const soloToken = ((await (await fetch(`${soloBase}/api/boot`)).json()) as { token: string }).token
    try {
      makeBookIn(soloWork, '导出参数书')
      const r1 = await acquireExportSlot()
      const r2 = await acquireExportSlot()
      try {
        const r = await request(soloBase, soloToken, {
          method: 'POST',
          path: `/api/books/${encodeURIComponent('导出参数书')}/export`,
          body: { format: 'merged' },
        })
        expect(r.status).toBe(503)
        expect(r.json.code).toBe('BUSY')
        expect(r.json.error).toContain('导出排队等待超时')
      } finally {
        r1()
        r2()
      }
    } finally {
      if (soloServer) await new Promise<void>((r) => soloServer.close(() => r()))
      rmSync(soloWork, { recursive: true, force: true })
    }
  }, 30_000)
})
