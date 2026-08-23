/**
 * T2-1 回归：chat 链路 prompt 溯源（文件级「模型可见 ⟺ 已记录」）。
 *
 * 修复前：chat 的 llm/call 只记 lastMessageFingerprint 哈希、promptFiles 恒缺，
 * revision/ref 的 path 恒空串——章正文（含 spill 外置全文）注入 system prompt 后
 * 无法回溯到文件。修复后：buildChatContext 产出 files/chapterFile → restore 透传 →
 * llm/call promptMeta.files 与 revision/ref.path 闭环（与写稿链同口径：记 hash+chars+files，
 * 不落全文）。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat, clearChatHistory } from '../../src/ai/orchestrate/chat.js'
import { buildChatContext } from '../../src/ai/prompts/chat.js'
import { resolveDraftPath } from '../../src/format/draft.js'
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

/** 写一章草稿（frontmatter + 正文 code points 数） */
function writeDraft(chapter: number, body: string): string {
  const rel = resolveDraftPath(bookRoot, chapter).relPath
  mkdirSync(dirname(join(bookRoot, rel)), { recursive: true })
  writeFileSync(join(bookRoot, rel), `---\n标题: 第${chapter}章\n---\n\n${body}`, 'utf8')
  return rel
}

function readWorkspaceChain(ud: string) {
  const store = openSessionStore(ud, bookRoot)!
  try {
    return store.listEvents(bookHash(bookRoot))
  } finally {
    store.close()
  }
}

function readChatEvents(ud: string, bookName: string) {
  const store = openSessionStore(ud, bookRoot)!
  try {
    return store.listEvents(bookName)
  } finally {
    store.close()
  }
}

describe('T2-1 buildChatContext 文件级溯源', () => {
  it('未选章 → files 空、chapterFile undefined', () => {
    const c = buildChatContext(bookRoot, undefined)
    expect(c.files).toEqual([])
    expect(c.chapterFile).toBeUndefined()
  })

  it('章正文未超阈值 → files/chapterFile 记草稿相对路径', () => {
    const rel = writeDraft(3, '短正文')
    const c = buildChatContext(bookRoot, 3)
    expect(c.files).toEqual([rel])
    expect(c.chapterFile).toBe(rel)
  })

  it('章正文超阈值外置 spill → files/chapterFile 记 spill locator', () => {
    writeDraft(3, '很长的正文。'.repeat(400)) // > 2000 code points → 外置
    const c = buildChatContext(bookRoot, 3)
    expect(c.chapterFile).toMatch(/^工作区\/spills\/[0-9a-f]{16}\.md$/)
    expect(c.files).toEqual([c.chapterFile])
  })
})

describe('T2-1 chat 链路事件登记（端到端）', () => {
  it('章正文 spill 外置 → llm/call promptMeta.files 含 locator、revision/ref.path 非空', async () => {
    fake.setScript([{ type: 'text', content: '回复。' }])
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProvider(ud, fake.url)
    writeDraft(3, '很长的正文。'.repeat(400))
    clearChatHistory('trace-a')

    await runChat({
      driver: makeDriver(),
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'trace-a',
      message: '问个问题',
      chapter: 3,
    })

    // llm/call（workspace 链）：promptMeta.files 含 spill locator
    const call = readWorkspaceChain(ud).find((e) => e.type === 'llm/call')!
    const meta = (call.data as { promptMeta?: { chars: number; files: string[]; hash: string } }).promptMeta
    expect(meta).toBeDefined()
    expect(meta!.chars).toBeGreaterThan(0)
    expect(meta!.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(meta!.files.join('\n')).toMatch(/工作区\/spills\/[0-9a-f]{16}\.md/)

    // revision/ref（chat 会话）：path = 同一 locator（修复前恒空串）
    const rev = readChatEvents(ud, 'trace-a').find((e) => e.type === 'revision/ref')!
    const path = (rev.data as { path: string }).path
    expect(path).toMatch(/工作区\/spills\/[0-9a-f]{16}\.md/)
    expect(meta!.files).toContain(path)
  })

  it('章正文未外置 → promptMeta.files 含草稿路径、revision/ref.path 同路径', async () => {
    fake.setScript([{ type: 'text', content: '回复。' }])
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProvider(ud, fake.url)
    const rel = writeDraft(2, '短正文')
    clearChatHistory('trace-b')

    await runChat({
      driver: makeDriver(),
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'trace-b',
      message: '问个问题',
      chapter: 2,
    })

    const call = readWorkspaceChain(ud).find((e) => e.type === 'llm/call')!
    const meta = (call.data as { promptMeta?: { files: string[] } }).promptMeta
    expect(meta!.files).toContain(rel)
    const rev = readChatEvents(ud, 'trace-b').find((e) => e.type === 'revision/ref')!
    expect((rev.data as { path: string }).path).toBe(rel)
  })

  it('未选章 → promptMeta.files 为空数组（有登记、无文件）', async () => {
    fake.setScript([{ type: 'text', content: '回复。' }])
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProvider(ud, fake.url)
    clearChatHistory('trace-c')

    await runChat({
      driver: makeDriver(),
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'trace-c',
      message: '问个问题',
    })

    const call = readWorkspaceChain(ud).find((e) => e.type === 'llm/call')!
    const meta = (call.data as { promptMeta?: { files: string[] } }).promptMeta
    expect(meta).toBeDefined()
    expect(meta!.files).toEqual([])
  })
})
