/**
 * 事件保留定版（2026-08-16 拍板：全量保留 + 手动清理）：DELETE /api/books/:name/audit
 * 清除本书全部事件——对话会话（book=bookName）与工作流会话（book=bookHash）两侧；
 * token 校验、书不存在 404、清后审计视图回到空态。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { SessionRecorder, sessionStartEvent, userMessageEvent } from '../../src/events/chat-bridge.js'
import { stepStartEvent } from '../../src/events/chain-bridge.js'

const BOOK = '清事件书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-audit-clear-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-audit-clear-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 清事件书\n  genre: 玄幻\nhost: cc\n',
  )

  // 种两侧事件：对话会话（book=bookName）+ 工作流会话（book=bookHash）
  const store = openSessionStore(userDataPath, bookRoot)!
  try {
    const chatSid = store.createSession(BOOK, { book: BOOK })
    const rec = new SessionRecorder(store, chatSid)
    rec.add(sessionStartEvent(BOOK))
    rec.add(userMessageEvent('旧对话', 1))
    rec.close('completed')

    const wsSid = store.workspaceSession(bookHash(bookRoot))
    store.appendEvents(wsSid, [stepStartEvent('chat', 'chat')])
  } finally {
    store.close()
  }

  server = startServer({ port: 0, workDir, userDataPath })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

function del(path: string, withToken = true): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'DELETE',
        headers: { origin: baseUrl, ...(withToken ? { 'x-studio-token': token } : {}) },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON 留 null */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** 两侧事件计数（对话 bookName 键 + 工作流 bookHash 键）。 */
function eventCounts(): { convo: number; workflow: number } {
  const bookRoot = join(workDir, BOOK)
  const store = openSessionStore(userDataPath, bookRoot)!
  try {
    return {
      convo: store.listEvents(BOOK).length,
      workflow: store.listEvents(bookHash(bookRoot)).length,
    }
  } finally {
    store.close()
  }
}

describe('DELETE /api/books/:name/audit（事件保留定版：手动清理）', () => {
  it('预置两侧事件在库（前置校验）', () => {
    expect(eventCounts()).toEqual({ convo: 3, workflow: 1 }) // start+user+end（SessionRecorder 收尾自动补 session/end）
  })

  it('无 token → 403（销毁端点 defense-in-depth）', async () => {
    const r = await del(`/api/books/${encodeURIComponent(BOOK)}/audit`, false)
    expect(r.status).toBe(403)
    expect(eventCounts().convo).toBe(3)
  })

  it('书不存在 → 404', async () => {
    const r = await del(`/api/books/${encodeURIComponent('无此书')}/audit`)
    expect(r.status).toBe(404)
  })

  it('带 token → 200 且对话+工作流两侧全清', async () => {
    const r = await del(`/api/books/${encodeURIComponent(BOOK)}/audit`)
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean }).ok).toBe(true)
    expect(eventCounts()).toEqual({ convo: 0, workflow: 0 })
  })

  it('清后审计视图回空态（GET 不再返回事件）', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/audit`, {
      headers: { origin: baseUrl, 'x-studio-token': token },
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { conversation: unknown; workflowTotal: number }
    expect(j.conversation).toBeNull()
    expect(j.workflowTotal).toBe(0)
  })

  it('重复清除 → 幂等 200', async () => {
    const r = await del(`/api/books/${encodeURIComponent(BOOK)}/audit`)
    expect(r.status).toBe(200)
    expect(eventCounts()).toEqual({ convo: 0, workflow: 0 })
  })
})
