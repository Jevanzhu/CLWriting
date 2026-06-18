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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readBookConfig, stringifyBookConfig } from '../format/yaml.js'
import type { BookConfig } from '../format/types.js'

const RAG_SECRET_FILE = 'rag.secret'
const ENV_KEY = 'CLWRITING_RAG_API_KEY'

/** RAG 配置（从 book.yaml 读，非密段） */
export interface RagConfig {
  enabled: boolean
  endpoint?: string
  model?: string
}

/** 读 RAG 配置（book.yaml rag 段；缺段 → 未启用） */
export function readRagConfig(bookRoot: string): RagConfig {
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  if (!cfg.ok || !cfg.config.rag) return { enabled: false }
  return {
    enabled: cfg.config.rag.enabled,
    endpoint: cfg.config.rag.endpoint,
    model: cfg.config.rag.model,
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
  const envKey = process.env[ENV_KEY]
  if (envKey && envKey.trim()) return envKey.trim()

  // 优先级 2：工作目录/.clwriting/rag.secret（.clwriting 非 git）
  const secretPath = join(workDir, '.clwriting', RAG_SECRET_FILE)
  if (existsSync(secretPath)) {
    const key = readFileSync(secretPath, 'utf-8').trim()
    return key || null
  }
  return null
}

/** 写 api_key 到 .clwriting/rag.secret（gitignore 区，绝不写 book.yaml） */
export function writeApiKey(workDir: string, key: string): void {
  const clwritingDir = join(workDir, '.clwriting')
  mkdirSync(clwritingDir, { recursive: true })
  writeFileSync(join(clwritingDir, RAG_SECRET_FILE), key + '\n', 'utf-8')
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
  // 1. 读现有 book.yaml，合并 rag 段（非密）
  const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
  if (!cfgResult.ok) {
    return { ok: false, reason: `读 book.yaml 失败：${cfgResult.error.message}` }
  }
  const config: BookConfig = {
    ...cfgResult.config,
    rag: {
      enabled: true,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    },
  }

  // 2. 写回 book.yaml（非密段；key 绝不在此）
  writeFileSync(join(bookRoot, 'book.yaml'), stringifyBookConfig(config), 'utf-8')

  // 3. key 落 gitignore 区（绝不写 book.yaml）
  if (opts.apiKey) {
    writeApiKey(workDir, opts.apiKey)
  }

  return { ok: true }
}
