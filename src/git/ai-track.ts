/**
 * 改稿轨迹旁路 ref —— 文风系统重整 S2（AI 版落 git，不进历史）。
 *
 * AI 文本  →  refs/clwriting/ai/<docId>/<ulid>（blob ref）
 * 作者定稿 →  正常 commit（不变）
 *
 * 旁路 ref 不在任何分支上：不污染 ch: 链、不进 git log、reset --hard 天然免疫；
 * 内容寻址自动去重（AI 版与人版九成相同时 delta 压缩）。
 * rollback.ts 备份 ref（回收/回到N-*）同思路先例。
 *
 * 红线：只写 ref 不碰正文——rewrite 接入不违反「AI 永不落盘正文」。
 * 注意：git clone 不带自定义 ref，备份迁移须显式带 refs/clwriting/*（见文风方案风险表）。
 * 失败一律返回 null/空——轨迹是旁路证据，绝不阻断落盘主流程。
 */

import { git } from './exec.js'
import { ulid } from '../document/stable-id.js'

const REF_ROOT = 'refs/clwriting/ai'

/** AI 版轨迹项（列出用） */
export interface AiVersion {
  ref: string
  ulid: string // 时间序即版本序（含 48bit 毫秒时间戳）
  sha: string
}

/**
 * docId → ref 段（git ref 禁冒号等字符；legacy:<hex> → legacy-<hex>）。
 * docId 仅两种形态（doc_<ULID> / legacy:<16hex>），替换后无碰撞。
 */
export function encodeRefSegment(docId: string): string {
  return docId.replace(/[^A-Za-z0-9_-]/g, '-')
}

/**
 * ref 段 → docId 反解（legacy-<16hex> → legacy:<16hex>；其余原样）。
 * docId 仅两形态，doc_<ULID> 编码前后一致，可无损往返。
 */
export function decodeRefSegment(seg: string): string {
  const m = seg.match(/^legacy-([0-9a-f]{16})$/)
  return m ? `legacy:${m[1]}` : seg
}

/** 列全书有轨迹的 docId（候选收割遍历用；非 git 仓库 → 空） */
export function listTrackedDocs(bookRoot: string): string[] {
  const r = git(['for-each-ref', '--format=%(refname)', `${REF_ROOT}/`], bookRoot)
  if (!r.ok) return []
  const docIds = new Set<string>()
  for (const line of r.stdout.split('\n')) {
    const ref = line.trim()
    if (!ref.startsWith(`${REF_ROOT}/`)) continue
    const seg = ref.slice(REF_ROOT.length + 1).split('/')[0]
    if (seg) docIds.add(decodeRefSegment(seg))
  }
  return [...docIds]
}

/**
 * 记录一版 AI 文本：hash-object 写 blob → update-ref 挂旁路 ref。
 * @returns ref 全名；书不是 git 仓库或 git 失败 → null（不阻断调用方）
 */
export function recordAiVersion(bookRoot: string, docId: string, content: string): string | null {
  if (!content.trim()) return null
  const hashR = git(['hash-object', '-w', '--stdin'], bookRoot, { input: content })
  if (!hashR.ok) return null
  const sha = hashR.stdout.trim()
  if (!sha) return null
  const ref = `${REF_ROOT}/${encodeRefSegment(docId)}/${ulid()}`
  const updR = git(['update-ref', ref, sha], bookRoot)
  return updR.ok ? ref : null
}

/** 列某文档全部 AI 版（ulid 升序 = 时间序；无轨迹/非 git 仓库 → 空） */
export function listAiVersions(bookRoot: string, docId: string): AiVersion[] {
  const prefix = `${REF_ROOT}/${encodeRefSegment(docId)}/`
  const r = git(['for-each-ref', '--format=%(refname) %(objectname)', prefix], bookRoot)
  if (!r.ok) return []
  const out: AiVersion[] = []
  for (const line of r.stdout.split('\n')) {
    const [ref, sha] = line.trim().split(' ')
    if (!ref || !sha) continue
    out.push({ ref, ulid: ref.slice(prefix.length), sha })
  }
  out.sort((a, b) => (a.ulid < b.ulid ? -1 : 1))
  return out
}

/** 读某版内容（sha → blob 文本；失败 null） */
export function readAiVersion(bookRoot: string, sha: string): string | null {
  const r = git(['cat-file', '-p', sha], bookRoot)
  return r.ok ? r.stdout : null
}

/**
 * 删某文档全部轨迹（作者知情权：轨迹可查可删）。
 * @returns 删掉的 ref 数
 */
export function deleteAiVersions(bookRoot: string, docId: string): number {
  const versions = listAiVersions(bookRoot, docId)
  let deleted = 0
  for (const v of versions) {
    if (git(['update-ref', '-d', v.ref], bookRoot).ok) deleted++
  }
  return deleted
}
