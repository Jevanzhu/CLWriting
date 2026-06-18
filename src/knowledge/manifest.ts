/**
 * 知识层 manifest 校验 —— 依据 M4 第 3 节。
 *
 * `知识层/_manifest.json` 是知识素材可复现清单。CI 只相信正式知识层，
 * 不把 ignored 的 Dev/ 参考仓库当隐式输入。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

export const KNOWLEDGE_DIR = '知识层'
export const KNOWLEDGE_MANIFEST = '知识层/_manifest.json'

export interface KnowledgeManifestEntry {
  target: string
  source: string
  source_ref?: string
  license: string
  sha256: string
  category?: '题材' | '爽点' | '追读力' | '方法论' | '许可' | '索引'
  note?: string
}

export interface KnowledgeManifest {
  version: 1
  generated_at: string
  summary: {
    migrated: number
    deferred: number
    review_assets: number
  }
  entries: KnowledgeManifestEntry[]
}

export interface KnowledgeManifestIssue {
  path: string
  message: string
}

export interface KnowledgeManifestReport {
  ok: boolean
  manifest?: KnowledgeManifest
  issues: KnowledgeManifestIssue[]
}

export function readKnowledgeManifest(projectRoot: string): KnowledgeManifestReport {
  const path = join(projectRoot, KNOWLEDGE_MANIFEST)
  if (!existsSync(path)) {
    return { ok: false, issues: [{ path: KNOWLEDGE_MANIFEST, message: '缺少知识层 manifest' }] }
  }

  try {
    const manifest = JSON.parse(readFileSync(path, 'utf-8')) as KnowledgeManifest
    return { ok: true, manifest, issues: [] }
  } catch {
    return { ok: false, issues: [{ path: KNOWLEDGE_MANIFEST, message: '知识层 manifest 不是合法 JSON' }] }
  }
}

export function validateKnowledgeManifest(projectRoot: string): KnowledgeManifestReport {
  const read = readKnowledgeManifest(projectRoot)
  if (!read.ok || read.manifest === undefined) return read

  const manifest = read.manifest
  const issues: KnowledgeManifestIssue[] = []
  if (manifest.version !== 1) {
    issues.push({ path: KNOWLEDGE_MANIFEST, message: 'manifest.version 必须是 1' })
  }
  if (!Array.isArray(manifest.entries)) {
    issues.push({ path: KNOWLEDGE_MANIFEST, message: 'manifest.entries 必须是数组' })
    return { ok: false, manifest, issues }
  }

  const seen = new Set<string>()
  for (const entry of manifest.entries) {
    validateEntry(projectRoot, entry, seen, issues)
  }

  return { ok: issues.length === 0, manifest, issues }
}

export function formatKnowledgeManifestReport(report: KnowledgeManifestReport): string {
  if (report.ok) {
    const count = report.manifest?.entries.length ?? 0
    return `✓ 知识层 manifest 校验通过（${count} 个条目）。`
  }
  return ['✗ 知识层 manifest 校验失败：', ...report.issues.map((issue) => `· ${issue.path}: ${issue.message}`)].join('\n')
}

export function hashFileSha256(filePath: string): string {
  return 'sha256:' + createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function validateEntry(
  projectRoot: string,
  entry: KnowledgeManifestEntry,
  seen: Set<string>,
  issues: KnowledgeManifestIssue[],
): void {
  if (!isSafeKnowledgeTarget(projectRoot, entry.target)) {
    issues.push({ path: entry.target, message: 'target 必须位于知识层/ 内，且不能路径穿越' })
    return
  }
  if (seen.has(entry.target)) {
    issues.push({ path: entry.target, message: 'target 在 manifest 中重复' })
  }
  seen.add(entry.target)

  if (!entry.source || !entry.license) {
    issues.push({ path: entry.target, message: 'source 与 license 必填' })
  }
  if (!entry.sha256?.startsWith('sha256:')) {
    issues.push({ path: entry.target, message: 'sha256 必须带 sha256: 前缀' })
  }

  const filePath = join(projectRoot, entry.target)
  if (!existsSync(filePath)) {
    issues.push({ path: entry.target, message: 'manifest 条目对应文件不存在' })
    return
  }

  const actual = hashFileSha256(filePath)
  if (actual !== entry.sha256) {
    issues.push({ path: entry.target, message: `sha256 不匹配，manifest=${entry.sha256} actual=${actual}` })
  }

  if (entry.target.endsWith('.md')) {
    validateMarkdownMetadata(filePath, entry, issues)
  }
}

function validateMarkdownMetadata(
  filePath: string,
  entry: KnowledgeManifestEntry,
  issues: KnowledgeManifestIssue[],
): void {
  const text = readFileSync(filePath, 'utf-8')
  const rel = entry.target
  if (!text.includes(`source: ${entry.source}`)) {
    issues.push({ path: rel, message: 'Markdown 文件缺少与 manifest 一致的 source 元信息' })
  }
  if (!text.includes(`license: ${entry.license}`)) {
    issues.push({ path: rel, message: 'Markdown 文件缺少与 manifest 一致的 license 元信息' })
  }
}

function isSafeKnowledgeTarget(projectRoot: string, target: string): boolean {
  if (isAbsolute(target)) return false
  if (!target.startsWith(`${KNOWLEDGE_DIR}/`)) return false
  const abs = join(projectRoot, target)
  const rel = relative(projectRoot, abs).replace(/\\/g, '/')
  return rel === target && !rel.startsWith('../')
}
