/**
 * M-2（第六轮）回归：POST /api/books/:name/chat/clear 补齐 audit DELETE 同款闸。
 *
 * 修复背景：clearChatHistory 是双键清理（bookName + bookHash 工作流会话），audit DELETE
 * 已配五闸（isChatRunning / heldTaskGatesFor / isSelfHealRunning / hasBackgroundTasks /
 * isSpawnRunning），chat/clear 此前只有两道（isChatRunning + hasBackgroundTasks）——
 * task-gate 任务 / self-heal 批量写稿在途时清空清不彻底，收尾事件追加到已删 session
 * 的行上成孤儿。
 * 本测试锁三件事：
 * 1. task-gate 在途（真实占位）→ 409 拒清，事件库两侧原样；
 * 2. self-heal 运行中 → 409 拒清；
 * 3. 全空闲 → 200 且两侧清空（闸不误伤）。
 *
 * 重评二轮-P3-2（2026-09-13 全库源码重评二轮 GLM-5.3）：两端六闸收编 audit.ts
 * chatClearGateReason 单源 + await 后清库前复查（chat.clear 经 clearChatHistory 的
 * gate 回调 / audit DELETE 在 openSessionStoreAsync 之后）。本文件经真服务锁入口
 * 收编后口径不变（chat/clear 与 audit DELETE 两端各验一闸），复查闸的机制面见
 * test/ai/chat-clear-gate-recheck.test.ts。
 */
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { stepStartEvent } from '../../src/events/chain-bridge.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'
import { isSelfHealRunning } from '../../src/ai/orchestrate/self-heal.js'

vi.mock('../../src/ai/orchestrate/self-heal.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/orchestrate/self-heal.js')>()
  return { ...orig, isSelfHealRunning: vi.fn(() => false) }
})

const BOOK = '清对话闸书'
let studio: StudioHarness
let userDataPath = ''

beforeAll(async () => {
  // userData（事件库）由调用方创建/清理，bootStudio 只透传
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-chat-clear-gates-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-chat-clear-gates-',
    userDataPath,
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 清对话闸书\n  genre: 玄幻\nhost: cc\n',
  })
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

/** 真服务请求骨架（chat/clear POST 与 audit DELETE 两用——复审-0914-修复批 nano-1
 *  收敛参数化，原 del/post 除 method 一字外逐行相同约 28 行）。 */
function req(method: 'POST' | 'DELETE', path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(studio.baseUrl)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: { origin: studio.baseUrl, 'x-studio-token': studio.token },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
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
    r.on('error', reject)
    r.end()
  })
}

/** 工作流侧事件计数（bookHash 键——闸要保护的另一侧）。 */
function workflowEvents(): number {
  const bookRoot = studio.bookRoot
  const store = openSessionStore(userDataPath, bookRoot)!
  try {
    return store.listEvents(bookHash(bookRoot)).length
  } finally {
    store.close()
  }
}

function seedWorkflowEvent(): void {
  const bookRoot = studio.bookRoot
  const store = openSessionStore(userDataPath, bookRoot)!
  try {
    const wsSid = store.workspaceSession(bookHash(bookRoot))
    store.appendEvents(wsSid, [stepStartEvent('chat', 'chat')])
  } finally {
    store.close()
  }
}

describe('M-2 + 重评二轮-P3-2: chat/clear 与 audit DELETE 六闸同口径', () => {
  it('task-gate 在途（真实占位）→ 409 拒清，工作流侧事件原样', async () => {
    seedWorkflowEvent()
    const release = acquireTaskGate(BOOK, 'analyze')!
    try {
      const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/chat/clear`)
      expect(r.status).toBe(409)
      expect((r.json as { error: string }).error).toContain('任务在跑')
      expect(workflowEvents()).toBe(1) // 未被清掉
    } finally {
      release()
    }
  })

  it('self-heal 运行中 → 409 拒清', async () => {
    vi.mocked(isSelfHealRunning).mockReturnValue(true)
    try {
      const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/chat/clear`)
      expect(r.status).toBe(409)
      // R0916-7-P3-12：忙闸文案单源化——原「本书正在自动写稿……」→ 矩阵 self-heal 信号句
      expect((r.json as { error: string }).error).toContain('全自动写章')
      expect(workflowEvents()).toBe(1)
    } finally {
      vi.mocked(isSelfHealRunning).mockReturnValue(false)
    }
  })

  it('全空闲 → 200 且工作流侧清空（闸不误伤）', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/chat/clear`)
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean }).ok).toBe(true)
    expect(workflowEvents()).toBe(0)
  })

  // 重评二轮-P3-2：audit DELETE 入口收编 chatClearGateReason 后同口径（此前只经
  // 内联块覆盖）——真占 task-gate 验 409 拒清 + 工作流侧原样
  it('audit DELETE：task-gate 在途 → 409 拒清，工作流侧事件原样（六闸收编后口径不变）', async () => {
    seedWorkflowEvent()
    const release = acquireTaskGate(BOOK, 'analyze')!
    try {
      const r = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/audit`)
      expect(r.status).toBe(409)
      expect((r.json as { error: string }).error).toContain('任务在跑')
      expect(workflowEvents()).toBe(1) // 未被清掉
    } finally {
      release()
    }
  })

  it('audit DELETE：全空闲 → 200 且工作流侧清空（闸不误伤）', async () => {
    seedWorkflowEvent()
    const r = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/audit`)
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean }).ok).toBe(true)
    expect(workflowEvents()).toBe(0)
  })
})
