/**
 * N3（五十九轮）回归：workspaceSession SELECT→INSERT 包 BEGIN IMMEDIATE。
 *
 * 双进程并行首开同书：旧裸 SELECT→INSERT 竞态会分裂两个 ws 会话（链路事件分裂
 * 写入两处，审计/重放丢半）。真双进程行为级验证（同 test/ai/calls-cross-process
 * 模式）：3 个子进程并发首开同一书库，终态必须只有 1 个 ws 会话且三方拿到同一 id。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it, expect, afterAll } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { bookHash } from '../../src/events/store.js'

const dir = mkdtempSync(join(tmpdir(), 'n3-ws-race-'))
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const storePath = fileURLToPath(new URL('../../src/events/store.ts', import.meta.url))

/** 子进程：开库 → workspaceSession → 落 1 条链路事件 → close，stdout 打印 ws id */
function spawnWorker(userDataPath: string, bookRoot: string): Promise<string> {
  const script = `
import { openSessionStore, bookHash } from ${JSON.stringify(pathToFileURL(storePath).href)}
const store = openSessionStore(${JSON.stringify(userDataPath)}, ${JSON.stringify(bookRoot)})!
try {
  const book = bookHash(${JSON.stringify(bookRoot)})
  const ws = store.workspaceSession(book)
  store.appendEvent(ws, { type: 'llm/call', data: { task: 'race', ok: true } })
  console.log(ws)
} finally {
  store.close()
}
`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let stderr = ''
    child.stdout.on('data', (c) => (out += c.toString('utf8')))
    child.stderr.on('data', (c) => (stderr += c.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`worker 退出码 ${code}：${stderr.slice(0, 500)}`))
      else resolve(out.trim().split('\n').pop()!)
    })
  })
}

describe('N3 workspaceSession 并行首开', () => {
  it('三进程并发首开同书 → 同一 ws 会话、库里仅 1 条 ws 行、链路事件 3 条全在', async () => {
    const bookRoot = '/books/n3-race'
    const sids = await Promise.all([
      spawnWorker(dir, bookRoot),
      spawnWorker(dir, bookRoot),
      spawnWorker(dir, bookRoot),
    ])
    // 三方拿到同一 ws 会话（BEGIN IMMEDIATE 串行化：后到者拿锁后重查必见先到者已 INSERT 的行）
    expect(new Set(sids).size).toBe(1)
    const db = new DatabaseSync(join(dir, 'clwriting', 'session', bookHash(bookRoot) + '.db'))
    try {
      const wsRows = db
        .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE book = ? AND session_id LIKE 'ws-%'`)
        .get(bookHash(bookRoot)) as { n: number }
      expect(wsRows.n).toBe(1) // 不分裂
      const evs = db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'llm/call'`)
        .get() as { n: number }
      expect(evs.n).toBe(3) // 三方事件都挂在同一 ws 会话下
    } finally {
      db.close()
    }
  }, 60_000)
})
