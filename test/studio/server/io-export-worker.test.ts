/**
 * B-23 + B-24（第六十轮补修）回归：
 *
 * - B-24：/export 端点改经 worker 线程执行同步导出内核（此前直调 exportBook，
 *   大书导出独占服务进程事件循环——全部书的 SSE 心跳/保存停摆；S3 task-gate 只
 *   闸每书并发数）。本文件以**真实 worker 往返**断言成功/业务失败两路域契约，
 *   另直测 run-async 超时拒绝与非阻塞语义（注入慢 worker）。
 * - B-23：业务失败回 422 {code:'EXPORT_FAILED', error} 错误信封——原 200
 *   {ok:false} 是全域错误信封唯一豁免点（「apiJson 吞诊断」旧理由已被 dv-01
 *   错误信封判别取代）；前端侧对齐见 test/studio/webnext/api-io.test.ts。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../../helpers/safe-port.js'
import { runExportBookAsync } from '../../../src/export/run-async.js'
import { createTaskGate } from '../../../src/studio/server/api/task-gate.js'
import { __getInFlightWorkCount } from '../../../src/studio/server/api/in-flight-work.js'
import { createStudioServer, type StudioServerHandle } from '../../../src/studio/server/index.js'
import { processProviderRuntime } from '../../../src/ai/provider/store.js'
import type { DriverHost } from '../../../src/studio/server/driver-port.js'
import type { DriverEvent, Session } from '../../../src/driver/types.js'

const BOOK_OK = '导出worker测试书'
const BOOK_EMPTY = '导出空书'
const BOOK_DRAFT = '导出含草稿书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      origin: baseUrl,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 留 null */
  }
  return { status: r.status, json }
}

