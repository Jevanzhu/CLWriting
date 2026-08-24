/**
 * 知识层更新入口（阶段 23 批 4：迭代建议清偿·D3=a 双步 script，讨论稿建议 8）。
 *
 * 语料回归域沉淀的机检误报规律（test/corpus/checks/*.json 的 expect:"silent" 条目，
 * corpus:commit 产物）此前无正式归宿——本模块给「知识层」接上演化通道：
 *
 * ①update（产草稿）：扫语料回归域 → 汇总各 checkId 误报规律 → 落
 *   `知识层/机检误报-草稿-<date>.md`。**不动 `_manifest.json`**。
 * ②commit（登记定稿）：作者审核/改名草稿后，把定稿文件登记进 manifest
 *   （sha256 实算 + source=语料回归域 + source_ref 指账本），全量重写
 *   `_manifest.json`（JSON.stringify(m,null,2)+'\n' 与现文件往返字节恒等，
 *   仅 generated_at 与新增条目变化——存量恒等红线由测试锁死）。
 *
 * 红线：作者审核才入库（同 src/learn/commit.ts 头注口径）——update 只产草稿、
 * commit 只登记传入的显式 target，不自动扫描入库。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  KNOWLEDGE_DIR,
  KNOWLEDGE_MANIFEST,
  hashFileSha256,
  readKnowledgeManifest,
  validateKnowledgeManifest,
  type KnowledgeManifest,
  type KnowledgeManifestEntry,
  type KnowledgeManifestReport,
} from './manifest.js'
import { splitFrontMatter } from '../format/frontmatter.js'

/** 语料回归域单 checkId 的误报/命中汇总 */
export interface FalsePositiveSummary {
  checkId: string
  /** 误报条数（expect:"silent"——机检命中但作者判正常） */
  silent: number
  /** 命中条数（expect:"fire"——真命中，作对照口径） */
  fire: number
  /** 误报摘录（最多 3 条，供作者归纳规律） */
  excerpts: string[]
}

interface CorpusEntry {
  excerpt: string
  expect: 'fire' | 'silent'
}

/** 扫语料回归域（<corpusDir>/*.json）：汇总各 checkId 的误报规律。无 silent 条目的 checkId 不出段。 */
export function summarizeFalsePositives(corpusDir: string): FalsePositiveSummary[] {
  if (!existsSync(corpusDir)) return []
  const out: FalsePositiveSummary[] = []
  for (const f of readdirSync(corpusDir).filter((n) => n.endsWith('.json')).sort()) {
    const checkId = f.slice(0, -'.json'.length)
    let entries: CorpusEntry[]
    try {
      entries = JSON.parse(readFileSync(join(corpusDir, f), 'utf8')) as CorpusEntry[]
    } catch {
      continue // 坏文件跳过：update 是产草稿不是门禁，不因单文件炸整轮
    }
    const silent = entries.filter((e) => e.expect === 'silent')
    if (silent.length === 0) continue
    out.push({
      checkId,
      silent: silent.length,
      fire: entries.length - silent.length,
      excerpts: silent.slice(0, 3).map((e) => e.excerpt),
    })
  }
  return out
}

