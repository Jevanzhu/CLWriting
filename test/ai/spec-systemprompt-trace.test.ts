/**
 * N-10（第十二轮）回归：runSpec 的动态 system 终值进 trace promptMeta 哈希。
 *
 * 铁律②「默认值显式 resolve」的重放口径：resolveBuiltinSystemPrompt + rulesToPrompt
 * 拼出的最终 system 不进 llm/call 的 promptMeta 哈希 = 无法证明重放时用了同一指令
 * （同 userPrompt 不同 system 的两次调用哈希相同）。chat 轮（turns.ts）与 checkpoint
 * （finish.ts）已传 systemPrompt，此处收口 spec 路径（修复前 runSpec 漏传，哈希只
 * 覆盖 userPrompt）。
 *
 * 手法：mock gen 层捕获进请求的 systemPrompt 终值 → runSpec → 重开事件库读回
 * workspace 链的 llm/call 事件，断言 promptMeta.hash === promptMeta(system, user)。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../src/ai/gen.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/gen.js')>()
  return {
    ...actual,
    generate: vi.fn(async () => ({ text: 'ok', reasoning: '', toolCalls: [], usage: { inputTokens: 5, outputTokens: 3 }, stopReason: 'end_turn' })),
  }
})

import { generate } from '../../src/ai/gen.js'
import { runSpec, type TaskSpec } from '../../src/ai/tasks/spec.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'

const generateMock = generate as ReturnType<typeof vi.fn>

const workDirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(d)
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

const TEXT_SPEC: TaskSpec = {
  name: 'spawn-write',
  tierKind: 'creative',
  genMode: 'text',
  systemPrompt: '你是网文写作引擎',
}

function hash16(full: string): string {
  return createHash('sha256').update(full).digest('hex').slice(0, 16)
}

describe('N-10（第十二轮）：runSpec 动态 system 进 trace promptMeta', () => {
  afterEach(() => {
    try { for (const d of workDirs.splice(0)) rmSync(d, { recursive: true, force: true }) } catch {
          // Windows 清理竞态（防病毒/句柄占用偶发 EPERM）——best-effort 忽略
        }
  })

  it('llm/call 的 promptMeta.hash 哈希了 system 终值 + userPrompt（不只 userPrompt）', async () => {
    const ud = tempDir('clw-n10-ud-')
    writeProviders(ud)
    const bookRoot = tempDir('clw-n10-book-')
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })

    const out = await runSpec(TEXT_SPEC, { userDataPath: ud, userPrompt: '写第二章', bookRoot })
    expect(out.ok).toBe(true)

    // 进请求的 system 终值（内置解析 + rules 拼接后的）
    const req = generateMock.mock.calls[0]![1] as { systemPrompt: string }
    expect(req.systemPrompt).toContain('你是网文写作引擎')

    const store = openSessionStore(ud, bookRoot)!
    const evs = store.listEvents(bookHash(bookRoot))
    const call = evs.find((e) => e.type === 'llm/call') as
      | { data: { promptMeta?: { hash: string; chars: number } } }
      | undefined
    expect(call).toBeDefined()
    // 修复点：哈希 = sha256(system + user) 前 16 位；R66-8（十四轮）起 hash 输入
    // 前置 systemPrompt 长度前缀（len:full）消字段边界歧义——同 N-10 断言同口径
    expect(call!.data.promptMeta!.hash).toBe(hash16(`${req.systemPrompt.length}:${req.systemPrompt}写第二章`))
    expect(call!.data.promptMeta!.chars).toBe(`${req.systemPrompt}写第二章`.length)
    // 修复前（只哈希 userPrompt）的对照值不得相等
    expect(call!.data.promptMeta!.hash).not.toBe(hash16('写第二章'))
  })
})