// 60s 帽：CI 慢机重负载下 beforeAll（三书建具 + 起服 + boot 取 token）可超
// vitest 缺省 10s hookTimeout；建具纯 IO/网络监听无断言语义，放宽不弱化守卫。
beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-export-worker-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    [BOOK_OK, BOOK_EMPTY, BOOK_DRAFT].map((n) => JSON.stringify({ name: n, path: n, kind: 'long' })).join('\n') + '\n',
  )
  const okRoot = join(workDir, BOOK_OK)
  mkdirSync(join(okRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(okRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 导出worker测试书\n  genre: 玄幻\nhost: cc\n',
  )
  writeFileSync(join(okRoot, '写作', '正文', '1-第一章.md'), '---\n章号: 1\n标题: 第一章\n---\n雪落在了城墙上。')
  // 空书：book.yaml 在、无 写作/正文 目录 → exportBook 业务失败「没有定稿正文可导出」
  const emptyRoot = join(workDir, BOOK_EMPTY)
  mkdirSync(emptyRoot, { recursive: true })
  writeFileSync(
    join(emptyRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 导出空书\n  genre: 玄幻\nhost: cc\n',
  )
  // 含草稿书：两章正文、清单只登记第 1 章定稿 → 服务端信封应透传 skippedDrafts=1
  //（0917清库修复批：skippedDrafts 透传前端回归夹具；清单直写 jsonl——worker 线程
  // 独立进程态，不受本进程清单指纹缓存影响）
  const draftRoot = join(workDir, BOOK_DRAFT)
  mkdirSync(join(draftRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(draftRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 导出含草稿书\n  genre: 玄幻\nhost: cc\n',
  )
  writeFileSync(join(draftRoot, '写作', '正文', '1-已定稿章.md'), '---\n章号: 1\n标题: 已定稿章\n---\n定稿内容。')
  writeFileSync(join(draftRoot, '写作', '正文', '2-未定稿章.md'), '---\n章号: 2\n标题: 未定稿章\n---\n还在写的半成品。')
  mkdirSync(join(draftRoot, '项目'), { recursive: true })
  writeFileSync(
    join(draftRoot, '项目', '文档清单.jsonl'),
    [
      JSON.stringify({ type: 'header', version: 1 }),
      JSON.stringify({
        id: 'doc_1',
        nodeType: 'document',
        path: '写作/正文/1-已定稿章.md',
        parentId: null,
        finalizedRevision: 'sha256:fin-1',
      }),
      JSON.stringify({ id: 'doc_2', nodeType: 'document', path: '写作/正文/2-未定稿章.md', parentId: null }),
    ].join('\n') + '\n',
  )
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
}, 60_000)

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('B-24: /export 经 worker 线程执行（真实 worker 往返）', () => {
  it('有定稿正文 → 200 域形状（chapterCount/unit/files，worker 内核执行）', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK_OK)}/export`, { format: 'merged' })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; chapterCount?: number; unit?: string; finalizedFilter?: string }
    expect(body.ok).toBe(true)
    expect(body.chapterCount).toBe(1)
    expect(body.unit).toBe('章')
    // 清偿-导出未过滤提示（2026-09-09 残留清偿批）：信封透传过滤标记（fixture 无清单
    // → skipped-no-manifest，前端据此明示含未定稿章）
    expect(body.finalizedFilter).toBe('skipped-no-manifest')
  })

  it('B-23: 无定稿正文 → 422 EXPORT_FAILED 错误信封（原 200 {ok:false} 豁免点收口）', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK_EMPTY)}/export`, { format: 'both' })
    expect(r.status).toBe(422)
    const body = r.json as { code: string; error: string }
    expect(body.code).toBe('EXPORT_FAILED')
    expect(body.error).toBe('没有定稿正文可导出。')
  })

  it('有未定稿章被滤除 → 200 信封透传 skippedDrafts 计数（前端跳过可见性）', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK_DRAFT)}/export`, { format: 'merged' })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; chapterCount?: number; skippedDrafts?: number; finalizedFilter?: string }
    expect(body.ok).toBe(true)
    expect(body.chapterCount).toBe(1)
    // 0917清库修复批：服务端信封带 skippedDrafts（内核 ExportResult 早有此字段，
    // 此前漏发致前端无法提示「已跳过 N 个草稿章」）
    expect(body.skippedDrafts).toBe(1)
    expect(body.finalizedFilter).toBe('applied')
  })

  // ── txt 导出批（output 参数贯通 worker 内核 + 非法值显式拒）──
  it('output=txt → 200，files 落 导出/纯文本/，产物为无 `#` 标记的纯文本', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK_OK)}/export`, {
      format: 'merged',
      output: 'txt',
    })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; files?: string[] }
    expect(body.ok).toBe(true)
    expect(body.files).toEqual(['工作区/导出/纯文本/全本-导出worker测试书.txt'])
    const text = readFileSync(join(workDir, BOOK_OK, '工作区', '导出', '纯文本', '全本-导出worker测试书.txt'), 'utf-8')
    expect(text).toBe('第一章\n\n雪落在了城墙上。')
  })

  it('非法 output → 400 BAD_INPUT 点名 output（不静默按 md 处理）', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK_OK)}/export`, { format: 'merged', output: 'rtf' })
    expect(r.status).toBe(400)
    const body = r.json as { code: string; error: string }
    expect(body.code).toBe('BAD_INPUT')
    expect(body.error).toContain('非法输出形态')
    expect(body.error).toContain('rtf')
  })
})

describe('B-24: runExportBookAsync 直测（注入 workerUrl/timeoutMs）', () => {
  it('超时拒绝：慢 worker（300ms）× timeoutMs 20 → 抛「导出超时」且终止线程', async () => {
    const slow = new URL('../io-export-slow-worker.ts', import.meta.url)
    await expect(
      runExportBookAsync(
        { bookRoot: '/nonexistent', format: 'merged', platform: 'generic' },
        { workerUrl: slow, timeoutMs: 20 },
      ),
    ).rejects.toThrow('导出超时')
  })

  it('非阻塞语义：慢 worker 在途期间事件循环可推进（定时器先于导出完成）', async () => {
    const slow = new URL('../io-export-slow-worker.ts', import.meta.url)
    const pending = runExportBookAsync(
      { bookRoot: '/nonexistent', format: 'merged', platform: 'generic' },
      { workerUrl: slow, timeoutMs: 5_000 },
    )
    let ticked = false
    await new Promise((r) =>
      setTimeout(() => {
        ticked = true
        r(null)
      }, 50),
    )
    expect(ticked).toBe(true) // 若同步内核仍在服务线程，此 await 前的定时器无法兑现
    const result = await pending
    expect(result).toEqual({ ok: true, via: 'slow-worker' })
  })
})

// ── 取消通道：客户端断连 / 服务关停不再把闸槽占满到超时档 ────────────────
// 机理：runWorkerJob 收 AbortSignal，abort 即 terminate worker 并以取消码（ABORTED）
// 拒绝；端点 finally 随即释放 task-gate 槽与全局名额。断言只锚可观察面——promise 的
// 结算码、闸/名额/在途登记状态、产物字节完整性——不锚日志文本。

/** 等待条件成立（轮询）；超时抛错（用例据此判红而非挂死） */
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`等待超时：${what}`)
}

/** 替身 driver 宿主（取消用例的独立实例用）：会话表随宿主实例隔离，全成员 no-op；
 *  导出端点不碰 AI 面，替身只满足组装根的依赖契约。 */
function makeHost(): DriverHost {
  const sessions = new Map<string, Session>()
  const driver = {
    startSession: async (cwd: string): Promise<Session> => ({ id: `s-${cwd}`, cwd, closed: false }),
    stream: async function* (): AsyncGenerator<DriverEvent> {},
    dispose: () => {},
    emit: () => {},
    cancelStream: () => {},
    interrupt: () => {},
    isRunning: () => false,
    isWriterRunning: () => false,
    registerCtrl: () => {},
    unregisterCtrl: () => {},
  }
  return {
    driver,
    kind: 'mock',
    ensureSession: async (bookId, cwd) => {
      const existing = sessions.get(bookId)
      if (existing) return existing
      const s = await driver.startSession(cwd)
      sessions.set(bookId, s)
      return s
    },
    getSession: (bookId) => sessions.get(bookId) ?? null,
    forgetSession: (bookId) => {
      sessions.delete(bookId)
    },
  }
}

/** 慢 worker：收 job 后 30s 才回包（远长于用例墙钟断言档，用于区分「已取消」与「已跑完」） */
const VERY_SLOW_WORKER = `
import { parentPort } from 'node:worker_threads'
parentPort.once('message', () => setTimeout(() => parentPort.postMessage({ ok: true, files: [], chapterCount: 0, unit: '章', finalizedFilter: 'applied' }), 30_000))
`

describe('导出取消通道（AbortSignal → terminate + 取消语义）', () => {
  it('直测：abort 后 promise 以取消码 ABORTED 结算（远早于 worker 完成），未 abort 的同 worker 照常返回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clw-export-cancel-'))
    try {
      const script = join(dir, 'very-slow.mjs')
      writeFileSync(script, VERY_SLOW_WORKER, 'utf-8')
      const ctrl = new AbortController()
      const t0 = Date.now()
      const aborted = runExportBookAsync(
        { bookRoot: '/nonexistent', format: 'merged', platform: 'generic' },
        { workerUrl: pathToFileURL(script), timeoutMs: 60_000, signal: ctrl.signal },
      )
      ctrl.abort() // 在途取消：立即 settle（不依赖 worker 配合，域内核为全同步循环）
      await expect(aborted).rejects.toMatchObject({ code: 'ABORTED' })
      expect(Date.now() - t0).toBeLessThan(3_000) // 未取消则要等 30s worker / 60s 超时档

      // 未 abort 的导出不受影响：同 worker 换新 signal（不传 signal）照常拿到结果
      const slow = new URL('../io-export-slow-worker.ts', import.meta.url)
      const ok = await runExportBookAsync(
        { bookRoot: '/nonexistent', format: 'merged', platform: 'generic' },
        { workerUrl: slow, timeoutMs: 5_000 },
      )
      expect(ok).toEqual({ ok: true, via: 'slow-worker' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('端点：客户端断连 → 取消语义收口，task-gate 槽/全局名额/在途登记立即归位（次轮导出照常）', async () => {
    const cancelWork = mkdtempSync(join(tmpdir(), 'clw-export-cancel-ep-'))
    const scriptDir = mkdtempSync(join(tmpdir(), 'clw-export-cancel-js-'))
    let soloHandle: StudioServerHandle | undefined
    try {
      const script = join(scriptDir, 'very-slow.mjs')
      writeFileSync(script, VERY_SLOW_WORKER, 'utf-8')
      mkdirSync(join(cancelWork, '.clwriting'), { recursive: true })
      writeFileSync(
        join(cancelWork, '.clwriting', 'books.jsonl'),
        JSON.stringify({ name: BOOK_OK, path: BOOK_OK, kind: 'long' }) + '\n',
      )
      const root = join(cancelWork, BOOK_OK)
      mkdirSync(join(root, '写作', '正文'), { recursive: true })
      // book.yaml 的 title 必须与登记名一致：启动自愈以 title 为准回写登记名，
      // 不一致会让按登记名的解析落到 404
      writeFileSync(join(root, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${BOOK_OK}\n  genre: 玄幻\n`)
      writeFileSync(join(root, '写作', '正文', '1-第一章.md'), '---\n章号: 1\n标题: 第一章\n---\n雪落在了城墙上。')
      // 独立实例 + 独立闸：断言落在本实例的闸上（不借道进程默认闸，避免同文件多实例互扰）
      const host = makeHost()
      const soloGate = createTaskGate({ lockRoot: join(cancelWork, '.clwriting', 'task-gate'), driver: host })
      soloHandle = createStudioServer(
        {
          port: 0,
          workDir: cancelWork,
          mirrorConsoleLog: false,
          studioToken: 'tok-export-cancel',
          overrides: { exportWorkerUrl: pathToFileURL(script) },
        },
        { taskGate: soloGate, driver: host, providers: processProviderRuntime() },
      )
      if (!soloHandle.server.listening) {
        await new Promise<void>((r) => soloHandle!.server.once('listening', () => r()))
      }
      const soloBase = `http://127.0.0.1:${(soloHandle.server.address() as AddressInfo).port}`
      const soloToken = 'tok-export-cancel'
      const exportOf = (signal: AbortSignal): Promise<Response | null> =>
        fetch(`${soloBase}/api/books/${encodeURIComponent(BOOK_OK)}/export`, {
          method: 'POST',
          headers: { 'x-studio-token': soloToken, origin: soloBase, 'content-type': 'application/json' },
          body: JSON.stringify({ format: 'merged' }),
          signal,
        }).catch(() => null) // 断连/取消后请求必然失败，返回值不用

      const inflightCountBefore = __getInFlightWorkCount()
      const ac = new AbortController()
      const inflight = exportOf(ac.signal)
      // 等作业真在途（槽被占）再断连——否则测的是「没起过」的空态
      await waitFor(() => soloGate.isHeld(BOOK_OK, 'export'), 5_000, '导出作业占住 task-gate 槽')
      const t0 = Date.now()
      ac.abort()
      // 取消后的主收益：槽立刻归位（未取消则占满 30s worker 时长 / 120s 超时档）
      await waitFor(() => !soloGate.isHeld(BOOK_OK, 'export'), 5_000, 'task-gate 槽在取消后释放')
      expect(Date.now() - t0).toBeLessThan(5_000)
      await waitFor(() => __getInFlightWorkCount() === inflightCountBefore, 5_000, '在途外部工作登记清零')
      await inflight

      // 全局名额同源归位：次轮导出能重新占住槽（名额未泄则 503/排队→本断言超时）
      const ac2 = new AbortController()
      const second = exportOf(ac2.signal)
      await waitFor(() => soloGate.isHeld(BOOK_OK, 'export'), 5_000, '次轮导出可再次占槽（名额已归位）')
      ac2.abort()
      await waitFor(() => !soloGate.isHeld(BOOK_OK, 'export'), 5_000, '次轮取消后槽再次释放')
      await second
    } finally {
      if (soloHandle) await new Promise<void>((r) => soloHandle!.close(() => r()))
      rmSync(cancelWork, { recursive: true, force: true })
      rmSync(scriptDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('端点：真实内核导出被取消后不留半成品产物（产物要么完整要么不存在）', async () => {
    const bigWork = mkdtempSync(join(tmpdir(), 'clw-export-cancel-art-'))
    let bigServer: http.Server | undefined
    try {
      const CHAPTERS = 40
      mkdirSync(join(bigWork, '.clwriting'), { recursive: true })
      writeFileSync(
        join(bigWork, '.clwriting', 'books.jsonl'),
        JSON.stringify({ name: BOOK_OK, path: BOOK_OK, kind: 'long' }) + '\n',
      )
      const root = join(bigWork, BOOK_OK)
      mkdirSync(join(root, '写作', '正文'), { recursive: true })
      writeFileSync(join(root, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${BOOK_OK}\n  genre: 玄幻\n`)
      const payload = '正文内容。'.repeat(6_000)
      for (let i = 1; i <= CHAPTERS; i++) {
        // 末章特厚（约 24MB）：全本流式写的最后一个 append 持续数百毫秒，
        // 取消点必落在写入段内（前 39 章属读-净化-追加，量级远小于它）
        const body = i === CHAPTERS ? '终章内容。'.repeat(1_200_000) : payload
        writeFileSync(
          join(root, '写作', '正文', `${i}-第${i}章.md`),
          `---\n章号: ${i}\n标题: 第${i}章\n---\n${body}`,
          'utf-8',
        )
      }
      bigServer = await startServerSafe({ port: 0, workDir: bigWork })
      const bigBase = `http://127.0.0.1:${(bigServer.address() as AddressInfo).port}`
      const bigToken = ((await (await fetch(`${bigBase}/api/boot`)).json()) as { token: string }).token

      const exportDir = join(root, '工作区', '导出')
      const tmpPattern = /^\..*\.tmp$/
      const ac = new AbortController()
      const inflight = fetch(`${bigBase}/api/books/${encodeURIComponent(BOOK_OK)}/export`, {
        method: 'POST',
        headers: { 'x-studio-token': bigToken, origin: bigBase, 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'merged' }),
        signal: ac.signal,
      }).catch(() => null)
      // 等到内核的流式临时文件出现再取消——此刻必在写入段内（原子写的 tmp 是
      // 唯一可观察的写入中信号：产物名只在完整发布时才出现）
      await waitFor(
        () => existsSync(exportDir) && readdirSync(exportDir).some((f) => tmpPattern.test(f)),
        15_000,
        '全本流式写入的临时文件出现（进入写入段）',
      )
      ac.abort()
      await inflight

      // 核心不变量：产物名要么不存在（写入被中断，目标未 rename），要么是整稿
      //（原子写的发布语义——目标文件不存在中间态）
      const entries = existsSync(exportDir) ? readdirSync(exportDir) : []
      // 目录内容只有两类合法形态：完整产物，或原子写的未发布临时文件（点号前缀 +
      // .tmp 后缀，交崩溃残留清扫回收）。半截产物名不进盘——产物只经 rename 发布。
      for (const name of entries) {
        if (tmpPattern.test(name)) continue
        const text = readFileSync(join(exportDir, name), 'utf-8')
        expect(text).toContain('# 第1章')
        expect(text).toContain(`# 第${CHAPTERS}章`)
        expect(text.split(/^# /m).length - 1).toBe(CHAPTERS)
      }
      // 取消点确实落在写入段（临时文件先于取消出现）：中断的写入只留临时文件，
      // 产物名不出现（若已发布则上方完整性断言恒真——两种形态都无半成品）
      expect(entries.every((f) => tmpPattern.test(f) || f.startsWith('全本-'))).toBe(true)
    } finally {
      if (bigServer) await new Promise<void>((r) => bigServer!.close(() => r()))
      rmSync(bigWork, { recursive: true, force: true })
    }
  }, 60_000)

  it('端点：服务关停（close）取消在途导出——在取消语义收口，闸槽不等作业自然结束', async () => {
    const shutWork = mkdtempSync(join(tmpdir(), 'clw-export-cancel-shut-'))
    const scriptDir = mkdtempSync(join(tmpdir(), 'clw-export-cancel-shut-js-'))
    let shutHandle: StudioServerHandle | undefined
    try {
      const script = join(scriptDir, 'very-slow.mjs')
      writeFileSync(script, VERY_SLOW_WORKER, 'utf-8')
      mkdirSync(join(shutWork, '.clwriting'), { recursive: true })
      writeFileSync(
        join(shutWork, '.clwriting', 'books.jsonl'),
        JSON.stringify({ name: BOOK_OK, path: BOOK_OK, kind: 'long' }) + '\n',
      )
      const root = join(shutWork, BOOK_OK)
      mkdirSync(join(root, '写作', '正文'), { recursive: true })
      writeFileSync(join(root, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${BOOK_OK}\n  genre: 玄幻\n`)
      writeFileSync(join(root, '写作', '正文', '1-第一章.md'), '---\n章号: 1\n标题: 第一章\n---\n雪落在了城墙上。')
      // 独立实例：关停取消登记归实例，断言落本实例的闸与在途登记（不与文件级共享实例串扰）
      const host = makeHost()
      const shutGate = createTaskGate({ lockRoot: join(shutWork, '.clwriting', 'task-gate'), driver: host })
      shutHandle = createStudioServer(
        {
          port: 0,
          workDir: shutWork,
          mirrorConsoleLog: false,
          studioToken: 'tok-export-shutdown',
          overrides: { exportWorkerUrl: pathToFileURL(script) },
        },
        { taskGate: shutGate, driver: host, providers: processProviderRuntime() },
      )
      if (!shutHandle.server.listening) {
        await new Promise<void>((r) => shutHandle!.server.once('listening', () => r()))
      }
      const shutBase = `http://127.0.0.1:${(shutHandle.server.address() as AddressInfo).port}`
      const inflightCountBefore = __getInFlightWorkCount()
      const inflight = fetch(`${shutBase}/api/books/${encodeURIComponent(BOOK_OK)}/export`, {
        method: 'POST',
        headers: { 'x-studio-token': 'tok-export-shutdown', origin: shutBase, 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'merged' }),
      })
      await waitFor(() => shutGate.isHeld(BOOK_OK, 'export'), 5_000, '导出作业占住槽（关停前在途）')
      expect(__getInFlightWorkCount()).toBe(inflightCountBefore + 1)

      const t0 = Date.now()
      const closed = new Promise<void>((r) => shutHandle!.close(() => r()))
      // 主收益：关停触发取消 → 槽与在途登记立刻归位（未取消则要占满 30s worker 时长）
      await waitFor(() => !shutGate.isHeld(BOOK_OK, 'export'), 5_000, '关停取消后槽释放')
      await waitFor(() => __getInFlightWorkCount() === inflightCountBefore, 5_000, '关停取消后在途登记归零')
      expect(Date.now() - t0).toBeLessThan(5_000)
      // 客户端侧收取消语义（499 = 全仓取消码 HTTP 映射），不是超时档文案
      const shutRes = await inflight
      expect(shutRes.status).toBe(499)
      expect((await shutRes.json()) as { code: string }).toMatchObject({ code: 'ABORTED' })
      // close 回调等在途连接收线：Node 的 close 只摘「调用瞬间」的空闲连接，
      // 关停时正在途的连接转空闲后要等 keepAliveTimeout——测试侧主动收线（桌面退出链
      // 同样显式 closeIdleConnections，故生产关停有界性不依赖本用例）
      shutHandle.server.closeAllConnections()
      await closed
    } finally {
      shutHandle?.server.closeAllConnections()
      rmSync(shutWork, { recursive: true, force: true })
      rmSync(scriptDir, { recursive: true, force: true })
    }
  }, 30_000)
})
