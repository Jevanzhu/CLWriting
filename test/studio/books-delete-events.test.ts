/**
 * DELETE /api/books/:name 删书清事件库回归测（GG-P2-3）：
 * 事件库按 bookHash(bookRoot) 落在 userDataPath/clwriting/session/，
 * 与书仓库分离——此前删书只清内存对话态，同名重建书会打开同一个 .db
 * 并在 audit 重放里继承旧书会话/链路事件。修复：删书时 clearChatHistory
 * 双键清库（book=书名 + book=bookHash(bookRoot)，Y-P2-7 口径）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { registerBackgroundTask } from '../../src/ai/orchestrate/background.js'

const BOOK = '删书事件测试书'
const BOOK2 = '删书后台任务测试书'
let workDir = ''
let userDataDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 响应留 null */
  }
  return { status: r.status, json }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-del-events-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'clwriting-del-user-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: `长篇/${BOOK}`, kind: 'long', created_at: '2026-01-01T00:00:00.000Z' }) + '\n' +
      JSON.stringify({ name: BOOK2, path: `长篇/${BOOK2}`, kind: 'long', created_at: '2026-01-01T00:00:00.000Z' }) + '\n',
    'utf-8',
  )
  writeFileSync(join(workDir, '.clwriting', 'active'), BOOK + '\n', 'utf-8')
  const bookAbs = join(workDir, '长篇', BOOK)
  mkdirSync(join(bookAbs, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookAbs, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${BOOK}\n  genre: 玄幻\nhost: cc\n`, 'utf-8')
  // 第二本：M-2 接线用（删书等待在途后台任务）
  const bookAbs2 = join(workDir, '长篇', BOOK2)
  mkdirSync(join(bookAbs2, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookAbs2, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${BOOK2}\n  genre: 玄幻\nhost: cc\n`, 'utf-8')

  // 播种旧书事件：对话会话（book=书名）+ 工作区会话（book=bookHash，ws- 前缀口径）
  const store = openSessionStore(userDataDir, bookAbs)
  const chatSid = store!.createSession(BOOK)
  store!.appendEvents(chatSid, [{ type: 'session/start', data: { reason: 'chat' } }])
  const wsSid = store!.createSession(bookHash(bookAbs))
  store!.appendEvents(wsSid, [{ type: 'session/start', data: { reason: 'workspace' } }])
  store!.close()

  server = startServer({ port: 0, workDir, userDataPath: userDataDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

describe('DELETE /api/books/:name 清事件库（GG-P2-3）', () => {
  it('删书后同名重建：事件库为空，不继承旧书会话', async () => {
    const bookAbs = join(workDir, '长篇', BOOK)
    // 删前：两种会话都在
    const before = openSessionStore(userDataDir, bookAbs)
    expect(before!.lastSeq()).toBeGreaterThan(0)
    before!.close()

    const del = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}`)
    expect(del.status).toBe(200)

    // 二轮复审（低级）：库文件本体一并删除（此前只清行，.db 永久滞留 userData 成孤儿；
    // 注意须在下方 openSessionStore 复开前断言——复开会重建空库文件）
    expect(existsSync(join(userDataDir, 'clwriting', 'session', bookHash(bookAbs) + '.db'))).toBe(false)

    // 删后：同一 bookRoot 的 .db 双键全清（lastSeq 归零）——同名重建即拿到空库
    const after = openSessionStore(userDataDir, bookAbs)
    expect(after!.lastSeq()).toBe(0)
    after!.close()
  })

  // M-2 接线回归（四轮复审）：定稿章摘要等 fire-and-forget 后台任务在途时删书——
  // 此前 settle 等待条件是 hadSelfHeal || hadChat，无 chat/self-heal 在途的纯后台任务
  // 场景整体跳过等待，rmSync 先行，straggler 对已删路径重建孤儿目录。接线收口后
  // 删书响应返回 = 后台任务必然已收尾（回退 hasBackgroundTasks 判定即红）。
  it('删书等待在途后台任务（无 chat/self-heal 时的摘要场景）', async () => {
    const bookAbs2 = join(workDir, '长篇', BOOK2)
    let taskDone = false
    registerBackgroundTask(
      BOOK2,
      (async () => {
        await new Promise((r) => setTimeout(r, 400))
        taskDone = true
      })(),
    )

    const del = await req('DELETE', `/api/books/${encodeURIComponent(BOOK2)}`)
    expect(del.status).toBe(200)
    expect(existsSync(bookAbs2)).toBe(false)
    // 删除已执行（响应已回）而任务已收尾——顺序反了（不等先删）时此处为 false
    expect(taskDone).toBe(true)
  })
})
