/**
 * R54-C-1（五十四轮）回归：chat promptMeta 指纹与实发同源（消毒后历史）。
 *
 * 修复前：runTask 的 promptText 取未消毒 history、generate 用 sanitizeHistory 副本
 * ——消毒实际生效（中断残留空壳等非法序列被修）时 llm/call 审计指纹与真实输入脱钩，
 * 违「模型可见 ⟺ 已记录」。修复后：消毒上提至任务前单源化，指纹与 messages 同源。
 *
 * 差分设计：消毒对非法历史（尾部空 content assistant，#3a 剔除形态）非 no-op——
 * 剔除后末条回落 user 文本。同一 user 文本的干净历史为对照组：两组 llm/call
 * promptMeta.hash 必须相等（修复前指纹取到空串，hash 必不相等）；再以不同文本对照
 * 证明 hash 对实际输入敏感（防恒等假绿）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { tempUserData, withFakeProvider } from '../studio/fixtures.js'
import { runAgentTurns, lastMessageFingerprint } from '../../src/ai/orchestrate/chat/turns.js'
import { sanitizeHistory } from '../../src/ai/prompts/chat.js'
import { SessionRecorder } from '../../src/events/chat-bridge.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import type { ChatMsg } from '../../src/ai/provider/types.js'
import { mkdtempSync } from 'node:fs'

let fake: FakeProvider
const dirs: string[] = []

beforeAll(async () => {
  // 文本脚本（重复末条）——runAgentTurns 单轮无工具即完成
  fake = await createFakeProvider([{ type: 'text', content: '收到，这是回复。', usage: { input: 3, output: 4 } }])
})

afterAll(async () => {
  await fake.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeDeps(ud: string, bookRoot: string, history: ChatMsg[]) {
  return {
    opts: {
      driver: makeFakeDriver(),
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'r54-c1',
    },
    state: { ctrl: new AbortController(), deadline: Date.now() + 60_000, pending: new Map() },
    confirmTimeout: 1_000,
    history,
    baseLen: history.length,
    recorder: new SessionRecorder(null, 'r54-c1-session'),
    sys: '你是测试系统提示（R54-C-1 差分锚）',
    turnBranch: undefined,
    digests: { settings: 'r54-c1-digest' },
    promptFiles: [],
    revisionPath: undefined,
    seqs: { msgSeqs: [] as number[][], pendingMsgSeqs: [] as Array<number | number[]>, commitPendingMsgSeqs: () => {} },
    markCompleted: () => {},
  }
}

function makeBookRoot(): string {
  // bookRoot 仅作 trace/记账定位（不读写书籍数据），空目录即可
  const d = mkdtempSync(join(tmpdir(), 'r54-c1-book-'))
  dirs.push(d)
  return d
}

function readLlmCallHashes(ud: string, bookRoot: string): string[] {
  const store = openSessionStore(ud, bookRoot)!
  try {
    return store
      .listEvents(bookHash(bookRoot))
      .filter((e) => e.type === 'llm/call')
      .map((e) => ((e.data as { promptMeta?: { hash?: string } }).promptMeta?.hash ?? ''))
  } finally {
    store.close()
  }
}

describe('R54-C-1: promptMeta 指纹取消毒后历史（与 generate 实发同源）', () => {
  it('消毒生效历史与等价干净历史的 llm/call 指纹一致（修复前不一致）', async () => {
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProvider(ud, fake.url)
    const bookRoot = makeBookRoot()

    // 前提钉：消毒对空壳 assistant 非 no-op——末条从空串回落 user 文本
    const illegal: ChatMsg[] = [
      { role: 'user', content: '问题一号' },
      { role: 'assistant', content: '' },
    ]
    const clean: ChatMsg[] = [{ role: 'user', content: '问题一号' }]
    expect(lastMessageFingerprint(illegal)).toBe('')
    expect(lastMessageFingerprint(sanitizeHistory(illegal))).toBe('问题一号')

    const ok1 = await runAgentTurns(makeDeps(ud, bookRoot, illegal))
    expect(ok1).toBe(true)
    const ok2 = await runAgentTurns(makeDeps(ud, bookRoot, clean))
    expect(ok2).toBe(true)

    const hashes = readLlmCallHashes(ud, bookRoot)
    expect(hashes.length).toBe(2)
    // 修复点：指纹取消毒后末条（问题一号），与干净历史同 hash（修复前取到空串必不等）
    expect(hashes[0]).toBe(hashes[1])
    expect(hashes[0]).not.toBe('')
  })

  it('对照：不同实际输入 hash 不同（hash 对消毒后指纹敏感，防恒等假绿）', async () => {
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProvider(ud, fake.url)
    const bookRoot = makeBookRoot()

    await runAgentTurns(makeDeps(ud, bookRoot, [{ role: 'user', content: '问题一号' }]))
    await runAgentTurns(makeDeps(ud, bookRoot, [{ role: 'user', content: '问题二号' }]))

    const hashes = readLlmCallHashes(ud, bookRoot)
    expect(hashes.length).toBe(2)
    expect(hashes[0]).not.toBe(hashes[1])
  })
})
