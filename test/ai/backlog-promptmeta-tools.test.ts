/**
 * R59 清偿批（R55-C-6）回归：llm/call promptMeta 增 tools 摘要（铁律②「模型可见 ⟺
 * 已记录」工具面补全）。
 *
 * 原实现：promptMeta 只记 prompt 文本面（chars/hash/files），chat 每轮挂载的 15 个
 * 工具 schema 模型可见而事件无从回溯。修复后：turns/finish 挂 chatTools 的调用登记
 * promptTools → promptMeta.tools（去重排序、确定性可重放）；可选键，旧事件无此键仍
 * 可解析；hash/chars 语义不变（token-calibration 拟合与 hash 对比消费面不受扰动）。
 * 端到端 harness 与 chat-prompt-trace.test.ts 同款（fake provider + runChat 全链）。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat, clearChatHistory } from '../../src/ai/orchestrate/chat.js'
import { chatTools } from '../../src/ai/contract/chat.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/types.js'

let fake: FakeProvider
const dirs: string[] = []
let bookRoot: string

beforeAll(async () => {
  fake = await createFakeProvider()
})

afterAll(async () => {
  await fake.close()
})

beforeEach(() => {
  bookRoot = makeDualTrackWorkdir()
  dirs.push(bookRoot)
  delete process.env.CLWRITING_DRIVER
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeDriver(): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(): void {},
  }
}

function readWorkspaceChain(ud: string) {
  const store = openSessionStore(ud, bookRoot)!
  try {
    return store.listEvents(bookHash(bookRoot))
  } finally {
    store.close()
  }
}

async function runOneChat(ud: string, bookName: string, message: string): Promise<{ tools?: string[]; hash?: string }> {
  withFakeProvider(ud, fake.url)
  clearChatHistory(bookName)
  await runChat({
    driver: makeDriver(),
    mainSession: { id: 's1', cwd: bookRoot, closed: false },
    userDataPath: ud,
    bookRoot,
    bookName,
    message,
  })
  const call = readWorkspaceChain(ud).find((e) => e.type === 'llm/call')!
  expect(call).toBeDefined()
  const meta = (call.data as { promptMeta?: { tools?: string[]; hash?: string } }).promptMeta
  expect(meta).toBeDefined()
  return { tools: meta!.tools, hash: meta!.hash }
}

describe('R55-C-6: promptMeta.tools 工具面登记（端到端）', () => {
  it('chat 轮 llm/call promptMeta.tools = chatTools 名单（去重排序）', async () => {
    fake.setScript([{ type: 'text', content: '回复。' }])
    const ud = tempUserData()
    dirs.push(ud)
    // 修复前：promptMeta 无 tools 键（工具 schema 模型可见而事件不可回溯）——回归红
    const { tools } = await runOneChat(ud, 'r59-c6-a', '问个问题')
    expect(tools).toBeDefined()
    expect(tools).toEqual([...tools!].sort()) // 排序（确定性可重放）
    expect(tools).toHaveLength(chatTools.length) // 15 个工具 schema 全登记
    expect(tools).toEqual([...new Set(chatTools.map((t) => t.name))].sort())
  })

  it('同输入两次调用 tools 指纹一致（确定性可重放）', async () => {
    fake.setScript([{ type: 'text', content: '回复。' }])
    let first: string[] | undefined
    for (const name of ['r59-c6-b1', 'r59-c6-b2']) {
      const ud = tempUserData()
      dirs.push(ud)
      const { tools } = await runOneChat(ud, name, '同一样的问题')
      expect(tools).toBeDefined()
      if (first === undefined) first = tools
      else expect(tools).toEqual(first)
    }
  })
})
