/**
 * 改名后事件库迁移失败 → 启动自愈重试通路。
 *
 * 背景：改名先搬目录（不可回滚）再迁事件库；迁失败时旧库在旧 hash 下原地完整，但书
 * 已按新名注册，此后 openSessionStore(newRoot) 会在新 hash 下建空库——对话史/审计
 * 在 UI 上静默消失且无自动通路接回。修复：失败落待办档（会话库目录内，记四参事实），
 * 下次启动 registerBookLifecycleRoutes 的启动自愈按落档时序重试 migrateBookSession。
 *
 * 注入方式（自然故障，非 mock）：迁移目标位预置同名库文件 → migrateBookSession 的
 * 「目标已存在即放弃（防覆盖）」分支确定性返回 false；移除阻断后重启服务即走真实
 * 启动自愈路径。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServerSafe } from '../../helpers/safe-port.js'
import { waitForAsync } from '../../helpers/wait-for.js'
import { bookHash, openSessionStoreAsync, sessionDbPath } from '../../../src/events/store.js'
import { pendingEventMigrationPath } from '../../../src/studio/server/api/books-lifecycle.js'

const OLD = '迁移重试旧名'
const NEW = '迁移重试新名'
let workDir = ''
let userData = ''
let oldRoot = ''
let newRoot = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let sid = ''

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
  workDir = mkdtempSync(join(tmpdir(), 'clw-ev-mig-retry-'))
  userData = mkdtempSync(join(tmpdir(), 'clw-ev-mig-retry-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: OLD, path: `长篇/${OLD}`, kind: 'long' }) + '\n',
  )
  oldRoot = join(workDir, '长篇', OLD)
  newRoot = join(workDir, '长篇', NEW)
  mkdirSync(join(oldRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(oldRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${OLD}\nhost: cc\n`)
  writeFileSync(join(oldRoot, '写作', '正文', '0001-开篇.md'), '# 开篇\n\n正文。\n')

  // 旧名下已落一个会话（迁移要搬的就是它）——走生产开库口建库建表再真关库
  const store = await openSessionStoreAsync(userData, oldRoot)
  expect(store).not.toBeNull()
  sid = store!.createSession(OLD, { kind: 'chat' })
  store!.close()
  expect(existsSync(sessionDbPath(userData, oldRoot))).toBe(true)
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userData) rmSync(userData, { recursive: true, force: true })
})

describe('改名事件库迁移失败的启动自愈重试', () => {
  it('迁移失败 → 响应带 eventsMigrationFailed + 落待办档；重启后自动补齐并撤档', async () => {
    // 阻断迁移：目标位预置同名库文件 →「目标已存在即放弃（防覆盖）」确定性失败
    const newDb = sessionDbPath(userData, newRoot)
    mkdirSync(join(userData, 'clwriting', 'session'), { recursive: true })
    writeFileSync(newDb, 'blocker: 目标位占位，阻断迁移')

    server = await startServerSafe({ port: 0, workDir, userDataPath: userData })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const boot = await fetch(`${baseUrl}/api/boot`)
    token = ((await boot.json()) as { token: string }).token

    const r = await req('POST', `/api/books/${encodeURIComponent(OLD)}/rename`, { name: NEW })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, renamed: true, name: NEW })
    expect((r.json as { eventsMigrationFailed?: boolean }).eventsMigrationFailed).toBe(true)
    // 待办档已落（重试的事实来源：四参 + 落档时刻）
    const pendingFile = pendingEventMigrationPath(userData, newRoot)
    expect(existsSync(pendingFile)).toBe(true)
    const rec = JSON.parse(readFileSync(pendingFile, 'utf8')) as Record<string, unknown>
    expect(rec['oldRoot']).toBe(oldRoot)
    expect(rec['newRoot']).toBe(newRoot)
    expect(rec['oldName']).toBe(OLD)
    expect(rec['newName']).toBe(NEW)
    // 旧库原地完整（迁移零动作）
    expect(existsSync(sessionDbPath(userData, oldRoot))).toBe(true)

    // 移除阻断 + 关服 → 重启走启动自愈（真实生产路径：registerBookLifecycleRoutes 挂点）
    rmSync(newDb, { force: true })
    await new Promise<void>((res) => server!.close(() => res()))
    server = await startServerSafe({ port: 0, workDir, userDataPath: userData })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const boot2 = await fetch(`${baseUrl}/api/boot`)
    token = ((await boot2.json()) as { token: string }).token

    // 自愈收口（fire-and-forget，轮询到待办档撤除）
    await waitForAsync(async () => (existsSync(pendingFile) ? undefined : true), 8000, 50, '待办档撤除')

    // 旧库已搬走、新库在位且钥匙已改（生产读取口回读同一会话）
    expect(existsSync(sessionDbPath(userData, oldRoot))).toBe(false)
    const migrated = await openSessionStoreAsync(userData, newRoot)
    expect(migrated).not.toBeNull()
    try {
      const row = migrated!.latestSession(NEW)
      expect(row).not.toBeNull()
      expect(row!.session_id).toBe(sid)
      expect(migrated!.latestSession(OLD)).toBeNull() // 钥匙改写：旧名不再命中
    } finally {
      migrated!.close()
    }

    // 启动通告上报「已自动补齐」（作者可见面）
    const notices = (await (await fetch(`${baseUrl}/api/startup-notices`)).json()) as {
      notices: Array<{ kind: string; message: string }>
    }
    expect(notices.notices.some((n) => n.kind === 'events-migration' && n.message.includes(NEW))).toBe(true)
    // 待办档撤除幂等：新 hash 目录下不再留档
    expect(existsSync(join(userData, 'clwriting', 'session', bookHash(newRoot) + '.migrate-pending.json'))).toBe(false)
  })
})
