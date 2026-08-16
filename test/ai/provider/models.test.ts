/**
 * models.ts 归一化纯函数单测（方案 §6：六家 URL × 带/不带尾斜杠 × 带/不带 /v1 全组合）。
 */
import { describe, expect, it } from 'vitest'
import { normalizeBaseUrl, anthropicClientOpts } from '../../../src/ai/provider/models.js'

describe('normalizeBaseUrl 协议分流（方案 §4.5 P0）', () => {
  it('openai：只去尾部斜杠，不剥 /v1', () => {
    // GPT / Grok / DeepSeek 无 /v1 基址
    expect(normalizeBaseUrl('https://api.openai.com/v1', 'openai')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('https://api.openai.com/v1/', 'openai')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('https://api.deepseek.com', 'openai')).toBe('https://api.deepseek.com')
    expect(normalizeBaseUrl('https://api.x.ai/v1/', 'openai')).toBe('https://api.x.ai/v1')
    // GLM 多级路径带 /v1 也保留
    expect(normalizeBaseUrl('https://open.bigmodel.cn/api/paas/v4', 'openai')).toBe('https://open.bigmodel.cn/api/paas/v4')
  })

  it('anthropic：去尾斜杠 + 剥尾部 /v1（SDK 自拼 /v1/messages）', () => {
    expect(normalizeBaseUrl('https://api.anthropic.com', 'anthropic')).toBe('https://api.anthropic.com')
    expect(normalizeBaseUrl('https://api.anthropic.com/', 'anthropic')).toBe('https://api.anthropic.com')
    expect(normalizeBaseUrl('https://api.anthropic.com/v1', 'anthropic')).toBe('https://api.anthropic.com')
    expect(normalizeBaseUrl('https://api.anthropic.com/v1/', 'anthropic')).toBe('https://api.anthropic.com')
    // 兼容端点（DeepSeek / GLM / Kimi）
    expect(normalizeBaseUrl('https://api.deepseek.com/anthropic', 'anthropic')).toBe('https://api.deepseek.com/anthropic')
    expect(normalizeBaseUrl('https://api.moonshot.cn/anthropic/', 'anthropic')).toBe('https://api.moonshot.cn/anthropic')
  })

  it('多级路径尾部 /v1 也剥（anthropic）', () => {
    expect(normalizeBaseUrl('https://gw.example.com/xxx/v1', 'anthropic')).toBe('https://gw.example.com/xxx')
  })
})

describe('anthropicClientOpts（authToken:null 阻断 env 污染）', () => {
  it('auth=anthropic → 显式 authToken:null + apiKey', () => {
    const opts = anthropicClientOpts('https://ccats.art', 'sk-real-key', 'anthropic')
    expect(opts!.authToken).toBeNull()
    expect(opts!.apiKey).toBe('sk-real-key')
    // defaultHeaders 带 anthropic-version
    expect(opts!.defaultHeaders).toMatchObject({ 'anthropic-version': '2023-06-01' })
  })

  it('auth=claudeAuth/bearer → authToken=apiKey + 显式 apiKey:null（不发 x-api-key）', () => {
    const opts = anthropicClientOpts('https://gw.local', 'sk-bearer', 'claudeAuth')
    expect(opts!.authToken).toBe('sk-bearer')
    // CC-P1-1：null（非 undefined）——undefined 时 SDK 回退读 env ANTHROPIC_API_KEY
    expect(opts).toHaveProperty('apiKey', null)
  })

  it('显式 authToken:null 而非 undefined——SDK 只在 undefined 时读 env，null 则阻断', () => {
    // 回归：ANTHROPIC_AUTH_TOKEN 环境变量污染 → SDK 注入双认证头 → 网关只认
    // authorization → 模型列表只有 2 个。显式 null 阻断（undefined 才会读 env）。
    const opts = anthropicClientOpts('https://ccats.art', 'sk-x', 'anthropic')
    expect(opts).toHaveProperty('authToken', null)
    expect(opts!.authToken === undefined).toBe(false)
  })

  it('CC-P1-1：claudeAuth/bearer 下 apiKey:null 真机阻断 env ANTHROPIC_API_KEY（SDK 实证）', async () => {
    // 回归：claudeAuth/bearer 分支此前 apiKey 留 undefined → 本机设了
    // ANTHROPIC_API_KEY 时 SDK 同发 x-api-key + Bearer 双认证头（严格网关 400/串号）。
    // 用真 SDK 客户端实证：opts.apiKey=null 构造后 client.apiKey 不吃 env。
    const opts = anthropicClientOpts('https://gw.local', 'sk-bearer', 'bearer')
    process.env['ANTHROPIC_API_KEY'] = 'env-leaked-key'
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      // 修复语义：apiKey 显式 null → SDK 不吃 env
      const client = new Anthropic(opts!)
      expect(client.apiKey).toBeNull()
      // 反证：undefined（旧行为）确实会被 env 污染——锁住修复语义
      const polluted = new Anthropic({ ...opts!, apiKey: undefined })
      expect(polluted.apiKey).toBe('env-leaked-key')
    } finally {
      delete process.env['ANTHROPIC_API_KEY']
    }
  })
})
