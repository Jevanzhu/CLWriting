/**
 * 换网重试域单测（0917清库修复批，2026-09-17）。
 *
 * 台账挂账「switch-provider 无消费者」转实施：provider/failure.ts 决策表
 * （AUTH/NOT_FOUND/UNSUPPORTED → 'switch-provider'）此前终态等同 author、
 * R66-11 自认无消费者；现于 chat 编排层主发送处接线（turns.ts sendTurn 失败后
 * 读决策表，A7 shrink 同款一次性重发范型：不级联、仍失败落回现行终态路径）。
 * 本件锁定三面：
 * 1. 首发供应商回 401（AUTH）→ 自动切换备用供应商重发一次 → 对话成功收尾；
 * 2. 双留痕：用户面 warning + 会话库 llm/retry（errCode=AUTH，delayMs=0 无退避）；
 * 3. 单供应商配置（无备用可切）→ 不重发，按现行终态路径收口（错误面零变更）。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat } from '../../src/ai/orchestrate/chat.js'
import { openSessionStore } from '../../src/events/store.js'
import { saveProviders, type ProviderStore } from '../../src/ai/provider/store.js'
import { log } from '../../src/log/index.js'
import type { DriverEvent } from '../../src/driver/types.js'
import { chatTexts, hasChatDone, chatError } from './chat-fixtures.js'

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
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 供应商条目（同指 fake stub，id/apiKey 各异——换网语义只看 id 不同） */
function prov(id: string): ProviderStore['providers'][number] {
  return {
    id,
    name: id,
    protocol: 'openai',
    auth: 'bearer',
    baseUrl: fake.url,
    model: 'fake-model',
    apiKey: `sk-${id}`,
    caps: { connected: true, streaming: true },
    capsProbedAt: Date.now(),
  }
}

/** 写 providers.json（双供应商传两 id，单供应商传一个；首个为 currentId） */
function setup(...ids: string[]): string {
  return setupConfs(ids.map(prov))
}

/** 供应商条目（坏协议变体——A004：resolveProvider 解析失败 = 无可用 chat 档的备用） */
function badProv(id: string): ProviderStore['providers'][number] {
  return { ...prov(id), protocol: 'bogus-protocol' as unknown as ProviderStore['providers'][number]['protocol'] }
}

/** 写 providers.json（条目显式传入——A004 混合可用性场景；首个为 currentId） */
function setupConfs(entries: ProviderStore['providers']): string {
  const ud = tempUserData()
  dirs.push(ud)
  delete process.env.CLWRITING_DRIVER
  const store: ProviderStore = {
    providers: entries,
    currentId: entries[0]!.id,
    currentModel: 'fake-model',
    modelCaps: {},
    ragProviders: [],
    tiers: { creative: { model: 'fake-model', effort: 'medium' }, assistant: null, chat: null },
    revision: 0,
    vault: null,
    dek: null,
  }
  saveProviders(ud, store)
  return ud
}

const RUN = () => ({ cwd: bookRoot, closed: false })

