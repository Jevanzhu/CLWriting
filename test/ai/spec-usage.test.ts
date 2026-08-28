/**
 * V-P2-8 回归：runSpec 必须把 generate/generateTool 的 usage 回传 runner。
 * 修复前真实链路（非 mock）token 计量 / trace / 任务账全程为 0——恰好只有 mock
 * 路径有值，暴露「mock 与真实路径行为相反」的结构性盲区。
 *
 * 集成口径：mock gen 层返回固定 usage → runSpec → runTask → 任务账落
 * bookRoot/.cache/ai-calls.json（provider 解析走真实 store + 明文迁移路径）。
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'

const USAGE = { inputTokens: 11, outputTokens: 7 }

vi.mock('../../src/ai/gen.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/gen.js')>()
  return {
    ...actual,
    generateTool: vi.fn(async () => ({ input: { ok: 1 }, text: '', usage: USAGE, stopReason: 'tool_use' })),
    generate: vi.fn(async () => ({ text: 'ok', reasoning: '', toolCalls: [], usage: USAGE, stopReason: 'end_turn' })),
  }
})

import { runSpec, type TaskSpec } from '../../src/ai/tasks/spec.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const workDirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempTracked(join(tmpdir(), prefix))
  workDirs.push(d)
  return d
}

/** 写最小 providers.json（明文 apiKey，loadProviders 自动迁移加密）——与 runner.test.ts 同款 */
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

const TOOL_SPEC: TaskSpec = {
  name: 'self-heal',
  tierKind: 'creative',
  genMode: 'tool',
  systemPrompt: 's',
  tool: { def: { name: 'submit_x', description: 'd', input_schema: { type: 'object' } }, name: 'submit_x' },
}

const TEXT_SPEC: TaskSpec = {
  name: 'spawn-write',
  tierKind: 'creative',
  genMode: 'text',
  systemPrompt: 's',
}

describe('runSpec usage 回传（V-P2-8）', () => {
  afterEach(() => {
    for (const d of workDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('工具链路：TaskResult.usage 非空 + 任务账记到 token', async () => {
    const ud = tempDir('clw-spec-ud-')
    writeProviders(ud)
    const bookRoot = tempDir('clw-spec-book-')
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })

    const out = await runSpec(TOOL_SPEC, { userDataPath: ud, userPrompt: '写', bookRoot })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.usage).toEqual(USAGE) // 修复前：恒 null
      expect(out.data.usage).toEqual(USAGE) // SpecOutput 同步带回
    }
    const calls = JSON.parse(readFileSync(join(bookRoot, '.cache', 'ai-calls.json'), 'utf8')) as {
      tasks: Record<string, { used: number; inputTokens: number; outputTokens: number }>
    }
    expect(calls.tasks['self-heal']).toMatchObject({ used: 1, inputTokens: 11, outputTokens: 7 })
  })

  it('文本链路：同样回传 usage', async () => {
    const ud = tempDir('clw-spec-ud-')
    writeProviders(ud)
    const out = await runSpec(TEXT_SPEC, { userDataPath: ud, userPrompt: '写' })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.usage).toEqual(USAGE)
  })
})
