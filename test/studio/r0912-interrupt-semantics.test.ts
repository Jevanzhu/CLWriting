/**
 * R0912-P3-④ / R0912-P2-①（2026-09-11 重评-0911c 修复批）回归：/interrupt 语义保真。
 *
 * - R0912-P3-④：anyRunning 判定与 ensureSession await 之间的竞态窗——任务自然收尾后
 *   原实现仍 driver.interrupt，向零消费者 push 假 interrupted 事件；修复后 await 后
 *   复检，复检为假不下达中断。
 * - R0912-P2-①：返回值如实附 interrupted:true/false（不再无差别 {ok:true} 假成功）；
 *   对「已注册 ctrl 的任务」（波 2 将给 outline/review/analysis 等端点接 driver 注册面，
 *   本测以 owner='outline' 模拟同款接线）经 driver.isRunning 判真 → 真实中断路径
 *   （ctrl 被 abort + interrupted 事件推送可见）。
 *
 * 驱动方式：真实 server（不设 CLWRITING_DRIVER=mock → cc driver，ctrl 登记面真实）。
 * 竞态窗经 vi.mock driver/index.js 的 ensureSession 注入可控 await（其余导出原样透传）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { ccDriver } from '../../src/driver/cc.js'
import type { DriverEvent, Session } from '../../src/driver/types.js'
// ensureSession 经下方 vi.mock 包裹（其余保持原实现）；getSession/forgetSession 原样
import { ensureSession, getSession, forgetSession } from '../../src/driver/index.js'
import { __setSpawnRunning } from '../../src/ai/orchestrate/spawn-registry.js'

// ---- ensureSession 竞态注入（R0912-P3-④）：armed 时挂起直到测试放行 ----
const reFake = vi.hoisted(() => ({
  armed: false,
  release: null as null | (() => void),
}))
vi.mock('../../src/driver/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/driver/index.js')>()
  return {
    ...orig,
    ensureSession: (bookId: string, cwd: string) => {
      if (!reFake.armed) return orig.ensureSession(bookId, cwd)
      reFake.armed = false
      return new Promise((resolve, reject) => {
        reFake.release = (): void => {
          orig.ensureSession(bookId, cwd).then(resolve, reject)
        }
      })
    },
  }
})

const CTRL_BOOK = 'R0912注册ctrl书' // P2-①：波 2 式注册 ctrl 的任务
const RACE_BOOK = 'R0912竞态窗书' // P3-④：await 窗口内自然收尾
const EVENT_BOOK = 'R0912事件面书' // P3-④ 对照：复检真值 → 正常中断 + 事件
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
const prevDriver = process.env['CLWRITING_DRIVER']

function post(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'POST',
        headers: { 'x-studio-token': token, origin: baseUrl, 'content-length': '0' },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => {
          let json: Record<string, unknown> = {}
          try {
            json = JSON.parse(data) as Record<string, unknown>
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    r.end()
  })
}

const bp = (name: string): string => `/api/books/${encodeURIComponent(name)}/interrupt`

/** 带超时的 gen.next()——事件不到达即失败，不悬挂测试 */
function nextWithTimeout(gen: AsyncGenerator<DriverEvent>, ms = 2_000): Promise<DriverEvent> {
  return Promise.race([
    gen.next().then((r) => {
      if (r.done) throw new Error('stream 提前结束')
      return r.value
    }),
    new Promise<DriverEvent>((_, rej) => setTimeout(() => rej(new Error('interrupted 事件未到达')), ms).unref()),
  ])
}