/** 渲染草稿正文（纯函数，不落盘）——作者在此文件上删改归纳，定稿后走 commit。 */
export function renderFalsePositiveDraft(summaries: FalsePositiveSummary[], date: string): string {
  const lines: string[] = [
    '# 机检误报规律（草稿）',
    '',
    `- 生成日期：${date}`,
    '- 来源：语料回归域（test/corpus/checks/*.json，corpus:commit 产物）的 expect:"silent" 条目汇总',
    '- **草稿——未经作者审核不得入库（knowledge:commit）**；审核要点：逐段判断误报语境是否可归纳为通用规律，',
    '  删掉孤例/巧合，改写「误报语境」段为自己的话；定稿时把文件名中的「草稿-<date>-」去掉（或改成明确的主题名）。',
    '',
  ]
  if (summaries.length === 0) {
    lines.push('（当前语料回归域无 expect:"silent" 条目——无可汇总的误报规律。）', '')
  }
  for (const s of summaries) {
    lines.push(
      `## ${s.checkId}`,
      '',
      `- 误报 ${s.silent} 条 / 真命中 ${s.fire} 条（对照口径）`,
      '- 误报语境（作者归纳）：TODO',
      '- 摘录（最多 3 条）：',
    )
    for (const e of s.excerpts) lines.push(`  > ${e}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** 落草稿：`知识层/机检误报-草稿-<date>.md`。返回相对项目根路径。**不动 manifest。** */
export function writeFalsePositiveDraft(projectRoot: string, corpusDir: string, date: string): string {
  const rel = `${KNOWLEDGE_DIR}/机检误报-草稿-${date}.md`
  mkdirSync(join(projectRoot, KNOWLEDGE_DIR), { recursive: true })
  writeFileSync(join(projectRoot, rel), renderFalsePositiveDraft(summarizeFalsePositives(corpusDir), date), 'utf8')
  return rel
}

export interface CommitKnowledgeOpts {
  /** 定稿文件（相对项目根，必须位于 知识层/ 内） */
  target: string
  /** 账本出处（缺省语料回归域） */
  source?: string
  /** source_ref：账本定位（如 test/corpus/checks/body-parts.json） */
  sourceRef?: string
  license?: string
  category?: KnowledgeManifestEntry['category']
  note?: string
  /** 生成时刻（测试注入确定性用；缺省当前时间，ISO 带 +08:00 口径与现文件一致） */
  now?: string
}

/**
 * 登记定稿文件进 manifest：append 单条 entry + generated_at 更新 + 全量重写。
 * 拒绝：target 已在 manifest（重复登记）/ target 不在 知识层/ 内（路径安全）/
 * manifest 读取失败 / 定稿文件不在盘。返回登记后的对账结果（caller 应要求 ok）。
 */
export function commitKnowledgeFile(projectRoot: string, opts: CommitKnowledgeOpts): KnowledgeManifestReport {
  const read = readKnowledgeManifest(projectRoot)
  if (!read.ok || read.manifest === undefined) return read
  const manifest: KnowledgeManifest = read.manifest

  if (!opts.target.startsWith(KNOWLEDGE_DIR + '/')) {
    return { ok: false, issues: [{ path: opts.target, message: `target 必须位于 ${KNOWLEDGE_DIR}/ 内` }] }
  }
  if (manifest.entries.some((e) => e.target === opts.target)) {
    return { ok: false, issues: [{ path: opts.target, message: 'target 已在 manifest 中（不得重复登记）' }] }
  }
  const filePath = join(projectRoot, opts.target)
  if (!existsSync(filePath)) {
    return { ok: false, issues: [{ path: opts.target, message: '定稿文件不存在' }] }
  }

  const source = opts.source ?? '语料回归域'
  const license = opts.license ?? '内部'
  // front matter 一致性：validateMarkdownMetadata 要求 md 顶层 fm 的 source/license 与
  // manifest 一致——commit 时自动注入/改写这两键（其余 fm 键与正文原样保留），随登记
  // 一体落盘，两边由构造一致；sha256 在注入后实算
  injectFrontMatterKeys(filePath, { source, license })

  const entry: KnowledgeManifestEntry = {
    target: opts.target,
    source,
    ...(opts.sourceRef ? { source_ref: opts.sourceRef } : {}),
    license,
    sha256: hashFileSha256(filePath),
    category: opts.category ?? '方法论',
    ...(opts.note ? { note: opts.note } : {}),
  }
  manifest.entries = [...manifest.entries, entry]
  manifest.generated_at = opts.now ?? new Date(Date.now() + 8 * 3600_000).toISOString().replace('Z', '+08:00')

  writeFileSync(join(projectRoot, KNOWLEDGE_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return validateKnowledgeManifest(projectRoot)
}

/** md 顶层 front matter 注入/改写标量键（值原样写行尾；无 fm 则新建块；既有其余键与正文不动） */
function injectFrontMatterKeys(filePath: string, keys: Record<string, string>): void {
  const text = readFileSync(filePath, 'utf8')
  const split = splitFrontMatter(text)
  if (!split) {
    const fm = ['---', ...Object.entries(keys).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n')
    writeFileSync(filePath, fm + '\n' + text, 'utf8')
    return
  }
  const kept = split.fmRaw.split('\n').filter((raw) => {
    const t = raw.trim()
    return !Object.keys(keys).some((k) => t.startsWith(`${k}:`))
  })
  const fm = ['---', ...kept, ...Object.entries(keys).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n')
  writeFileSync(filePath, fm + '\n' + split.body, 'utf8')
}
