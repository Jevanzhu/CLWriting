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
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { readBookConfig, patchTopSection } from '../format/yaml.js'
import { readGlobalBookDefaults } from '../format/global-defaults.js'
import { stringifyValue } from '../format/frontmatter.js'

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
}

/**
 * 读 RAG 配置（book.yaml rag 段；缺段 → 未启用）。
 * 全局托底：enabled/provider 书级未设时回落 global.json 的 ragEnabled/ragProvider
 * （userDataPath 缺省/无 global.json → 行为与此前完全一致）。书级显式关闭（enabled: false）
 * 永远赢——全局默认只托「未设」，不翻「本书已关」的案。
 */
export function readRagConfig(bookRoot: string, userDataPath?: string | null): RagConfig {
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  const global = readGlobalBookDefaults(userDataPath ?? null)
  if (!cfg.ok || !cfg.config.rag) {
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

/** 写 api_key 到 .clwriting/rag.secret（gitignore 区，绝不写 book.yaml） */
export function writeApiKey(workDir: string, key: string): void {
  const clwritingDir = join(workDir, '.clwriting')
  mkdirSync(clwritingDir, { recursive: true })
  ensureRagSecretGitignore(workDir)
  // RB-IF-P2-6：临时文件按 0600 创建后 rename——修复前先落盘后 chmod，默认 umask
  // （0644）窗口内凭据全局可读。rename 保持原子性；覆盖旧文件时同样以 0600 面世
  atomicWriteFile(join(clwritingDir, RAG_SECRET_FILE), key + '\n', { mode: 0o600 })
}

/** 给 rag.secret 加显式忽略兜底，避免工作目录被误放进 git 后泄露 key。 */
function ensureRagSecretGitignore(workDir: string): void {
  const clwritingDir = join(workDir, '.clwriting')
  const ignorePath = join(clwritingDir, '.gitignore')
  const existing = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf-8') : ''
  const lines = existing.split(/\r?\n/)
  if (lines.includes(RAG_SECRET_FILE)) return
  const prefix = existing === '' || existing.endsWith('\n') ? existing : existing + '\n'
  atomicWriteFile(ignorePath, prefix + RAG_SECRET_FILE + '\n')
}

/**
 * 启用 RAG：写 book.yaml rag 非密段 + 引导 key 落 .clwriting/rag.secret。
 *
 * @param bookRoot 书仓库（写 book.yaml）
 * @param workDir 工作目录（key 落 .clwriting/）
 * @param opts 非密配置 + 可选 key（key 不入 book.yaml）
 */
export interface EnableRagOpts {
  endpoint?: string
  model?: string
  /** 可选：直接写 key 到 .clwriting/rag.secret（不进 book.yaml） */
  apiKey?: string
  /** 可选：提示作者用环境变量而不落文件 */
  useEnv?: boolean
}

export function enableRag(
  bookRoot: string,
  workDir: string,
  opts: EnableRagOpts,
): { ok: true } | { ok: false; reason: string } {
  // 1. 校验现有 book.yaml 可解析（合并 rag 段前确认基线合法）
  const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
  if (!cfgResult.ok) {
    return { ok: false, reason: `读 book.yaml 失败：${cfgResult.error.message}` }
  }
  // 已有 rag 段的非密字段做合并语义：未提供新值时保留旧值
  const prev = cfgResult.config.rag
  const endpoint = opts.endpoint ?? prev?.endpoint
  const model = opts.model ?? prev?.model
  // dd-P2：provider 引用同样保留——ragBody 此前不含 provider 行，整段替换后
  // 服务商引用被静默抹掉、resolve 链回落旧内联端点（换端点烧钱）
  const provider = prev?.provider

  // 2. 写回 book.yaml——V-P2-4：文本级补丁只重写 rag 段，作者的 # 注释、未知段、
  //    未知子键逐字保留（此前 stringifyBookConfig 全量重生成会静默丢掉）。
  //    key 绝不在此。
  const yamlPath = join(bookRoot, 'book.yaml')
  const raw = existsSync(yamlPath) ? readFileSync(yamlPath, 'utf-8') : ''
  const ragBody = [
    '  enabled: true',
    ...(provider ? [`  provider: ${stringifyValue(provider)}`] : []),
    ...(endpoint ? [`  endpoint: ${stringifyValue(endpoint)}`] : []),
    ...(model ? [`  model: ${stringifyValue(model)}`] : []),
  ].join('\n')
  atomicWriteFile(yamlPath, patchTopSection(raw, 'rag', ragBody))

  // 3. key 落 gitignore 区（绝不写 book.yaml）
  if (opts.apiKey) {
    writeApiKey(workDir, opts.apiKey)
  }

  return { ok: true }
}