describe('换网重试（switch-provider 消费者）', () => {
  it('首发回 401 → 切备用供应商重发一次，对话成功收尾', async () => {
    fake.setScript([
      { type: 'error', status: 401, message: 'Invalid API key' },
      { type: 'text', content: '备用供应商回答：玉佩来历已查清。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup('fake-a', 'fake-b')

    await runChat({
      driver,
      mainSession: { id: 's1', ...RUN() },
      userDataPath: ud,
      bookRoot,
      bookName: 'test-switch',
      message: '查玉佩',
    })

    // 换网成功：备用回答进正文 + 正常收尾
    expect(chatTexts(events).join('')).toContain('备用供应商回答')
    expect(hasChatDone(events)).toBe(true)
    // 用户面 warning 留痕
    expect(
      events.some(
        (e) => e.type === 'warning' && String((e as { message?: string }).message ?? '').includes('已切换备用供应商'),
      ),
    ).toBe(true)
    // 会话库 llm/retry 留痕（恰一次；errCode=首发失败码 AUTH）
    const store = openSessionStore(ud, bookRoot)!
    const evs = store.listEvents('test-switch')
    store.close()
    const retries = evs.filter((e) => e.type === 'llm/retry')
    expect(retries).toHaveLength(1)
    expect((retries[0]!.data as { errCode?: string }).errCode).toBe('AUTH')
  })

  it('单供应商回 401 → 无备用可切，不重发，按现行终态路径收口', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    fake.setScript([{ type: 'error', status: 401, message: 'Invalid API key' }])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup('fake-a')

    await runChat({
      driver,
      mainSession: { id: 's1', ...RUN() },
      userDataPath: ud,
      bookRoot,
      bookName: 'test-switch-single',
      message: '查玉佩',
    })

    // 不重发（恰一次请求）、无换网 warning、错误面照旧透出
    expect(fake.requestCount()).toBe(1)
    expect(
      events.some(
        (e) => e.type === 'warning' && String((e as { message?: string }).message ?? '').includes('已切换备用供应商'),
      ),
    ).toBe(false)
    expect(chatError(events)).not.toBeNull()
    expect(hasChatDone(events)).toBe(false)
    // 0918独立重评修复批（A004）：「无备用供应商」分支现行文案不变（与「备用均无
    // chat 档」分支如实区分）
    expect(
      warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('无备用供应商可切换')),
    ).toBe(true)
    warnSpy.mockRestore()
  })

  // 0918独立重评修复批（A004）：备用供应商须过 chat 档可用性预检（resolveProvider
  // 同款解析路径）——坏协议备用被跳过、选第一个可解析者。
  it('备用首个无 chat 档（坏协议）→ 跳过选下一个可解析者换网（A004）', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    fake.setScript([
      { type: 'error', status: 401, message: 'Invalid API key' },
      { type: 'text', content: '第二备用回答：玉佩来历已查清。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setupConfs([prov('fake-a'), badProv('fake-bad'), prov('fake-c')])

    await runChat({
      driver,
      mainSession: { id: 's1', ...RUN() },
      userDataPath: ud,
      bookRoot,
      bookName: 'test-switch-skip',
      message: '查玉佩',
    })

    // 恰 2 次请求：首发 401 + 换网重发成功（坏协议备用未白烧一次必败发送）
    expect(fake.requestCount()).toBe(2)
    expect(chatTexts(events).join('')).toContain('第二备用回答')
    expect(hasChatDone(events)).toBe(true)
    // 选中的是 fake-c（fake-bad 被预检跳过）——换网留痕 log 带 fallback id
    expect(
      warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('切换备用 fake-c')),
    ).toBe(true)
    expect(
      warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('fake-bad')),
    ).toBe(false)
    warnSpy.mockRestore()
  })

  it('备用均无 chat 档 → 不重发走终态，warn 如实区分「备用均无可用 chat 档」（A004）', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    fake.setScript([{ type: 'error', status: 401, message: 'Invalid API key' }])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setupConfs([prov('fake-a'), badProv('fake-bad')])

    await runChat({
      driver,
      mainSession: { id: 's1', ...RUN() },
      userDataPath: ud,
      bookRoot,
      bookName: 'test-switch-none-resolvable',
      message: '查玉佩',
    })

    // 有备用条目但均解析失败：不白烧重发（恰一次请求）、错误面照旧、无换网 warning
    expect(fake.requestCount()).toBe(1)
    expect(
      events.some(
        (e) => e.type === 'warning' && String((e as { message?: string }).message ?? '').includes('已切换备用供应商'),
      ),
    ).toBe(false)
    expect(chatError(events)).not.toBeNull()
    expect(hasChatDone(events)).toBe(false)
    // 如实文案：与「无备用供应商」区分
    expect(
      warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('备用供应商均无可用 chat 档')),
    ).toBe(true)
    expect(
      warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('无备用供应商可切换')),
    ).toBe(false)
    // 不重发 → 无 llm/retry 留痕
    const store = openSessionStore(ud, bookRoot)!
    const evs = store.listEvents('test-switch-none-resolvable')
    store.close()
    expect(evs.some((e) => e.type === 'llm/retry')).toBe(false)
    warnSpy.mockRestore()
  })
})
