/**
 * models.ts 归一化纯函数单测（方案 §6：六家 URL × 带/不带尾斜杠 × 带/不带 /v1 全组合）。
 */
import { describe, expect, it } from 'vitest'
import { normalizeBaseUrl, anthropicClientOpts } from '../../../src/ai/provider/models.js'
import { readRepoFile } from '../../helpers/repo-root.js'

describe('normalizeBaseUrl 协议分流（方案 §4.5 P0）', () => {
  it('openai：只去尾部斜杠，不剥 /v1', () => {
    // GPT / Grok / DeepSeek 无 /v1 基址
    expect(normalizeBaseUrl('https://api.openai.com/v1', 'openai')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('https://api.openai.com/v1/', 'openai')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('https://api.deepseek.com', 'openai')).toBe('https://api.deepseek.com')
    expect(normalizeBaseUrl('https://api.x.ai/v1/', 'openai')).toBe('https://api.x.ai/v1')
    // GLM 多级路径带 /v1 也保留
    expect(normalizeBaseUrl('https://open.bigmodel.cn/api/paas/v4', 'openai')).toBe(
      'https://open.bigmodel.cn/api/paas/v4',
    )
  })

  it('anthropic：去尾斜杠 + 剥尾部 /v1（SDK 自拼 /v1/messages）', () => {
    expect(normalizeBaseUrl('https://api.anthropic.com', 'anthropic')).toBe('https://api.anthropic.com')
    expect(normalizeBaseUrl('https://api.anthropic.com/', 'anthropic')).toBe('https://api.anthropic.com')
    expect(normalizeBaseUrl('https://api.anthropic.com/v1', 'anthropic')).toBe('https://api.anthropic.com')
    expect(normalizeBaseUrl('https://api.anthropic.com/v1/', 'anthropic')).toBe('https://api.anthropic.com')
    // 兼容端点（DeepSeek / GLM / Kimi）
    expect(normalizeBaseUrl('https://api.deepseek.com/anthropic', 'anthropic')).toBe(
      'https://api.deepseek.com/anthropic',
    )
    expect(normalizeBaseUrl('https://api.moonshot.cn/anthropic/', 'anthropic')).toBe(
      'https://api.moonshot.cn/anthropic',
    )
  })

  it('多级路径尾部 /v1 也剥（anthropic）', () => {
    expect(normalizeBaseUrl('https://gw.example.com/xxx/v1', 'anthropic')).toBe('https://gw.example.com/xxx')
  })
})

describe('normalizeBaseUrl 单源边界表（openai 线两协议逐位同结果）', () => {
  // 边界面：尾斜杠（单/多）、/v1 保留、/v1/messages 类后缀不误伤、空串、
  // 空白（不 trim）、大小写（不折）
  const OPENAI_LINE: Array<[string, string]> = [
    ['https://api.openai.com/v1', 'https://api.openai.com/v1'],
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1'],
    ['https://api.openai.com/v1///', 'https://api.openai.com/v1'],
    ['https://api.deepseek.com', 'https://api.deepseek.com'],
    ['https://gw.example.com/xxx/v1', 'https://gw.example.com/xxx/v1'],
    ['https://gw.example.com/v1/messages', 'https://gw.example.com/v1/messages'],
    ['', ''],
    ['https://api.x.ai/v1 ', 'https://api.x.ai/v1 '],
    ['HTTPS://API.X.AI/V1', 'HTTPS://API.X.AI/V1'],
  ]

  it('openai 与 openai-responses 同输入 → 同归一结果（openai-adapter/responses-adapter 共用单源）', () => {
    for (const [input, expected] of OPENAI_LINE) {
      expect(normalizeBaseUrl(input, 'openai'), `${input} @openai`).toBe(expected)
      expect(normalizeBaseUrl(input, 'openai-responses'), `${input} @openai-responses`).toBe(expected)
    }
  })

  it('anthropic 线差异面：仅多剥一层尾部 /v1（其余边界与 openai 线同构）', () => {
    expect(normalizeBaseUrl('https://api.anthropic.com/v1///', 'anthropic')).toBe('https://api.anthropic.com')
    expect(normalizeBaseUrl('https://gw.example.com/v1/messages', 'anthropic')).toBe(
      'https://gw.example.com/v1/messages',
    )
    expect(normalizeBaseUrl('', 'anthropic')).toBe('')
    expect(normalizeBaseUrl('https://api.x.ai/v1 ', 'anthropic')).toBe('https://api.x.ai/v1 ')
    expect(normalizeBaseUrl('HTTPS://API.ANTHROPIC.COM/V1', 'anthropic')).toBe('HTTPS://API.ANTHROPIC.COM/V1')
  })
})

// ── 归单单源锁：normalizeBaseUrl 的唯一实现体住 models.ts，三条线
//    （anthropic / openai / openai-responses）各自按协议显式调用，档内不得复写副本。──
describe('baseUrl 归单单源锁（三档委派 models.normalizeBaseUrl）', () => {
  const CALL_SITES: Array<[string, string]> = [
    ['src/ai/provider/anthropic-adapter.ts', "normalizeBaseUrl(conf.baseUrl, 'anthropic')"],
    ['src/ai/provider/openai-adapter.ts', "normalizeBaseUrl(conf.baseUrl, 'openai')"],
    ['src/ai/provider/responses-adapter.ts', "normalizeBaseUrl(conf.baseUrl, 'openai-responses')"],
  ]
  // 单源委派形态：从 './models.js' import 出 normalizeBaseUrl
  const IMPORT_FROM_MODELS = /import\s*\{[^}]*\bnormalizeBaseUrl\b[^}]*\}\s*from\s*'\.\/models\.js'/
  // 本地实现体形态（任一档复活副本即红）
  const LOCAL_IMPL = /function\s+normalize(?:BaseUrl|OpenAIBaseUrl)\s*\(/

  it('单源本尊：models.ts 导出协议分流的唯一实现体', () => {
    const src = readRepoFile('src/ai/provider/models.ts')
    expect(src).toContain('export function normalizeBaseUrl(baseUrl: string, protocol: Protocol): string')
    expect(src).toContain("protocol === 'anthropic'")
  })

  it('三档均 import 单源并显式传各自协议；档内不再出现本地实现体', () => {
    for (const [file, call] of CALL_SITES) {
      const src = readRepoFile(file)
      expect(IMPORT_FROM_MODELS.test(src), `${file} 应 import 单源`).toBe(true)
      expect(src, file).toContain(call)
      expect(LOCAL_IMPL.test(src), `${file} 不得再写本地副本`).toBe(false)
    }
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
