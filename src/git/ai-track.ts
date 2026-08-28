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
 * X-P2-3 双后端：v3 新书无 git（不再 init）——git 路径全静默丢轨迹。无 .git 的书库
 * 落 工作区/.版本/<docId>/<ULID>.md（origin 'ai'，与编辑快照同档案分层保留）。
 * git 书库仍走 ref（含内容寻址去重），两种后端按 .git 存在与 sha 形态分发。
 *
 * 红线：只写 ref/版本档案不碰正文——rewrite 接入不违反「AI 永不落盘正文」。
 * 注意：git clone 不带自定义 ref，备份迁移须显式带 refs/clwriting/*（见文风方案风险表）。
 * 失败一律返回 null/空——轨迹是旁路证据，绝不阻断落盘主流程。
 */

import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './exec.js'
import { ulid } from '../document/stable-id.js'
import {
  writeVersion,
  listVersions,
  readVersion,
  readVersionMeta, // R62-36：meta-only 读（不加载正文）
  VERSIONS_DIR_NAME,
  decodeDocDirName, // R68-4：版本目录名反解（win 编码收口配套）
} from '../document/version.js'

const REF_ROOT = 'refs/clwriting/ai'

/** AI 版轨迹项（列出用） */
export interface AiVersion {
  ref: string
  ulid: string // 时间序即版本序（含 48bit 毫秒时间戳）
  sha: string
}

/** git 后端可用（书库根有 .git） */
function hasGitBackend(bookRoot: string): boolean {
  return existsSync(join(bookRoot, '.git'))
}

/** 版本档案目录（X-P2-3 无 git 书库的后端） */
function versionsDir(bookRoot: string): string {
  return join(bookRoot, '工作区', VERSIONS_DIR_NAME)
}

/** ULID 形态（版本档案后端的 id / git 后端是 hex sha） */
function isUlid(s: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s)
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

/** R65-28（第六十五轮）：meta 读单次调用内去重缓存——listTrackedDocs 扫 工作区/.版本/
 *  逐 doc 逐版 readVersionMeta 的头读盘经此缓存收敛（同一 (dir, docId, versionId)
 *  单次调用内只读一次）；缓存值即 readVersionMeta 原样返回值，结果与逐版直读恒等。 */
type VersionMetaCache = Map<string, ReturnType<typeof readVersionMeta>>

/** 列全书有轨迹的 docId（候选收割遍历用；无轨迹 → 空） */
export function listTrackedDocs(bookRoot: string): string[] {
  if (hasGitBackend(bookRoot)) {
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
  // X-P2-3 版本档案后端：扫 工作区/.版本/ 下含 origin 'ai' 版本的 docId 目录
  const dir = versionsDir(bookRoot)
  if (!existsSync(dir)) return []
  // R68-4：目录名反解回真实 docId——写侧恒编码（win legacy 冒号防线），原始目录名
  //（legacy_abc）与真实 id（legacy:abc）永不相等，文风收割对 legacy 文档静默失明。
  // Set 去重：同一 docId 的字面/编码目录并存（mac 存量+新写）时双目录各扫一遍。
  const out = new Set<string>()
  const metaCache: VersionMetaCache = new Map() // R65-28：单次调用内去重
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._')) continue
    if (listAiVersions(bookRoot, name, metaCache).length > 0) out.add(decodeDocDirName(name))
  }
  return [...out]
}

/**
 * 记录一版 AI 文本：hash-object 写 blob → update-ref 挂旁路 ref；
 * 无 git 书库 → 落 工作区/.版本（origin 'ai'，与编辑快照同档案同保留策略）。
 * @returns ref 全名 / 版本 id；失败 → null（不阻断调用方）
 */
export function recordAiVersion(bookRoot: string, docId: string, content: string): string | null {
  if (!content.trim()) return null
  if (!hasGitBackend(bookRoot)) {
    try {
      return writeVersion(versionsDir(bookRoot), docId, content, { origin: 'ai' })
    } catch {
      return null
    }
  }
  const hashR = git(['hash-object', '-w', '--stdin'], bookRoot, { input: content })
  if (!hashR.ok) return null
  const sha = hashR.stdout.trim()
  if (!sha) return null
  const ref = `${REF_ROOT}/${encodeRefSegment(docId)}/${ulid()}`
  const updR = git(['update-ref', ref, sha], bookRoot)
  return updR.ok ? ref : null
}

/** 列某文档全部 AI 版（ulid 升序 = 时间序，末位最新；无轨迹 → 空）。
 *  R65-28：可选 metaCache——收割链（listTrackedDocs → 逐 doc 调用）同一 (dir,
 *  docId, versionId) 的头读盘去重，结果与无缓存恒等。 */
export function listAiVersions(bookRoot: string, docId: string, metaCache?: VersionMetaCache): AiVersion[] {
  if (hasGitBackend(bookRoot)) {
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
  // X-P2-3 版本档案后端：listVersions 新在前 → 反转为升序（与 git 路径口径一致，末位最新）
  const dir = versionsDir(bookRoot)
  const out: AiVersion[] = []
  for (const v of listVersions(dir, docId)) {
    // R62-36：只读头部 front matter 判 origin——不整读正文（此前每版全量读盘两遍大海捞针）
    // R65-28：meta 读经单次调用内去重缓存（命中免重复头读盘）
    const cacheKey = `${dir}\u0000${docId}\u0000${v.id}`
    let read: ReturnType<typeof readVersionMeta>
    if (metaCache?.has(cacheKey)) {
      read = metaCache.get(cacheKey)!
    } else {
      read = readVersionMeta(dir, docId, v.id)
      metaCache?.set(cacheKey, read)
    }
    if (!read || read.meta.origin !== 'ai') continue
    out.push({ ref: v.path, ulid: v.id, sha: v.id })
  }
  return out.reverse()
}

/**
 * 读某版内容。X-P2-3 起 sha 有两种形态：hex → git blob；ULID → 版本档案（需 docId 定位）。
 * 失败 null。
 */
export function readAiVersion(bookRoot: string, docId: string, sha: string): string | null {
  if (isUlid(sha)) {
    const read = readVersion(versionsDir(bookRoot), docId, sha)
    return read ? read.content : null
  }
  const r = git(['cat-file', '-p', sha], bookRoot)
  return r.ok ? r.stdout : null
}

/**
 * 删某文档全部轨迹（作者知情权：轨迹可查可删）。
 * @returns 删掉的版本数
 */
export function deleteAiVersions(bookRoot: string, docId: string): number {
  const versions = listAiVersions(bookRoot, docId)
  let deleted = 0
  if (hasGitBackend(bookRoot)) {
    for (const v of versions) {
      if (git(['update-ref', '-d', v.ref], bookRoot).ok) deleted++
    }
    return deleted
  }
  for (const v of versions) {
    try {
      unlinkSync(v.ref)
      deleted++
    } catch {
      /* 已删无妨 */
    }
  }
  return deleted
}
