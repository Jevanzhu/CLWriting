/**
 * 全书文风收割（文风系统重整 S6 编排）：零 AI token 的两源落候选。
 *
 * 源1 改稿轨迹：tracked doc 最新 AI 版 vs 当前正文 → 比对层信号 → 样章/禁词候选。
 * 源2 机检漂移：文风趋势 drifts → 固定映射表 → 手法候选。
 * 源3（AI 语义分析，耗 token）不在此处——analysis 流程完成时另行转换。
 *
 * 查重闸在 persistCandidates（已忽略的不再骚扰），本函数可重复调用。
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { buildTree, type TreeNode } from '../document/tree.js'
import { splitFrontMatter, parseFlat } from '../format/frontmatter.js'
import {
  listTrackedDocs,
  listAiVersions,
  readAiVersion,
  listAiVersionsAsync,
  readAiVersionAsync,
} from '../git/ai-track.js'
import {
  aggregateSignals,
  mapDriftsToCandidates,
  persistCandidates,
  type DocSignals,
} from '../format/style-candidate.js'
import { compareVersions } from '../format/style-compare.js'
import {
  scanChapters,
  aggregateStyleTrend,
  readBaseline,
} from '../metrics/style.js'

/** 样章候选最短段长（与 style-candidate 保持一致） */
const MIN_SAMPLE_PARA = 50

/**
 * 采一个文档的改稿信号：最新 AI 版 vs 当前正文（从 format/style-candidate 下沉到 process 层，
 * 消除 format→git 向上依赖）。
 * @returns 无轨迹 / 读不到 AI 版 → null（旁路证据，静默）
 */
export function collectDocSignals(
  bookRoot: string,
  docId: string,
  currentText: string,
  章号?: number,
): DocSignals | null {
  const versions = listAiVersions(bookRoot, docId)
  const last = versions[versions.length - 1]
  if (!last) return null
  const aiText = readAiVersion(bookRoot, docId, last.sha)
  if (aiText === null) return null
  const r = compareVersions(aiText, currentText)
  return {
    docId,
    ...(章号 !== undefined ? { 章号 } : {}),
    gapParas: r.paras
      .filter((p) => p.tier === 'gap' && p.authorPara.length >= MIN_SAMPLE_PARA)
      .map((p) => ({ authorPara: p.authorPara, aiPara: p.aiPara, sim: p.sim })),
    missing: r.missing,
  }
}

/**
 * collectDocSignals 的异步孪生（R37-5 延伸，三十七轮批 A 收口）：读侧走
 * listAiVersionsAsync/readAiVersionAsync（gitAsync spawn + 有界超时）——本函数
 * 挂在服务 HTTP 链（style.ts harvest 端点 → harvestStyleCandidatesAsync），同步
 * spawnSync 在 git 无响应时阻塞事件循环最长 15s。语义与同步版一致：旁路证据静默。
 */
export async function collectDocSignalsAsync(
  bookRoot: string,
  docId: string,
  currentText: string,
  章号?: number,
): Promise<DocSignals | null> {
  const versions = await listAiVersionsAsync(bookRoot, docId)
  const last = versions[versions.length - 1]
  if (!last) return null
  const aiText = await readAiVersionAsync(bookRoot, docId, last.sha)
  if (aiText === null) return null
  const r = compareVersions(aiText, currentText)
  return {
    docId,
    ...(章号 !== undefined ? { 章号 } : {}),
    gapParas: r.paras
      .filter((p) => p.tier === 'gap' && p.authorPara.length >= MIN_SAMPLE_PARA)
      .map((p) => ({ authorPara: p.authorPara, aiPara: p.aiPara, sim: p.sim })),
    missing: r.missing,
  }
}

/**
 * 收割一轮：源1 + 源2 → 候选箱。
 * @param kind 长短篇（调用方从 book 上下文取，process 层不读盘判定）
 * @param today YYYY-MM-DD（候选 创建 字段 + 过期计时起点）
 */
