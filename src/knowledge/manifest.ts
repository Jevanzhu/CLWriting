/**
 * 知识层 manifest 校验 —— 依据 M4 第 3 节。
 *
 * `知识层/_manifest.json` 是知识素材可复现清单。CI 只相信正式知识层，
 * 不把 ignored 的 Dev/ 参考仓库当隐式输入。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { splitFrontMatter } from '../format/frontmatter.js'
import { resolveWithinRoot } from '../fs/safe-path.js'

export const KNOWLEDGE_DIR = '知识层'
export const KNOWLEDGE_MANIFEST = '知识层/_manifest.json'

// R33-97（三十三轮）：win 大小写不敏感 FS 上 `知识层/A.md` 与 `知识层/a.md` 落同一物理文件，
// 精确字符串判重会放行双登记（同 document/manifest.ts R33-54 lockKey 同款口径）——win 折叠判重
// R40-16（四十轮）：导出复用——commitKnowledgeFile 登记侧判重（update.ts）此前仍是
// 精确比较（校验器折叠/登记器不折叠的口径分裂），大小写漂移下同文件可重登双条目
export function caseFoldKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

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
    // R40-16（四十轮）：坏形状行（null/非对象）在此前 entry.target 处直接 TypeError
    // 崩整个对账（commitKnowledgeFile 末尾就走这里——判重侧的坏行跳过被对账侧裸崩
    // 抵消，手编半写形态仍登不进）。对齐登记侧降级口径：报 issue 不崩，后续字段校验
    // 对坏行无意义，跳过（条目本身仍原样保留，写入侧不静默增删改）。
    if (entry === null || typeof entry !== 'object') {
      issues.push({ path: KNOWLEDGE_MANIFEST, message: '存在坏形状条目（null/非对象），请修复 manifest' })
      continue
    }
    validateEntry(projectRoot, entry, seen, issues)
  }

  return { ok: issues.length === 0, manifest, issues }
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
  if (seen.has(caseFoldKey(entry.target))) {
    issues.push({ path: entry.target, message: 'target 在 manifest 中重复' })
  }
  seen.add(caseFoldKey(entry.target))

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

  // 第五轮：单文件读失败（EACCES/竞态 ENOENT）记 issue 继续——抛出会让整场校验崩掉，
  // 一个坏文件遮蔽其余全部条目的结果
  try {
    const actual = hashFileSha256(filePath)
    if (actual !== entry.sha256) {
      issues.push({ path: entry.target, message: `sha256 不匹配，manifest=${entry.sha256} actual=${actual}` })
    }

    if (entry.target.endsWith('.md')) {
      validateMarkdownMetadata(filePath, entry, issues)
    }
  } catch (e) {
    issues.push({ path: entry.target, message: `文件读取失败，无法校验：${e instanceof Error ? e.message : String(e)}` })
  }
}

function validateMarkdownMetadata(
  filePath: string,
  entry: KnowledgeManifestEntry,
  issues: KnowledgeManifestIssue[],
): void {
  const text = readFileSync(filePath, 'utf-8')
  const rel = entry.target
  // M-5（二轮复审）：只认 front matter 块内的 source/license 键（fm 原文逐行前缀匹配）。
  // 此前 text.includes 全文子串——正文任意位置出现「source: x」字样即通过（无 fm 也过），
  // `source: X` 前缀可吞 `source: XYZ`，license 溯源 CI 门的信任度被架空
  const fm = fmScalar(text, 'source')
  if (fm !== entry.source) {
    issues.push({ path: rel, message: 'Markdown 文件 front matter 缺少与 manifest 一致的 source 元信息' })
  }
  const lic = fmScalar(text, 'license')
  if (lic !== entry.license) {
    issues.push({ path: rel, message: 'Markdown 文件 front matter 缺少与 manifest 一致的 license 元信息' })
  }
}

/** fm 块内取顶层标量键值（`key: value` 行，剥引号；无 fm / 无键 → null）。
 *  只做逐行前缀匹配（值原样取到行尾），不递归列表/嵌套——知识层 fm 均为标量。 */
function fmScalar(text: string, key: string): string | null {
  const split = splitFrontMatter(text)
  if (!split) return null
  const prefix = `${key}:`
  for (const raw of split.fmRaw.split('\n')) {
    const line = raw.trim()
    if (line.startsWith(prefix)) {
      let v = line.slice(prefix.length).trim()
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1)
      if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1)
      return v
    }
  }
  return null
}

export function isSafeKnowledgeTarget(projectRoot: string, target: string): boolean {
  if (isAbsolute(target)) return false
  if (!target.startsWith(`${KNOWLEDGE_DIR}/`)) return false
  // 四轮复审（M-7 同款收口）：统一委托 resolveWithinRoot——此前手写 join+relative 往返
  // 校验是全库第六套平行实现，无 symlink 防护，知识层/ 内放指向库外的 symlink 可让
  // 校验器读/哈希库外文件（realpath 抛 → 拒绝，fail-closed）
  // R61-2（第六十一轮）：resolveWithinRoot 只保证不越**项目根**，`知识层/../库外.md`
  // 解析后 rel=库外.md 仍在根内 → 穿透目录边界；追加规范化 rel 前缀判（解析后路径为准）。
  const resolved = resolveWithinRoot(projectRoot, target)
  return resolved !== null && resolved.rel.startsWith(`${KNOWLEDGE_DIR}/`)
}
