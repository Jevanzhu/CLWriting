/**
 * 账本七类容错读写 —— 依据 ③ 账本格式 spec。
 *
 * 文件组织（③ 第 2 节）：大纲/{七类}/<编号>-<标题>.md
 * 格式：平铺 front matter（通用字段 + 各类特化） + 履历段（markdown 列表）
 *
 * 容错（③ 第 8 节）：未知字段保留、回写不重排、坏文件返回结构化错误不崩。
 */

import { readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import {
  readFile,
  writeFile,
  parseFlat,
  stringifyFlat,
} from './frontmatter.js'
import type {
  Lead,
  LeadEntry,
  LeadType,
  ParseError,
} from './types.js'

/** 账本七类的中文目录名（③ 第 2 节） */
export const LEAD_TYPES: readonly LeadType[] = [
  '伏笔',
  '悬念',
  '感情线',
  '局线',
  '设定线',
  '成长线',
  '关系债',
] as const

/** ③ 第 5 节动词表：每类的合法动词（机检用，M2） */
export const LEAD_VERBS: Record<LeadType, { open: string[]; resolve: string[]; drop: string[] }> = {
  伏笔: { open: ['埋下'], resolve: ['回收'], drop: ['放弃'] },
  悬念: { open: ['设下'], resolve: ['揭晓'], drop: ['放弃'] },
  感情线: { open: ['开启'], resolve: ['修成'], drop: ['无疾'] },
  局线: { open: ['布局'], resolve: ['收网'], drop: ['被破'] },
  设定线: { open: ['树立'], resolve: ['固化'], drop: ['倾覆'] },
  成长线: { open: ['起步'], resolve: ['突破'], drop: ['瓶颈'] },
  关系债: { open: ['结下'], resolve: ['清算'], drop: ['化解'] },
}

// ── 履历段解析（③ 第 4 节）──────────────────────

/**
 * 解析履历段（markdown 列表，每行：- 第N章 动词：章内证据）。
 * body 是 front matter 之后的正文，含 `## 履历` 标题。
 */
export function parseHistory(body: string): LeadEntry[] {
  const entries: LeadEntry[] = []
  const lines = body.split('\n')
  let inHistory = false

  for (const line of lines) {
    // 进入履历段
    if (/^##\s*履历/.test(line.trim())) {
      inHistory = true
      continue
    }
    // 遇到下一个 ## 标题则结束
    if (inHistory && /^##\s/.test(line.trim()) && !/^##\s*履历/.test(line.trim())) {
      break
    }
    if (!inHistory) continue

    // 匹配：- 第012章 埋下：证据...（可能含 回填 标记）
    const m = line.match(/^\s*-\s*第(\d+)章\s+(.+?)：(.+)$/)
    if (m) {
      const 章号 = Number(m[1])
      const 动词 = m[2]!.trim()
      let 证据 = m[3]!.trim()
      let 回填 = false
      // 回填标记（③ 第 4 节）：证据末尾的（回填·卷摘要级）
      const bf = 证据.match(/（回填[^）]*）$/)
      if (bf) {
        回填 = true
        证据 = 证据.slice(0, bf.index).trim()
      }
      entries.push({ 章号, 动词, 证据, ...(回填 ? { 回填 } : {}) })
    }
  }
  return entries
}

/** 履历段 → markdown 文本 */
export function stringifyHistory(entries: LeadEntry[]): string {
  const lines: string[] = ['## 履历', '']
  for (const e of entries) {
    const suffix = e.回填 ? '（回填·卷摘要级）' : ''
    lines.push(`- 第${String(e.章号).padStart(3, '0')}章 ${e.动词}：${e.证据}${suffix}`)
  }
  return lines.join('\n')
}

// ── 单个账本条目读写 ────────────────────────────

/** 已知 front matter 字段（用于区分已知 vs 未知/容错保留） */
const KNOWN_FM_KEYS = new Set([
  '编号', '标题', '类型', '状态', '开启章',
  '境界体系', '当前境界', '父局线', '欠方', '债主',
])

/** 读取一个账本 md → Lead 内存模型（容错） */
export function readLead(
  filePath: string,
): { ok: true; lead: Lead } | { ok: false; error: ParseError } {
  const r = readFile(filePath)
  if (!r.ok) return r

  const map = parseFlat(r.fmRaw)

  // 必填校验（③ 第 3 节）
  const 编号 = map.get('编号')
  if (typeof 编号 !== 'string' || !编号) {
    return { ok: false, error: { file: filePath, line: 0, message: '缺少必填字段：编号' } }
  }

  // 收集未知字段（容错保留）
  const _raw: Record<string, string> = {}
  for (const [k, v] of map) {
    if (!KNOWN_FM_KEYS.has(k)) {
      _raw[k] = String(v)
    }
  }

  const lead: Lead = {
    编号,
    标题: String(map.get('标题') ?? ''),
    类型: (map.get('类型') as LeadType) ?? '伏笔',
    状态: (map.get('状态') as Lead['状态']) ?? '进行中',
    开启章: Number(map.get('开启章') ?? 0),
    履历: parseHistory(r.body),
    ...(Object.keys(_raw).length > 0 ? { _raw } : {}),
    _fmOrder: [...map.keys()],
    _path: filePath,
  }

  // 特化字段（仅当存在时赋值）
  if (map.has('境界体系')) lead.境界体系 = String(map.get('境界体系'))
  if (map.has('当前境界')) lead.当前境界 = String(map.get('当前境界'))
  if (map.has('父局线')) lead.父局线 = String(map.get('父局线'))
  if (map.has('欠方')) lead.欠方 = String(map.get('欠方'))
  if (map.has('债主')) lead.债主 = String(map.get('债主'))

  return { ok: true, lead }
}

/** Lead 内存模型 → front matter Map（按源 md 原始字段顺序回写，③ 第 8 节"不重排"） */
function leadToMap(lead: Lead): Map<string, unknown> {
  const map = new Map<string, unknown>()

  // 已知字段的当前值（按 key 取，含可能被更新的值）
  const knownVal: Record<string, unknown> = {
    编号: lead.编号,
    标题: lead.标题,
    类型: lead.类型,
    状态: lead.状态,
    开启章: lead.开启章,
  }
  if (lead.境界体系 !== undefined) knownVal['境界体系'] = lead.境界体系
  if (lead.当前境界 !== undefined) knownVal['当前境界'] = lead.当前境界
  if (lead.父局线 !== undefined) knownVal['父局线'] = lead.父局线
  if (lead.欠方 !== undefined) knownVal['欠方'] = lead.欠方
  if (lead.债主 !== undefined) knownVal['债主'] = lead.债主

  const emitted = new Set<string>()

  // ① 按源 md 原始顺序回写（保序，减少无谓 git diff）
  for (const key of lead._fmOrder ?? []) {
    if (key in knownVal) {
      map.set(key, knownVal[key])
      emitted.add(key)
    } else if (lead._raw && key in lead._raw) {
      map.set(key, lead._raw[key])
      emitted.add(key)
    }
  }

  // ② 原始顺序未覆盖的已知字段（内存新增）按 ③ 第 3 节标准顺序追加
  for (const key of ['编号', '标题', '类型', '状态', '开启章', '境界体系', '当前境界', '父局线', '欠方', '债主']) {
    if (key in knownVal && !emitted.has(key)) {
      map.set(key, knownVal[key])
      emitted.add(key)
    }
  }

  // ③ 未知字段（_raw 中原始顺序未列的）追加末尾
  if (lead._raw) {
    for (const [k, v] of Object.entries(lead._raw)) {
      if (!emitted.has(k)) {
        map.set(k, v)
        emitted.add(k)
      }
    }
  }

  return map
}

/** 写入账本 md（front matter + 履历段） */
export function writeLead(filePath: string, lead: Lead): void {
  const fmText = stringifyFlat(leadToMap(lead))
  const historyText = stringifyHistory(lead.履历)
  writeFile(filePath, fmText, '\n' + historyText + '\n')
}

// ── 目录扫描（重建器/精准读取用）────────────────

/**
 * 扫描某类账本目录，读取所有条目。
 * 容错：单个文件解析失败跳过、计入 errors，不中断整体扫描。
 */
export function readLeadDir(
  dirPath: string,
): { leads: Lead[]; errors: ParseError[] } {
  const leads: Lead[] = []
  const errors: ParseError[] = []

  let files: string[]
  try {
    files = readdirSync(dirPath).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
  } catch {
    // 目录不存在（未启用的扩展类）→ 空结果，不报错（母本第 2.1 节）
    return { leads, errors }
  }

  for (const f of files) {
    const fp = join(dirPath, f)
    if (!statSync(fp).isFile()) continue
    const r = readLead(fp)
    if (r.ok) {
      leads.push(r.lead)
    } else {
      errors.push(r.error)
    }
  }
  return { leads, errors }
}

/** 从文件名提取编号（③ 第 2 节：<编号>-<标题>.md） */
export function parseLeadFileName(fileName: string): { 编号: string; 标题: string } | null {
  const base = basename(fileName, '.md')
  // 编号格式：类型-三位序号（如 伏笔-031），标题在编号之后
  const m = base.match(/^(.+?-\d{3})-(.+)$/)
  if (!m) return null
  return { 编号: m[1]!, 标题: m[2]! }
}