beforeAll(async () => {
  delete process.env['CLWRITING_DRIVER'] // cc driver：registerCtrl/isRunning/interrupt 真实
  workDir = mkdtempSync(join(tmpdir(), 'clw-r0912-interrupt-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    [CTRL_BOOK, RACE_BOOK, EVENT_BOOK]
      .map((name) => JSON.stringify({ name, path: name, kind: 'long' }))
      .join('\n') + '\n',
  )
  for (const name of [CTRL_BOOK, RACE_BOOK, EVENT_BOOK]) {
    const bookRoot = join(workDir, name)
    mkdirSync(bookRoot, { recursive: true })
    writeFileSync(join(bookRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${name}\n  genre: 玄幻\n`)
  }
  server = await startServerSafe({ port: 0, workDir, userDataPath: join(workDir, 'userData') })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await (await fetch(`${baseUrl}/api/boot`)).json()
  token = (boot as { token: string }).token
})

afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
  }
  rmSync(workDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('R0912-P2-①: /interrupt 对已注册 ctrl 的任务语义保真', () => {
  it('波 2 式注册 ctrl（owner=outline）→ 200 {interrupted:true} + ctrl 被 abort + interrupted 事件可见', async () => {
    const session = await ensureSession(CTRL_BOOK, workDir)
    const ctrl = new AbortController()
    ccDriver.registerCtrl!(session, ctrl, 'outline') // 波 2 端点将采用的同款注册面
    expect(ccDriver.isRunning?.(session)).toBe(true)

    // 先接消费者——中断事件必须对在订前端可见（与 spawn watchdog 修复前「只 abort 不推
    // 事件」的分叉面区分开）
    const gen = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
    const pending = nextWithTimeout(gen)
    try {
      const r = await post(bp(CTRL_BOOK))
      expect(r.status).toBe(200)
      expect(r.json).toMatchObject({ ok: true, interrupted: true })
      expect(ctrl.signal.aborted).toBe(true)
      const ev = await pending
      expect(ev.type).toBe('interrupted')
    } finally {
      void gen.return(undefined).catch(() => {})
      forgetSession(CTRL_BOOK)
    }
  })
})

describe('R0912-P3-④: /interrupt 竞态窗复检', () => {
  it('anyRunning 判真后、ensureSession await 期间任务自然收尾 → 复检拦截：不 interrupt、不推假事件、interrupted:false', async () => {
    // cc.interrupt 运行时恒已定义（cc.ts 实装），类型上 optional——spyOn 面收窄
    const interruptSpy = vi.spyOn(
      ccDriver as typeof ccDriver & { interrupt: NonNullable<typeof ccDriver.interrupt> },
      'interrupt',
    )
    reFake.armed = true
    reFake.release = null
    __setSpawnRunning(RACE_BOOK, true) // 首检真值来源（spawn 闸）
    try {
      const p = post(bp(RACE_BOOK))
      // 等 handler 走到被闸住的 ensureSession（mock 被调用即挂起）
      for (let i = 0; i < 500 && !reFake.release; i++) {
        await new Promise((r) => setImmediate(r))
      }
      // 显式宽化注记：vi.mock 闭包内的赋值 TS 不可见，防 CFA 把 release 收窄成 null/never
      const release = reFake.release as (() => void) | null
      if (!release) throw new Error('ensureSession 未被闸住（竞态注入失效）')
      // await 窗口内「任务自然收尾」——修复前此窗口之后仍 driver.interrupt → 零消费者假事件
      __setSpawnRunning(RACE_BOOK, false)
      release()
      const r = await p
      expect(r.status).toBe(200)
      expect(r.json).toMatchObject({ ok: true, interrupted: false })
      expect(interruptSpy).not.toHaveBeenCalled()
    } finally {
      __setSpawnRunning(RACE_BOOK, false)
      forgetSession(RACE_BOOK)
      interruptSpy.mockRestore()
    }
  })

  it('对照：复检仍真值 → 正常下达中断（interrupted:true + interrupted 事件推送）', async () => {
    __setSpawnRunning(EVENT_BOOK, true)
    try {
      const r = await post(bp(EVENT_BOOK)) // ensureSession 未武装 → 真实快路径
      expect(r.status).toBe(200)
      expect(r.json).toMatchObject({ ok: true, interrupted: true })
      // cc.interrupt 已推 interrupted（此刻无消费者 → pre 暂存，首消费者接管）
      const session = getSession(EVENT_BOOK) as Session
      expect(session).not.toBeNull()
      const gen = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
      try {
        const ev = await nextWithTimeout(gen)
        expect(ev.type).toBe('interrupted')
      } finally {
        void gen.return(undefined).catch(() => {})
      }
    } finally {
      __setSpawnRunning(EVENT_BOOK, false)
      forgetSession(EVENT_BOOK)
    }
  })
})
