/**
 * RAG 配置 + key 安全落点 —— 依据 M7 #37 spec 第 2 节。
 *
 * 红线 H1：api_key 绝不进 git。
 * - 非密信息（enabled/endpoint/model）入 book.yaml 的 rag 段
 * - api_key 落 gitignore 区：环境变量 > 工作目录/.clwriting/rag.secret（.clwriting 非 git）
 *
 * 不启用（无 rag 段 / enabled: false）→ 全无 RAG，主路径零影响。
 */

import process from 'node:process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readBookConfig } from '../format/yaml.js'
import { readGlobalBookDefaults } from '../format/global-defaults.js'
import { log } from '../log/index.js'

const RAG_SECRET_FILE = 'rag.secret'
const ENV_KEY = 'CLWRITING_RAG_API_KEY'

/** RAG 配置（从 book.yaml 读，非密段） */
export interface RagConfig {
  enabled: boolean
  /** RAG 服务商 id（应用级 providers.json ragProviders[].id，书里只存引用） */
  provider?: string
  /** 旧版内联（服务商标应用级前的存量配置；resolver 回落用，不再写入） */
  endpoint?: string
  model?: string
  /** A3（批 7）：召回惰性指纹校验候选章上限（book.yaml rag.candidate_depth，缺省 20） */
  candidate_depth?: number
  /** R62-27：embedding 单请求超时毫秒（book.yaml rag.embed_timeout_ms，缺省 embed.ts
   *  内置 30s）。「默认值显式 resolve」守则：此前 30s 只活在 embed.ts 默认参数里，
   *  调用点重造 config 字面量时无从透传；读侧收口后 build/recall 两侧统一从
   *  RagConfig resolve，非正整数不收（与 candidate_depth 同口径）。 */
  embed_timeout_ms?: number
}

/**
 * 读 RAG 配置（book.yaml rag 段；缺段 → 全局托底）。
 * R29-3（二十九轮）：「配置损坏」与「未设段」分岔——book.yaml 读不出/解析失败时书级
 * RAG 意图不可知，fail-closed 直接禁用（修复前与缺段同路：损坏书会被全局默认 ragEnabled
 * 拉去建索引/召回，对着残缺配置烧 embedding 费）；带解析错误 log.warn 留痕。
 * 全局托底：enabled/provider 书级未设（rag 键缺席）时回落 global.json 的
 * ragEnabled/ragProvider（userDataPath 缺省/无 global.json → 行为与此前完全一致）。
 * 书级显式关闭（enabled: false）永远赢——全局默认只托「未设」，不翻「本书已关」的案。
 */
export function readRagConfig(bookRoot: string, userDataPath?: string | null): RagConfig {
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  const global = readGlobalBookDefaults(userDataPath ?? null)
  if (!cfg.ok) {
    // R29-3（二十九轮）：损坏不托底——禁用并留痕（book.yaml 是书库必需件，读不出
    // 视同配置不可知；缺段才走下方全局托底口径不变）
    log.warn('rag', `book.yaml 读取/解析失败，RAG 对本书禁用（防按全局默认误建索引/召回）：${cfg.error.message}`)
    return { enabled: false }
  }
  if (!cfg.config.rag) {
    // 书级未设：enabled 回落 global（无则关）；provider 无硬编码回落，global 没有就不带
    if (global.ragEnabled === undefined && global.ragProvider === undefined) return { enabled: false }
    return {
      enabled: global.ragEnabled ?? false,
      ...(global.ragProvider !== undefined ? { provider: global.ragProvider } : {}),
    }
  }
  const rag = cfg.config.rag
  return {
    enabled: rag.enabled,
    // provider 引用未设时回落 global.ragProvider（无回落——服务商无法凭空选）
    provider: rag.provider ?? global.ragProvider,
    endpoint: rag.endpoint,
    model: rag.model,
    // 非正整数不收（2026-08-21）：0/负数会让召回首轮即 break 恒空（静默降级无告警），
    // 与「缺省 20」同视为未配置
    candidate_depth:
      typeof rag.candidate_depth === 'number' && Number.isInteger(rag.candidate_depth) && rag.candidate_depth >= 1
        ? rag.candidate_depth
        : undefined,
    // R62-27：非正整数不收（0/负数会让 AbortController 立即 abort 恒失败），与缺省同视为未配置
    embed_timeout_ms:
      typeof rag.embed_timeout_ms === 'number' && Number.isInteger(rag.embed_timeout_ms) && rag.embed_timeout_ms >= 1
        ? rag.embed_timeout_ms
        : undefined,
  }
}

/**
 * 读 api_key（优先级：环境变量 > .clwriting/rag.secret）。
 * 两者皆无 → null（调用方据此降级，不阻断）。
 *
 * 红线 H1：绝不从 book.yaml / 书仓库任何文件读 key。
 */
export function readApiKey(workDir: string): string | null {
  // 优先级 1：环境变量
  const envKey = envRagApiKey()
  if (envKey) return envKey

  // 优先级 2：工作目录/.clwriting/rag.secret（.clwriting 非 git）
  const secretPath = join(workDir, '.clwriting', RAG_SECRET_FILE)
  if (existsSync(secretPath)) {
    const key = readFileSync(secretPath, 'utf8').trim()
    return key || null
  }
  return null
}

/** 读环境变量 CLWRITING_RAG_API_KEY（trim 后为空 → ''）。
 *  服务商/旧版两条解析链共用：env 永远最高优先（运维覆盖一切落盘 key）。 */
export function envRagApiKey(): string {
  const k = process.env[ENV_KEY]
  return k && k.trim() ? k.trim() : ''
}
