/**
 * R61-E-3 回归：rename 全量路径 clearChatHistory 裸 await 无防御。
 *
 * 原状：books.ts 改名 handler 在 renameWithRetry 成功（目录已搬家，不可回滚）之后
 * `await clearChatHistory(oldName)` 裸奔无 try/catch——清史一旦抛错，整次改名被打成
 * 500「服务器内部错误」，而磁盘目录/登记已是新名，客户端看到「失败」与实际状态分叉。
 * 对照组：删书路径同一调用已包 try/catch + log.warn 降级留痕（L-S4 防御性收编）。
 * 修法：对齐删书路径——try/catch 包裹，失败 log.warn 后继续（事件库迁移失败的
 * 独立回传通道 eventsMigrationFailed 不受本兜底影响）。
 * 注入手法：跟随 review-verdict-race.test.ts / r47-ttl-evict-on-expiry.test.ts 的
 * 透传式 vi.mock——仅把 clearChatHistory 换成恒抛桩，chat.js 其余导出原样透传。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { clearChatHistory } from '../../src/ai/orchestrate/chat.js'

vi.mock('../../src/ai/orchestrate/chat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/orchestrate/chat.js')>()
  return { ...actual, clearChatHistory: vi.fn(actual.clearChatHistory) }
})

const OLD = '旧名清史书'
const NEW = '新名清史书'
let workDir = ''
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

function bookYaml(title: string): string {
  return `spec_version: 1\nkind: long\nbook:\n  title: ${title}\n  genre: 玄幻\nhost: cc\n`
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r61e3-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: OLD, path: `长篇/${OLD}`, kind: 'long', created_at: '2026-01-01T00:00:00.000Z' }) + '\n',
  )
  writeFileSync(join(workDir, '.clwriting', 'active'), OLD + '\n')
  const oldRoot = join(workDir, '长篇', OLD)
  mkdirSync(join(oldRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(oldRoot, 'book.yaml'), bookYaml(OLD))
  writeFileSync(join(oldRoot, '写作', '正文', '0001-开篇.md'), '# 开篇\n\n正文。\n')

  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R61-E-3：rename 全量路径 clearChatHistory 抛错的防御性降级', () => {
  it('清史抛错 → 改名端点仍 200 成功信封 + warn 留痕（非 500）', async () => {
    vi.mocked(clearChatHistory).mockImplementation(async () => {
      throw new Error('R61-E-3 注入：清史故障')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = await req('POST', `/api/books/${encodeURIComponent(OLD)}/rename`, { name: NEW })
      // 修复前：裸 await 抛错 → dispatch catch → 500「服务器内部错误」（但磁盘已改名）
      expect(r.status).toBe(200)
      expect(r.json).toMatchObject({ ok: true, renamed: true, name: NEW, path: `长篇/${NEW}` })
      // 事件库迁移失败的独立回传通道不受清史兜底牵连（无 userDataPath 迁移直通 true）
      expect((r.json as { eventsMigrationFailed?: boolean }).eventsMigrationFailed).toBeUndefined()
      // 改名真实闭环：目录搬家 + 登记换名（证明确实不是靠「提前失败」绕过清史）
      expect(existsSync(join(workDir, '长篇', OLD))).toBe(false)
      expect(existsSync(join(workDir, '长篇', NEW, 'book.yaml'))).toBe(true)
      // warn 留痕（log.warn → console 镜像同步落点；对齐删书路径 log.warn 口径）
      const warned = warnSpy.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('[api]') && c[0].includes('清史失败'),
      )
      expect(warned).toBe(true)
      // 注入点命中：rename 全量路径确实调用过 clearChatHistory(oldName)
      expect(vi.mocked(clearChatHistory)).toHaveBeenCalledWith(OLD)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
