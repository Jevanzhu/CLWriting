/**
 * 0918独立重评修复批（E002）回归：SSE sync 快照 running 收窄为写手腿。
 *
 * 现状：stream.ts:360 快照 `running=driver.isRunning()` 遍历全部 owner 槽位——chat 腿
 * ctrl 以 `chat:<book>` owner 全程在册至 finish 注销，对话期间 workbench.running 被置
 * 真且永不复位（chat_done/chat_error 走 chat 族不达 workbench）。修法：快照改用
 * `driver.isWriterRunning?.(session) ?? false`；对话态由 chatRunning 单独承载。
 * 本测经真实 server 锚定：仅 chat 腿 ctrl 在册时接入 SSE → 首帧
 * `{type:'sync', running:false, chatRunning:true}`；换写手腿 ctrl 在册 → running:true。
 * isChatRunning 经 vi.mock 置真（chat 运行登记正本无测试钩子；mock 面只覆盖本文件的
 * server 模块图——六个消费导出逐名提供，其余路由行为无害）。
 */
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

// chat 运行态 mock：isChatRunning(BOOK)=true（对话在途），其余导出逐名无害提供
// （server 侧消费面：stream/audit/task-gate/books-lifecycle/books-rename/chat 路由）
vi.mock('../../src/ai/orchestrate/chat.js', () => ({
  isChatRunning: (name: string) => name === '同步快照书',
  abortChat: () => false,
  clearChatHistory: () => null,
  waitChatSettled: async () => undefined,
  resolveChatConfirm: () => false,
  sendChatMessage: () => 'rejected',
}))

const BOOK = '同步快照书'
let studio: StudioHarness

interface SyncFrame {
  type: string
  running?: boolean
  chatRunning?: boolean
}

/** 接入 SSE 读首帧 sync 快照（返回解析结果与断开句柄） */
async function readSyncFrame(): Promise<{ frame: SyncFrame; abort: () => void }> {
  const ac = new AbortController()
  // R0916-7-P3-19：SSE `?token=` 通道已删——凭据走 x-studio-token 头
  const r = await fetch(`${studio.baseUrl}/api/books/${encodeURIComponent(BOOK)}/stream`, {
    signal: ac.signal,
    headers: { 'x-studio-token': studio.token },
  })
  expect(r.status).toBe(200)
  const reader = r.body!.getReader()
  const { value } = await reader.read()
  const text = new TextDecoder().decode(value!)
  const line = text.split('\n').find((l) => l.startsWith('data: '))
  expect(line).toBeDefined()
  const frame = JSON.parse(line!.slice('data: '.length)) as SyncFrame
  return { frame, abort: () => ac.abort() }
}

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-sync-writer-',
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 同步快照书\n  genre: 玄幻\nhost: cc\n',
  })
})

afterAll(async () => {
  const { ensureSession, getSession } = await import('../../src/driver/index.js')
  const s = getSession(BOOK) ?? (await ensureSession(BOOK, studio.workDir).catch(() => null))
  if (s) {
    const { getDriver } = await import('../../src/driver/index.js')
    getDriver().dispose(s)
  }
  await studio.close()
})

describe('E002: sync 快照 running 收窄为写手腿', () => {
  it('仅 chat 腿 ctrl 在册 → running=false 且 chatRunning=true（修复前 running 被置真且永不复位）', async () => {
    const { ensureSession, getDriver } = await import('../../src/driver/index.js')
    const session = await ensureSession(BOOK, studio.workDir)
    const ctrl = new AbortController()
    getDriver().registerCtrl?.(session, ctrl, `chat:${BOOK}`)
    try {
      const { frame, abort } = await readSyncFrame()
      expect(frame.type).toBe('sync')
      expect(frame.running).toBe(false)
      expect(frame.chatRunning).toBe(true)
      abort()
    } finally {
      getDriver().unregisterCtrl?.(session, ctrl)
    }
  })

  it('写手腿 ctrl 在册 → running=true（快照确已换用 isWriterRunning，非恒 false）', async () => {
    const { ensureSession, getDriver } = await import('../../src/driver/index.js')
    const session = await ensureSession(BOOK, studio.workDir)
    const ctrl = new AbortController()
    getDriver().registerCtrl?.(session, ctrl, 'spawn')
    try {
      const { frame, abort } = await readSyncFrame()
      expect(frame.type).toBe('sync')
      expect(frame.running).toBe(true)
      abort()
    } finally {
      getDriver().unregisterCtrl?.(session, ctrl)
    }
  })
})
