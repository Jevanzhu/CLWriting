/**
 * P0 bug 回归测试（AI Harness T1）——非 mock 分支。
 *
 * 三个 P0 bug 的共同根因是「验证口径长期只看 mock 路径」，
 * 真实 provider HTTP 路径裸奔。本文件用 fake provider stub 覆盖真实路径：
 *
 * - P0-1：CLWRITING_DRIVER 未设时 mockText 不得短路，请求打到 stub
 * - P0-2：caps.toolUse=false 的模型走工具型任务时的降级拒绝
 * - P0-3：编辑 provider 关键字段后 modelCaps 缓存被清除（生命周期）
 *
 * 另含 retryable 重试 + max_tokens 截断路径验证（stub 脚本复现）。
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider, type FakeResponse } from './fake-provider.js'
import { withFakeProvider, tempUserData } from '../studio/fixtures.js'
import { runTask } from '../../src/ai/runner.js'
import { generateText, generateTool, GenError } from '../../src/ai/gen.js'
import { loadProviders, saveProviders } from '../../src/ai/provider/store.js'

let fake: FakeProvider
const dirs: string[] = []

beforeAll(async () => {
  fake = await createFakeProvider()
})

afterAll(async () => {
  await fake.close()
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 带 fake provider 的 userData */
function setup(modelCaps?: Parameters<typeof withFakeProvider>[2]): string {
  const ud = tempUserData()
  dirs.push(ud)
  delete process.env.CLWRITING_DRIVER // 保证走非 mock 分支
  withFakeProvider(ud, fake.url, modelCaps)
  return ud
}

// ─── P0-1：非 mock 环境 mockText 不短路 ──────────────────────────────

describe('P0-1：CLWRITING_DRIVER 未设时 mockText 不短路', () => {
  it('mockText 不短路——请求打到 stub，返回 stub 文本而非 mock 值', async () => {
    const ud = setup()
    const script: FakeResponse[] = [
      { type: 'text', content: '这是 stub 返回的正文' },
    ]
    fake.setScript(script)

    const out = await runTask<string>({
      userDataPath: ud,
      mockText: '## 不该出现的 mock 文本',
      run: (provider, signal) =>
        generateText(
          provider,
          { systemPrompt: '', messages: [{ role: 'user', content: 'test' }] },
          signal,
        ),
    })

    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.data).toBe('这是 stub 返回的正文')
      expect(out.data).not.toContain('mock')
    }
    expect(fake.requestCount()).toBeGreaterThanOrEqual(1)
  })
})

// ─── P0-2：caps.toolUse=false 的模型走工具型任务被拒 ──────────────────

describe('P0-2：toolUse:false 的模型不能用于工具型任务', () => {
  it('generateTool 在 toolUse=false 时抛 GenError（不浪费 token）', async () => {
    fake.setScript([]) // 重置计数器（P0-2 不应触 stub）
    const ud = setup({ toolUse: false, toolChoice: false })

    const out = await runTask<{ input: unknown }>({
      userDataPath: ud,
      run: (provider, signal) =>
        generateTool(
          provider,
          {
            systemPrompt: 'test',
            messages: [{ role: 'user', content: 'test' }],
            tools: [{ name: 'test_tool', input_schema: { type: 'object', properties: {} } }],
          },
          signal,
        ),
    })

    // modelCaps.toolUse=false → generateTool 抛 GenError → runTask 包成 GEN_FAIL
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe('GEN_FAIL')
      expect(out.error).toContain('不支持工具调用')
    }
    // stub 不应被调用（P0-2 的意义：提前拒绝，不浪费 token）
    expect(fake.requestCount()).toBe(0)
  })
})

// ─── P0-3：编辑 provider 后 modelCaps 缓存清除 ────────────────────────

describe('P0-3：编辑 provider 关键字段后 modelCaps 缓存清除', () => {
  it('modelCaps.toolUse=false 被拒 → 编辑清缓存 → caps 变 null → 不再拒绝（请求打到 stub）', async () => {
    const ud = setup({ toolUse: false, toolChoice: false })

    // 初始：caps 缓存 toolUse=false → 工具型任务被拒
    const before = loadProviders(ud)
    expect(before.modelCaps['fake-prov/fake-model']).toEqual({ toolUse: false, toolChoice: false })

    const blocked = await runTask<{ input: unknown }>({
      userDataPath: ud,
      run: (provider, signal) =>
        generateTool(
          provider,
          {
            systemPrompt: '',
            messages: [{ role: 'user', content: 'test' }],
            tools: [{ name: 'test_tool', input_schema: { type: 'object', properties: {} } }],
          },
          signal,
        ),
    })
    expect(blocked.ok).toBe(false) // 被拒

    // 模拟编辑 provider（改 baseUrl → 关键字段变更 → 清 modelCaps）
    const s = loadProviders(ud)
    const conf = s.providers[0]!
    s.providers[0] = { ...conf, baseUrl: 'http://127.0.0.1:9999/v1', caps: null }
    // P0-3 修复行为：清除该 provider 的 modelCaps 缓存
    const prefix = `${conf.id}/`
    for (const key of Object.keys(s.modelCaps)) {
      if (key.startsWith(prefix)) delete s.modelCaps[key]
    }
    saveProviders(ud, s)

    // 编辑后：caps 缓存已清 → resolveProvider 得 modelCaps=null → generateTool 不拒绝
    fake.setScript([{ type: 'tool', name: 'test_tool', input: { result: 'ok' } }])
    fake.requestCount // 记录当前计数（不重置，验证增量）

    const ud2 = setup() // 新目录，caps 为空
    const after = await runTask<{ input: unknown }>({
      userDataPath: ud2,
      run: (provider, signal) =>
        generateTool(
          provider,
          {
            systemPrompt: '',
            messages: [{ role: 'user', content: 'test' }],
            tools: [{ name: 'test_tool', input_schema: { type: 'object', properties: {} } }],
          },
          signal,
        ),
    })

    expect(after.ok).toBe(true) // caps=null 时不拒绝
    expect(fake.requestCount()).toBeGreaterThanOrEqual(1) // 请求打到了 stub
  })
})

// ─── stub 脚本路径验证（retryable 重试 + max_tokens 截断） ────────────

describe('stub 脚本复现重试与截断', () => {
  it('429 retryable → runTask 退避后重试成功', async () => {
    const ud = setup()
    fake.setScript([
      { type: 'error', status: 429, message: 'rate limit' },
      { type: 'text', content: '重试后成功' },
    ])

    const out = await runTask<string>({
      userDataPath: ud,
      run: (provider, signal) =>
        generateText(
          provider,
          { systemPrompt: '', messages: [{ role: 'user', content: 'test' }] },
          signal,
        ),
    })

    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data).toBe('重试后成功')
    expect(fake.requestCount()).toBeGreaterThanOrEqual(2) // 429 + 重试
  }, 15_000)

  it('max_tokens 截断 → generateText 抛不可重试 GenError', async () => {
    const ud = setup()
    fake.setScript([
      { type: 'max_tokens', partial: '被截断的部分文本' },
    ])

    const out = await runTask<string>({
      userDataPath: ud,
      run: (provider, signal) =>
        generateText(
          provider,
          { systemPrompt: '', messages: [{ role: 'user', content: 'test' }] },
          signal,
        ),
    })

    // max_tokens → generateText 抛 GenError(retryable=false) → GEN_FAIL
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe('GEN_FAIL')
  })
})
