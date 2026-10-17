/**
 * C3（1.0 收口）：runSpec 可见注入登记 + CLW_VERIFY_VISIBLE 抽样面扩展。
 *
 * 铁律①「模型可见 ⟺ 已记录」的抽样此前只在 chat 轮循环（turns-visibility.ts）。
 * runSpec 侧新增 `visible` 入参后，self-heal / rewrite（端点与对话工具）各链的
 * 可见 prompt 指纹随 llm/call 同批落 workspace 会话事件库，抽样校验随调用返回前跑。
 *
 * 本档锚两件事：
 * - 登记面：传 visible → 事件库出现同 scope+digest 的 settings/snapshot；
 * - 抽样面：flag 开且登记齐备不 warn（登记缺失的 warn 路径由
 *   verify-visible-sampled.test.ts 的通道无关用例覆盖）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/ai/gen.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/gen.js')>()
  return {
    ...actual,
    generate: vi.fn(async () => ({
      text: 'ok',
      reasoning: '',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3 },
      stopReason: 'end_turn',
    })),
  }
})

import { runSpec, type TaskSpec } from '../../src/ai/tasks/spec.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { digest16 } from '../../src/events/lineage.js'

const SPEC: TaskSpec = {
  name: 'self-heal',
  tierKind: 'creative',
  genMode: 'text',
  systemPrompt: '你是网文写作引擎',
}

const dirs: string[] = []

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
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

interface SnapshotEvent {
  type: string
  data: { scope?: string; digest?: string }
}

function readSnapshots(ud: string, bookRoot: string): SnapshotEvent[] {
  const store = openSessionStore(ud, bookRoot)!
  try {
    return store.listEvents(bookHash(bookRoot)).filter((e) => e.type === 'settings/snapshot') as SnapshotEvent[]
  } finally {
    store.close()
  }
}

afterEach(() => {
  delete process.env['CLW_VERIFY_VISIBLE']
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('C3：runSpec 可见注入登记与抽样', () => {
  it('传 visible → settings/snapshot 以同 scope+digest 落 workspace 会话事件库', async () => {
    const ud = tempDir('clw-c3-ud-')
    writeProviders(ud)
    const bookRoot = tempDir('clw-c3-book-')
    const prompt = '写第 3 章正文'
    const out = await runSpec(SPEC, {
      userDataPath: ud,
      bookRoot,
      userPrompt: prompt,
      visible: [{ scope: 'prompt', digest: digest16(prompt) }],
    })
    expect(out.ok).toBe(true)

    const snaps = readSnapshots(ud, bookRoot)
    expect(snaps).toHaveLength(1)
    expect(snaps[0]!.data.scope).toBe('prompt')
    expect(snaps[0]!.data.digest).toBe(digest16(prompt))
  })

  it('不传 visible → 不落血缘快照（链路按需加入抽样面）', async () => {
    const ud = tempDir('clw-c3-ud2-')
    writeProviders(ud)
    const bookRoot = tempDir('clw-c3-book2-')
    const out = await runSpec(SPEC, { userDataPath: ud, bookRoot, userPrompt: '写第 4 章' })
    expect(out.ok).toBe(true)
    expect(readSnapshots(ud, bookRoot)).toHaveLength(0)
  })

  it('flag 开 + 登记齐备 → 抽样不 warn（登记与可见同源派生）', async () => {
    process.env['CLW_VERIFY_VISIBLE'] = '1'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ud = tempDir('clw-c3-ud3-')
    writeProviders(ud)
    const bookRoot = tempDir('clw-c3-book3-')
    const prompt = '重写第 5 章'
    const out = await runSpec(SPEC, {
      userDataPath: ud,
      bookRoot,
      userPrompt: prompt,
      visible: [{ scope: 'prompt', digest: digest16(prompt) }],
    })
    expect(out.ok).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })
})
