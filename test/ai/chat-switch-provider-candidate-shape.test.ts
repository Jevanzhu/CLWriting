// 0918二轮修复批（A104）：换网候选过滤轻量形状校验回归。
// 文件头锚注：源码锚 src/ai/orchestrate/chat/turns.ts（switch-provider 消费者的候选
// 预检块——resolveAdapter 协议在册 + tierFromStore('chat') 模型可解析）。
//
// 修复前：失败路径候选过滤对每个候选 resolveProvider(...)——每候选 loadProviders 整
// store 克隆（含 vault 解密产物 structuredClone）+ createProvider 实例化入 LRU（容量 8）；
// 过滤探针的代价与实例驻留面不成比例。修复后：读一次 providers 配置做形状判定，不
// 实例化 provider、不进 LRU；真正实例化只发生在选定后的重发路径。
//
// 断言面（spy 记录 registry.createProvider 实参 conf.id，不改行为）：
// - 坏协议候选（fake-bad）不再被实例化探针触达（修复前 resolveProvider → createProvider
//   对其同步 throw——一次无效实例化尝试）；
// - 选定候选（fake-c）恰被实例化一次（重发路径；修复前过滤 + 重发两次）；
// - 换网重发成功路径行为不变（A004 预检文案语义保留：坏协议被跳过、选第一个可用者）。
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { tempUserData } from '../studio/fixtures.js'
import { runAgentTurns } from '../../src/ai/orchestrate/chat/turns.js'
import { saveProviders, type ProviderStore } from '../../src/ai/provider/store.js'
import { log } from '../../src/log/index.js'
import { SessionRecorder } from '../../src/events/chat-bridge.js'
import type { ChatMsg } from '../../src/ai/provider/types.js'
import type { DriverEvent, Session } from '../../src/driver/types.js'

let fake: FakeProvider
const dirs: string[] = []

beforeAll(async () => {
  fake = await createFakeProvider()
})

afterAll(async () => {
  await fake.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('A104: 换网候选过滤不实例化 provider / 不进 LRU', () => {
  it('401 → 形状校验跳过坏协议候选、选定者仅重发路径实例化一次，重发成功行为不变', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    // spy 记录 createProvider 实参 conf.id（不 mockImplementation——原行为照常执行）
    const cpSpy = vi.spyOn(await import('../../src/ai/provider/registry.js'), 'createProvider')
    fake.setScript([
      { type: 'error', status: 401, message: 'Invalid API key' }, // 首发（fake-a）：AUTH → 换网族
      { type: 'text', content: '备用供应商回答：玉佩来历已查清。', usage: { input: 100, output: 50 } }, // 换网重发（fake-c）：成功
    ])

    const ud = tempUserData()
    dirs.push(ud)
    // 三供应商：fake-a 现用 + fake-bad 坏协议（形状校验应跳过）+ fake-c 可用（应被选定）
    const providers: ProviderStore['providers'] = [
      {
        id: 'fake-a',
        name: 'fake-a',
        protocol: 'openai',
        auth: 'bearer',
        baseUrl: fake.url,
        model: 'fake-model',
        apiKey: 'sk-fake-a',
        caps: { connected: true, streaming: true },
        capsProbedAt: Date.now(),
      },
      {
        id: 'fake-bad',
        name: 'fake-bad',
        protocol: 'bogus-protocol' as unknown as ProviderStore['providers'][number]['protocol'],
        auth: 'bearer',
        baseUrl: fake.url,
        model: 'fake-model',
        apiKey: 'sk-fake-bad',
        caps: { connected: true, streaming: true },
        capsProbedAt: Date.now(),
      },
      {
        id: 'fake-c',
        name: 'fake-c',
        protocol: 'openai',
        auth: 'bearer',
        baseUrl: fake.url,
        model: 'fake-model',
        apiKey: 'sk-fake-c',
        caps: { connected: true, streaming: true },
        capsProbedAt: Date.now(),
      },
    ]
    saveProviders(ud, {
      providers,
      currentId: 'fake-a',
      currentModel: 'fake-model',
      modelCaps: {},
      ragProviders: [],
      tiers: { creative: { model: 'fake-model', effort: 'medium' }, assistant: null, chat: null },
      revision: 0,
      vault: null,
      dek: null,
    })

    const bookRoot = mkdtempTracked(join(tmpdir(), 'a104-shape-book-'))
    dirs.push(bookRoot)
    const emitted: DriverEvent[] = []
    const history: ChatMsg[] = [{ role: 'user', content: '查玉佩' }]
    const deps = {
      opts: {
        driver: makeFakeDriver({ emitted }),
        mainSession: { id: 's1', cwd: bookRoot, closed: false } as Session,
        userDataPath: ud,
        bookRoot,
        bookName: 'a104-shape',
      },
      state: { ctrl: new AbortController(), deadline: Date.now() + 60_000, pending: new Map() },
      confirmTimeout: 1_000,
      history,
      baseLen: history.length,
      recorder: new SessionRecorder(null, 'a104-shape-session'),
      sys: 'SYS',
      turnBranch: undefined,
      digests: { settings: 'a104-shape-digest' },
      promptFiles: [],
      revisionPath: undefined,
      seqs: {
        msgSeqs: [] as number[][],
        pendingMsgSeqs: [] as Array<number | number[]>,
        commitPendingMsgSeqs: () => {},
      },
      markCompleted: () => {},
    }

    const ok = await runAgentTurns(deps as unknown as Parameters<typeof runAgentTurns>[0])
    expect(ok).toBe(true)

    // ── 行为面（A004 预检语义不变）：恰 2 次请求、跳过坏协议选 fake-c、成功收尾 ──
    expect(fake.requestCount()).toBe(2)
    expect(emitted.some((e) => e.type === 'chat_done')).toBe(true)
    expect(emitted.some((e) => e.type === 'chat_error')).toBe(false)
    expect(
      emitted.some(
        (e) => e.type === 'warning' && String((e as { message?: string }).message ?? '').includes('已切换备用供应商'),
      ),
    ).toBe(true)
    expect(warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('切换备用 fake-c'))).toBe(true)

    // ── 实例化面（A104 核心）──
    const createdIds = cpSpy.mock.calls.map((c) => (c[0] as { id: string }).id)
    // 坏协议候选不再被实例化探针触达（修复前：过滤段 createProvider(fake-bad) 同步 throw）
    expect(createdIds).not.toContain('fake-bad')
    // 选定候选恰实例化一次（重发路径；修复前：过滤段 + 重发段两次——重发段命中过滤段
    // 恰好入缓存的实例，createProvider 调用本身仍发生）
    expect(createdIds.filter((id) => id === 'fake-c')).toHaveLength(1)
    // 现用供应商（fake-a）实例化来自预算 resolve + 首发发送，与候选过滤无关（≥1 即可）
    expect(createdIds.filter((id) => id === 'fake-a').length).toBeGreaterThanOrEqual(1)

    cpSpy.mockRestore()
    warnSpy.mockRestore()
  })
})
