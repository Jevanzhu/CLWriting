/**
 * R71-1 / R71-2（总七十一轮）服务端互斥矩阵补角回归（参照 r67-server-discipline 写法）：
 * - R71-1：/spawn 入口补生成任务闸（heldTaskGatesFor）+ 三审闸（isReviewRunningForBook）
 *   反向互斥——此前只有 spawn/self-heal/chat 三闸，outline/onboard-ai 等分钟级任务或
 *   三审在途时仍可 /spawn，写手草稿与任务收尾覆盖写互踩
 * - R71-2：/auto-write 二次复查（readJson + ensureSession 两个 await 之后）补任务闸复检
 *   ——首检过后、二次复查前的窗口内新 acquire 的任务闸此前漏拦
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'
import { __setReviewRunning } from '../../src/studio/server/api/review.js'

const BOOK = 'R71互斥书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
const prevDriver = process.env['CLWRITING_DRIVER']

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      origin: baseUrl,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: any = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 留 null */
  }
  return { status: r.status, json }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  // ensureSession 在二次复查之前——mock driver 保证无 provider 也能建会话
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clw-r71-gates-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    ['spec_version: 1', 'book:', `  title: ${BOOK}`, '  genre: 玄幻'].join('\n') + '\n',
    'utf-8',
  )
  mkdirSync(join(workDir, 'userData'), { recursive: true })
  server = await startServerSafe({ port: 0, workDir, userDataPath: join(workDir, 'userData') })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await (await fetch(`${baseUrl}/api/boot`)).json()
  token = boot.token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  rmSync(workDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('R71-1: /spawn 入口任务闸 + 三审闸反向互斥', () => {
  it('生成任务闸（outline）在途 → POST /spawn 409 BUSY（任务在跑文案）', async () => {
    const release = acquireTaskGate(BOOK, 'outline')
    expect(release).not.toBeNull()
    try {
      const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/spawn`, {
        role: 'writer',
        prompt: '写第一章',
      })
      expect(r.status).toBe(409)
      expect(r.json?.code).toBe('BUSY')
      expect(String(r.json?.error)).toContain('任务在跑')
    } finally {
      release!()
    }
  })

  it('三审闸在途 → POST /spawn 409 BUSY（三审文案）', async () => {
    __setReviewRunning(BOOK, true)
    try {
      const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/spawn`, {
        role: 'writer',
        prompt: '写第一章',
      })
      expect(r.status).toBe(409)
      expect(r.json?.code).toBe('BUSY')
      expect(String(r.json?.error)).toContain('三审')
    } finally {
      __setReviewRunning(BOOK, false)
    }
  })
})

describe('R71-2: /auto-write 二次复查任务闸复检', () => {
  it('首检过后、body 发完前的窗口内 acquire 任务闸 → 409 BUSY（不再漏拦）', async () => {
    // holder 数组：TS5.5 CFA 对「闭包内赋值的 let」在 await 后误收窄 never，经索引读不触发
    const held: Array<(() => void) | null> = [null]
    // R27-123（二十七轮）：首检臂退化观测锚——原 sleep(80) 是纯时序赌注：慢派发下
    // 「占闸时首检尚未跑」则首检自身 409，测试照样绿但静默退化成首检臂（弱臂假覆盖）。
    // 早退探测：首检 409 会在 body 未发完时就 end 响应——占闸前响应已 end 即显式
    // 失败本用例，保证走到断言的一定是「首检已过 + 二次复查拦截」臂
    let earlyResponse = false
    const u = new URL(baseUrl)
    const payload = JSON.stringify({ chapter: 1 })
    const path = `/api/books/${encodeURIComponent(BOOK)}/auto-write`
    const resultP = new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req_ = http.request(
        {
          host: u.hostname,
          port: u.port,
          path,
          method: 'POST',
          headers: {
            'x-studio-token': token,
            origin: baseUrl,
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
          },
        },
        (res) => {
          let data = ''
          res.on('data', (c) => (data += c.toString('utf8')))
          res.on('end', () => {
            earlyResponse = true
            let json: any = null
            try {
              json = JSON.parse(data)
            } catch {
              /* 非 JSON */
            }
            resolve({ status: res.statusCode ?? 0, json })
          })
        },
      )
      req_.on('error', reject)
      req_.write(payload.slice(0, 6))
      void (async () => {
        await sleep(80)
        if (earlyResponse) {
          req_.destroy()
          throw new Error('首检臂退化：闸占位前响应已返回（80ms 内首检即 409），未覆盖二次复查臂')
        }
        held[0] = acquireTaskGate(BOOK, 'lead-updates')
        req_.write(payload.slice(6))
        req_.end()
      })().catch((e) => {
        held[0]?.()
        held[0] = null
        reject(e)
      })
    })
    const r = await resultP
    try {
      expect(r.status).toBe(409)
      expect(r.json?.code).toBe('BUSY')
      expect(String(r.json?.error)).toContain('任务在跑')
    } finally {
      held[0]?.()
    }
  })
})
