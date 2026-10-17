/**
 * C2（1.0 收口）：400 降级链 attempt 循环（runDegradeAttempts）行为锚。
 *
 * 三适配器的 attempt 循环收敛到 adapter-errors 单源后，续跑判据集中在一处：
 * 建连期 400（未消费）→ 换下一参数面；已消费后任何错误 / 末位 400 / 非 400 → 原样抛出。
 * 本档锁这三条语义，防收敛把「消费后不重跑」的安全闸改丢。
 */
import { describe, it, expect } from 'vitest'
import {
  buildDegradeAttempts,
  runDegradeAttempts,
  type DegradePlan,
} from '../../src/ai/provider/adapter-errors.js'
import type { GenRequest } from '../../src/ai/provider/types.js'

class FakeApiError extends Error {
  status: number | undefined = 400
  headers: unknown = {}
  requestID: string | null = null
}

/** 结构化 + 工具都挂 → attempts = [首发, 剥 structured, 剥 tools]（三级链） */
function makePlan(): DegradePlan {
  return buildDegradeAttempts(
    {
      systemPrompt: 's',
      messages: [],
      structured: { name: 'x' },
      tools: [{ name: 't', description: 'd', input_schema: {} }],
      maxTokens: 100,
    } as never,
    'json_schema',
    { id: 'p', model: 'm' },
    undefined,
  )
}

const CTOR = FakeApiError as unknown as Parameters<typeof runDegradeAttempts>[1]

async function collect<E>(gen: AsyncGenerator<E>): Promise<E[]> {
  const out: E[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describe('C2: runDegradeAttempts 续跑判据', () => {
  it('建连期 400（未消费）→ 换下一参数面，第二次 attempt 产出事件', async () => {
    const plan = makePlan()
    const seen: GenRequest[] = []
    const events = await collect(
      runDegradeAttempts(
        plan,
        CTOR,
        async function* (attempt, ctx) {
          seen.push(attempt)
          if (seen.length === 1) throw new FakeApiError('bad structured')
          ctx.consumed()
          yield 'ev'
        },
        'none',
      ),
    )
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(plan.stripStructured)
    expect(events).toEqual(['ev'])
  })

  it('已消费后再抛 400 → 不续跑（半截产出不泄入下一 attempt），错误原样抛出', async () => {
    const plan = makePlan()
    const seen: GenRequest[] = []
    await expect(
      collect(
        runDegradeAttempts(
          plan,
          CTOR,
          async function* (attempt, ctx) {
            seen.push(attempt)
            ctx.consumed()
            throw new FakeApiError('mid-stream 400')
          },
          'none',
        ),
      ),
    ).rejects.toThrow('mid-stream 400')
    expect(seen).toHaveLength(1)
  })

  it('末位 400 → 不续跑（透传原文，不落兜底文案）', async () => {
    const plan = makePlan()
    const seen: GenRequest[] = []
    await expect(
      collect(
        runDegradeAttempts(
          plan,
          CTOR,
          async function* (attempt) {
            seen.push(attempt)
            throw new FakeApiError('always 400')
          },
          'fallback',
        ),
      ),
    ).rejects.toThrow('always 400')
    expect(seen).toHaveLength(plan.attempts.length)
  })

  it('非 400 错误 → 立即抛出（不试下一参数面）', async () => {
    const plan = makePlan()
    const seen: GenRequest[] = []
    await expect(
      collect(
        runDegradeAttempts(
          plan,
          CTOR,
          async function* (attempt) {
            seen.push(attempt)
            throw new Error('boom')
          },
          'none',
        ),
      ),
    ).rejects.toThrow('boom')
    expect(seen).toHaveLength(1)
  })
})
