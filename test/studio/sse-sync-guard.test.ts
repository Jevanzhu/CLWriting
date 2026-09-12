/**
 * B-20（第六十轮）回归：SSE 初始 sync 快照走 createSseWriter 守卫。
 *
 * stream.ts 的初始 sync 帧此前裸 res.write（写在 safeWrite 创建之前）——断连边沿
 * 对已死连接裸写一次，与 P-8 全链守卫口径不一致。修复：safeWrite 创建前移，sync
 * 走 safeWrite（destroyed/writableEnded 守卫 + 背压判死全覆盖）。
 * 本测试经真实 server 锚定行为契约：①首帧仍为 sync 快照（守卫路径正常投递）；
 * ②客户端断开后服务存活（后续请求正常应答）。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio。
 */
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = 'SSE同步守卫书'
let studio: StudioHarness

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-sse-sync-',
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: SSE同步守卫书\n  genre: 玄幻\nhost: cc\n',
  })
})

afterAll(() => studio.close())

describe('B-20: 初始 sync 帧走 safeWrite 守卫', () => {
  it('首帧为 sync 快照；客户端断开后服务存活', async () => {
    const ac = new AbortController()
    const r = await fetch(
      `${studio.baseUrl}/api/books/${encodeURIComponent(BOOK)}/stream?token=${encodeURIComponent(studio.token)}`,
      { signal: ac.signal },
    )
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    const reader = r.body!.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value!)).toContain('"type":"sync"')
    // 断开（close 回调走计数递减/心跳清理路径——含 safeWrite 守卫的断连边沿）
    const abortAt = Date.now() // 断连危险窗起点
    ac.abort()
    // 重评2-P3-①（2026-09-09 全量重评 GLM-5.3）：原固定 sleep(100) 等断连 close 边沿
    // ——与「测试竞速轮询化」家规不一致。改墙钟轮询越过危险窗（重审-18 elapseBeyond
    // 同款）：小步 poll 让出事件循环；终检留在窗后——断连边沿处理若致进程崩（守卫
    // 失效形态），窗内任何时刻的崩都会被终检 fetch 抓到
    await vi.waitFor(() => expect(Date.now() - abortAt).toBeGreaterThanOrEqual(100), { timeout: 5_000, interval: 10 })
    // 服务存活：后续请求正常应答（裸写已死连接未把进程带崩）
    const boot = await fetch(`${studio.baseUrl}/api/boot`)
    expect(boot.status).toBe(200)
  })
})