export function harvestStyleCandidates(
  bookRoot: string,
  kind: 'long' | 'short',
  today: string,
): { created: string[]; skipped: number } {
  const candidates = []

  // ── 源1 · 改稿轨迹（docId → 树反查路径；文档已删的悬空轨迹跳过）──
  const tracked = listTrackedDocs(bookRoot)
  if (tracked.length > 0) {
    const byDocId = new Map<string, string>()
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.docId) byDocId.set(n.docId, n.path)
        if (n.children.length > 0) walk(n.children)
      }
    }
    walk(buildTree(bookRoot))
    const signals: DocSignals[] = []
    for (const docId of tracked) {
      const rel = byDocId.get(docId)
      if (!rel) continue
      // 容错读：无 front matter 的文档整文件即正文（手写草稿常态）
      let raw: string
      try {
        raw = readFileSync(join(bookRoot, rel), 'utf-8')
      } catch {
        continue
      }
      const split = splitFrontMatter(raw)
      const body = split ? split.body : raw
      const chNum = split ? Number(parseFlat(split.fmRaw).get('章号')) : NaN
      const s = collectDocSignals(
        bookRoot,
        docId,
        body,
        Number.isInteger(chNum) && chNum > 0 ? chNum : undefined,
      )
      if (s) signals.push(s)
    }
    candidates.push(...aggregateSignals(signals, today))
  }

  // ── 源2 · 机检漂移（复用趋势聚合，与体检报告同源）──
  const samples = scanChapters(bookRoot)
  const trend = aggregateStyleTrend(samples, kind, readBaseline(bookRoot))
  candidates.push(...mapDriftsToCandidates(trend.drifts, today))

  return persistCandidates(bookRoot, candidates)
}

/**
 * harvestStyleCandidates 的异步孪生（R37-5 延伸，三十七轮批 A 收口）：源1 逐 doc
 * 的轨迹读走 collectDocSignalsAsync（gitAsync），HTTP 链不再同步 spawnSync。同步版
 * 保留供存量测试与等价性对照。
 */
export async function harvestStyleCandidatesAsync(
  bookRoot: string,
  kind: 'long' | 'short',
  today: string,
): Promise<{ created: string[]; skipped: number }> {
  const candidates = []

  // ── 源1 · 改稿轨迹（docId → 树反查路径；文档已删的悬空轨迹跳过）──
  const tracked = listTrackedDocs(bookRoot)
  if (tracked.length > 0) {
    const byDocId = new Map<string, string>()
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.docId) byDocId.set(n.docId, n.path)
        if (n.children.length > 0) walk(n.children)
      }
    }
    walk(buildTree(bookRoot))
    const signals: DocSignals[] = []
    for (const docId of tracked) {
      const rel = byDocId.get(docId)
      if (!rel) continue
      // 容错读：无 front matter 的文档整文件即正文（手写草稿常态）
      let raw: string
      try {
        raw = readFileSync(join(bookRoot, rel), 'utf-8')
      } catch {
        continue
      }
      const split = splitFrontMatter(raw)
      const body = split ? split.body : raw
      const chNum = split ? Number(parseFlat(split.fmRaw).get('章号')) : NaN
      const s = await collectDocSignalsAsync(
        bookRoot,
        docId,
        body,
        Number.isInteger(chNum) && chNum > 0 ? chNum : undefined,
      )
      if (s) signals.push(s)
    }
    candidates.push(...aggregateSignals(signals, today))
  }

  // ── 源2 · 机检漂移（复用趋势聚合，与体检报告同源）──
  const samples = scanChapters(bookRoot)
  const trend = aggregateStyleTrend(samples, kind, readBaseline(bookRoot))
  candidates.push(...mapDriftsToCandidates(trend.drifts, today))

  return persistCandidates(bookRoot, candidates)
}
