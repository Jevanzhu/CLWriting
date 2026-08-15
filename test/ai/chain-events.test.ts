/**
 * F1-P2 runner 链事件单测：runTask 走真实路径时写 llm/call + step/start + step/end{reason}，
 * 重试前写 llm/retry（先落库后等待）；无 bookRoot 降级不写。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runTask } from '../../src/ai/runner.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { GenError } from '../../src/ai/gen.js'

const dirs: string[] = []
function tempUserData(): string {
  const d = mkdtempSync(join(tmpdir(), 'clwriting-chain-ud-'))
  dirs.push(d)
  return d
}
function tempBookRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'clwriting-chain-book-'))
  dirs.push(d)
  return d
}

function writeProviders(userDataPath: string): void {
  writeFileSync(
    join(userDataPath, 'providers.json'),
    JSON.stringify({
      providers: [
        {
          id: 'prov-test',
          name: 'test',
          protocol: 'openai',
          auth: 'bearer',
          baseUrl: 'http://localhost:1',
          apiKey: 'sk-test',
          caps: { connected: true, streaming: true },
        },
      ],
      currentId: 'prov-test',
      currentModel: 'gpt-4o',
    }),
  )
}

function readChainEvents(userDataPath: string, bookRoot: string) {
  const store = openSessionStore(userDataPath, bookRoot)!
  try {
    return store.listEvents(bookHash(bookRoot))
  } finally {
    store.close()
  }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.CLWRITING_DRIVER
})

describe('F1-P2 runTask 链事件', () => {
  it('成功 → step/start + llm/call(ok) + step/end(completed)', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const root = tempBookRoot()
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'chat',
      run: () => Promise.resolve('ok'),
    })
    expect(out.ok).toBe(true)
    const evs = readChainEvents(ud, root)
    expect(evs.map((e) => e.type)).toEqual(['step/start', 'llm/call', 'step/end'])
    const [start, call, end] = evs.map((e) => e.data) as Record<string, unknown>[]
    expect(start).toMatchObject({ task: 'chat', layer: 'chat' })
    expect(call).toMatchObject({ task: 'chat', ok: true, model: 'gpt-4o', attempt: 0 })
    expect(end).toMatchObject({ task: 'chat', layer: 'chat', reason: 'completed' })
  })

  it('重试成功（429 → 退避 → 成功）→ llm/retry + 两条 llm/call + step/end(completed)', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const root = tempBookRoot()
    let calls = 0
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'self-heal',
      run: () => {
        calls++
        if (calls < 2) throw new GenError('429 limit', true)
        return Promise.resolve('ok');
      },
    })
    expect(out.ok).toBe(true)
    const evs = readChainEvents(ud, root)
    const types = evs.map((e) => e.type)
    expect(types).toEqual(['step/start', 'llm/call', 'llm/retry', 'llm/call', 'step/end'])
    const retry = evs[2]!.data as { attempt: number; delayMs: number }
    expect(retry.attempt).toBe(0)
    expect(retry.delayMs).toBeGreaterThanOrEqual(0)
    const end = evs[4]!.data as { reason: string }
    expect(end.reason).toBe('completed')
  })

  it('终态失败（不可重试）→ step/end(error) + llm/call(ok=false)', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const root = tempBookRoot()
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'review',
      run: () => Promise.reject(new GenError('boom', false, { code: 'BAD_REQUEST' })),
    })
    expect(out.ok).toBe(false)
    const evs = readChainEvents(ud, root)
    expect(evs.map((e) => e.type)).toEqual(['step/start', 'llm/call', 'step/end'])
    const call = evs[1]!.data as { ok: boolean; errCode?: string }
    expect(call.ok).toBe(false)
    expect(call.errCode).toBe('BAD_REQUEST')
    const end = evs[2]!.data as { reason: string }
    expect(end.reason).toBe('error')
  })

  it('无 bookRoot → 不写链事件（降级；bookRoot 缺失时观测层跳过）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const out = await runTask<string>({
      userDataPath: ud,
      task: 'chat',
      run: () => Promise.resolve('ok'),
    })
    expect(out.ok).toBe(true)
    // bookRoot 缺失 → 不写任何链路事件（观测层跳过）
    const store = openSessionStore(ud, '/nope')!
    try {
      expect(store.listEvents(bookHash('/nope'))).toHaveLength(0)
      expect(store.latestSession(bookHash('/nope'))).toBeNull()
    } finally {
      store.close()
    }
  })

  it('中断 → step/end(aborted)', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const root = tempBookRoot()
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'chat',
      ctrl,
      run: (_, signal) =>
        new Promise<string>((_resolve, reject) => {
          if (signal.aborted) { reject(new Error('aborted')); return }
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    expect(out.ok).toBe(false)
    const evs = readChainEvents(ud, root)
    const end = evs.at(-1)!.data as { reason: string }
    expect(end.reason).toBe('aborted')
  })
})

