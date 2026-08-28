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
import { startServer } from '../../src/studio/server/index.js'
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

/**
 * R71-2 窗口注入用：分片发 body——请求头先到（handler 同步过首检后在 readJson 等整包），
 * midHook 在包未发完的窗口内执行（测试在此 acquire 任务闸），随后补发剩余 body。
 */
function postStreaming(
  path: string,
  body: unknown,
  midHook: () => Promise<void>,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = JSON.stringify(body)
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
    // 先发一小片（handler 已派发、readJson 等待余量），窗口钩子后再补完
    req_.write(payload.slice(0, 6))
    void midHook().then(() => {
      req_.write(payload.slice(6))
      req_.end()
    })
  })
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
  server = startServer({ port: 0, workDir, userDataPath: join(workDir, 'userData') })
  await new Promise<void>((r) => server!.once('listening', r))
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
    const r = await postStreaming(`/api/books/${encodeURIComponent(BOOK)}/auto-write`, { chapter: 1 }, async () => {
      // readJson 等整包的窗口内占闸（首检时闸尚未持有，二次复查应拦截）
      await sleep(80)
      held[0] = acquireTaskGate(BOOK, 'lead-updates')
    })
    try {
      expect(r.status).toBe(409)
      expect(r.json?.code).toBe('BUSY')
      expect(String(r.json?.error)).toContain('任务在跑')
    } finally {
      held[0]?.()
    }
  })
})
