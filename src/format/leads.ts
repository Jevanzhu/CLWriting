/**
 * 账本六类容错读写 —— 依据 #3 账本格式 spec。
 *
 * 文件组织（#3 第 2 节）：大纲/{六类}/<编号>-<标题>.md
 * 格式：平铺 front matter（通用字段 + 各类特化） + 履历段（markdown 列表）
 *
 * 容错（#3 第 8 节）：未知字段保留、回写不重排、坏文件返回结构化错误不崩。
 */

import { readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
// R34D-2（三十四轮）：履历畸形行抢救失败时的 log.warn 留痕（对齐 lead-updates R26-32 手法）
import { log } from '../log/index.js'
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

/** 账本六类的中文目录名（#3 第 2 节；伏笔已独立为设定伏笔系统） */
export const LEAD_TYPES: readonly LeadType[] = [
  '悬念',
  '感情线',
  '布局线',
  '设定线',
  '成长线',
  '关系线',
] as const

/** #3 第 5 节动词表：每类合法动词（机检用，M2）。
 *  open 开端 → advance 进行中推进（不收尾）→ resolve 收尾 / drop 放弃。
 *  advance 语义：线仍在「进行中」，仅推进不闭合（悬疑递进/成长稳进等），
 *  不触发状态闭合校验（只有 resolve/drop 才要求状态翻转）。 */
export interface LeadVerbSet {
  open: string[]
  advance: string[]
  resolve: string[]
  drop: string[]
}

export const LEAD_VERBS: Record<LeadType, LeadVerbSet> = {
  悬念: { open: ['设下'], advance: ['递进'], resolve: ['揭晓'], drop: ['放弃'] },
  感情线: { open: ['开启'], advance: ['推进'], resolve: ['修成'], drop: ['无疾'] },
  布局线: { open: ['布局'], advance: ['推进'], resolve: ['收网'], drop: ['被破'] },
  设定线: { open: ['树立'], advance: ['推进'], resolve: ['固化'], drop: ['倾覆'] },
  成长线: { open: ['起步'], advance: ['稳进', '实战', '磨砺'], resolve: ['突破', '跨层', '跃迁'], drop: ['瓶颈'] },
  关系线: { open: ['结下'], advance: ['推进'], resolve: ['清算'], drop: ['化解'] },
}

// ── 履历段解析（#3 第 4 节）──────────────────────

/** 履历条目行：- 第012章 埋下：证据...（全角/半角冒号均接受，防输入法切错致履历行被丢）。
 *  R75-2（二十三轮）抽出单一出处——parseHistory 条目匹配与节界判定的条目前瞻共用，
 *  防两处正则漂移（漂移则分组标题误判节终、条目落 after 段致模型失明）。
 *  R34D-2（三十四轮）：证据段 `(.+)` → `(.*)` 收编空证据行（`- 第012章 埋下：`）——
 *  此前整行不匹配落续行折入分支，声明蒸发 + 上一条证据被污染；空证据条目照常入模型，
 *  R76-19 的空证据黄项既有路径即可见。 */
const HISTORY_ENTRY_RE = /^\s*-\s*第(\d+)章\s+(.+?)[：:](.*)$/

/** R34D-2（三十四轮）：形似条目但 HISTORY_ENTRY_RE 解析失败时的二次抢救正则——
 *  容忍章号后缺空格（`\s*`）、全角数字章号（０-９，配 normalizeDigits 归一）、
 *  动词与冒号间空格，证据段可空。仅用于 parseHistory 守卫分支的独立条目抢救，
 *  主路径仍走严格正则（两正则不互为出处，抢救条目回写物化为规范形态后由主正则接管）。 */
const HISTORY_ENTRY_LOOSE_RE = /^\s*-\s*第([０-９\d]+)章\s*([^\s:：]+)\s*[：:](.*)$/

/** R34D-2（三十四轮）：全角数字 → 半角（防输入法切错致章号进不了账本模型）。 */
function normalizeDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
}

/** ATX 标题行（#~###### 后随空白；markdown 标准形态）。 */
export const ATX_HEADING_RE = /^#{1,6}\s/

/** R75-2（二十三轮）：lines[headingIdx] 是标题行时判定「节终 or 分组」——其后到下一
 *  标题/文末仍出现条目行 → 分组标题（false：跳过不折入，条目照常解析）；否则为节终
 *  标题（true：终断条目段，其后人工内容归 after 段保真回写）。isEntry 由调用方注入
 *  （履历条目与账本推进声明条目格式不同，共用同一分组判定口径防两侧漂移）。 */
export function headingEndsSection(
  lines: string[],
  headingIdx: number,
  isEntry: (line: string) => boolean,
): boolean {
  // R76-21（二十四轮 B 域）：连续标题链不再提前终断——原「下一行是标题即判节终」把
  // `## 分组`+`### 详注`+条目 的链式分组首标题误判节终，其下条目整体掉出解析（回写
  // 保真无数据丢失，机检对它们失明）。标题行改为跳过继续找条目：链下仍出现条目 =
  // 整链是分组结构（false，条目照常解析）；到文末无条目 = 节终（其后人工内容归
  // after 段保真回写）。非标题非条目的普通行维持原「跳过继续」语义不变。
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (ATX_HEADING_RE.test(lines[i]!.trim())) continue
    if (isEntry(lines[i]!)) return false
  }
  return true
}

/**
 * 解析履历段（markdown 列表，每行：- 第N章 动词：章内证据）。
 * body 是 front matter 之后的正文，含 `## 履历` 标题。
 */
export function parseHistory(body: string): LeadEntry[] {
  const entries: LeadEntry[] = []
  // R36-1（三十六轮）：CRLF 行尾归一——HISTORY_ENTRY_RE / LOOSE_RE 对原始行 `$` 锚定
  // 匹配且无 m 标志，`\r` 前不认行尾 → CRLF 账本的履历条目全量落「形似条目」分支被
  // log.warn 丢弃，随后定稿回写 writeLead 按 stringifyHistory 整文件重序列化 → 既有
  // 全部履历物理清空、不可恢复（防吃书账本整体失真）。此处仅剥每行行尾单个 `\r`
  // （endsWith 守卫，不动条目内容侧空格，stringifyHistory 往返语义不变）；heading
  // 判节前瞻（headingEndsSection 的 isEntry）共用本数组，同一条防线覆盖。
  const lines = body.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  let inHistory = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const t = line.trim()
    // 进入履历段（段内重复出现沿用旧口径按无操作处理）
    if (/^##\s*履历/.test(t)) {
      inHistory = true
      continue
    }
    if (!inHistory) continue

    // R75-2（二十三轮）：条目段的 ATX 标题不再折入上一条证据——此前 `### 手记` 等
    // 标题行被 R64-17 续行折空格拼进证据（证据 needle 派生自标题碎片、命中正文必败
    // →「声明了没兑现」定稿假红；且定稿回写 dedup 按 章号+动词+证据 精确比对永不相
    // 等 → 重复条目追加固化）。节终标题（后无条目）终断条目段——其后内容由
    // bodyAfterHistory 保真回写；分组标题（后随条目）跳过。# 一级/### 三级此前不触发
    // `## ` 终断、一律折入证据，同本修收口。
    if (ATX_HEADING_RE.test(t)) {
      if (headingEndsSection(lines, i, (l) => HISTORY_ENTRY_RE.test(l))) break
      continue
    }

    // 匹配：- 第012章 埋下：证据...（可能含 回填 标记）
    const m = line.match(HISTORY_ENTRY_RE)
    if (m) {
      const 章号 = Number(m[1])
      const 动词 = m[2]!.trim()
      let 证据 = m[3]!.trim()
      let 回填 = false
      // 回填标记（#3 第 4 节）：证据末尾的（回填·卷摘要级）
      const bf = 证据.match(/（回填[^）]*）$/)
      if (bf) {
        回填 = true
        证据 = 证据.slice(0, bf.index).trim()
      }
      entries.push({ 章号, 动词, 证据, ...(回填 ? { 回填 } : {}) })
    } else if (/^\s*-\s*第/.test(line)) {
      // R34D-2（三十四轮）：形似履历条目（`- 第…` 开头）却未被条目正则解析的畸形行
      // 不折入上一条证据——此前落 R64-17 续行分支被折空格拼进上一条（空证据行整条
      // 声明蒸发 + 上一条证据被污染，下次 stringifyHistory 回写把改写后的证据物化，
      // 账本静默损坏）。缺空格/全角数字形态经 HISTORY_ENTRY_LOOSE_RE 二次抢救为
      // 独立条目（声明不蒸发、机检可见、回写物化为规范形态，既有条目不被改写）；
      // 抢救失败 log.warn 留痕后丢弃（对齐 lead-updates R26-32 手法）。
      const loose = line.match(HISTORY_ENTRY_LOOSE_RE)
      if (loose) {
        entries.push({
          章号: Number(normalizeDigits(loose[1]!)),
          动词: loose[2]!.trim(),
          证据: loose[3]!.trim(),
        })
      } else {
        log.warn('leads', `履历条目格式不符被丢弃（应为「- 第N章 动词：证据」）：${t.slice(0, 40)}`)
      }
    } else if (entries.length > 0 && t !== '') {
      // R64-17（十二轮）：多行证据续行——手写/编辑器折行的证据第二行不匹配条目正则，
      // 此前被静默丢弃（下次回写物理丢失）。续行折空格并入上一条证据（换行归一）。
      // R75-2：标题行已在上方分流（分组跳过/节终终断），到达此处的必为普通续行文本。
      const prev = entries[entries.length - 1]!
      prev.证据 = `${prev.证据} ${t}`.trim()
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

function bodyBeforeHistory(body: string): string {
  const lines = body.split('\n')
  const idx = lines.findIndex((line) => /^##\s*履历/.test(line.trim()))
  if (idx === -1) return body.trim()
  return lines.slice(0, idx).join('\n').trim()
}

/** 履历段之后的人工正文（节终标题起到文末；无则空）——dd-P2 回写保真用。
 *  R75-2（二十三轮）：节终判定与 parseHistory 共用 headingEndsSection——此前仅认
 *  `## ` 二级标题，`### 手记` 等子标题不终断，其后续写内容被 parseHistory 折进证据；
 *  现两处同口径，节终标题起的内容原样保真、不再触碰条目数据。 */
function bodyAfterHistory(body: string): string {
  const lines = body.split('\n')
  let inHistory = false
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim()
    if (!inHistory) {
      if (/^##\s*履历/.test(t)) inHistory = true
      continue
    }
    if (/^##\s*履历/.test(t)) continue
    if (ATX_HEADING_RE.test(t) && headingEndsSection(lines, i, (l) => HISTORY_ENTRY_RE.test(l))) {
      return lines.slice(i).join('\n').trim()
    }
  }
  return ''
}

// ── 单个账本条目读写 ────────────────────────────

/** 已知 front matter 字段（用于区分已知 vs 未知/容错保留） */
const KNOWN_FM_KEYS = new Set([
  '编号', '标题', '类型', '状态', '开启章',
  '境界体系', '当前境界', '父布局线', '欠方', '债主',
])

/** 读取一个账本 md → Lead 内存模型（容错） */
export function readLead(
  filePath: string,
  opts?: { legacy?: boolean },
): { ok: true; lead: Lead } | { ok: false; error: ParseError } {
  const r = readFile(filePath)
  if (!r.ok) return r

  const map = parseFlat(r.fmRaw)

  // 必填校验（#3 第 3 节）
  const 编号 = map.get('编号')
  if (typeof 编号 !== 'string' || !编号) {
    return { ok: false, error: { file: filePath, line: 0, message: '缺少必填字段：编号' } }
  }

  // R73-22（二十一轮）：类型/状态写了非法值不再静默默认——此前错别字类型（如「选念」）
  // 落默认「悬念」、错状态落「进行中」，机检动词表按错类执行（动词越界黄项+状态闭合
  // 误判），作者还以为配置生效。缺字段维持默认回落（存量手写账本兼容）；写了但非法 =
  // 结构化错误（readLeadDir 容错收集、重建面板可见），fail-loud 不入库错类。
  // opts.legacy：账本伏笔迁移读旧 scheme（大纲/伏笔/，类型「伏笔」本就非法于六类），
  // 严格校验会让存量旧档全部 skip 拒迁（数据滞留旧目录）——迁移侧按旧规则容错解析。
  if (opts?.legacy !== true) {
    const rawType = map.get('类型')
    if (rawType !== undefined && rawType !== null && String(rawType) !== '' && !(LEAD_TYPES as readonly string[]).includes(String(rawType))) {
      return {
        ok: false,
        error: { file: filePath, line: 0, message: `「类型」非法：「${String(rawType)}」（合法值：${LEAD_TYPES.join('/')}）` },
      }
    }
    const rawStatus = map.get('状态')
    if (rawStatus !== undefined && rawStatus !== null && String(rawStatus) !== '' && !['进行中', '已收尾', '已放弃'].includes(String(rawStatus))) {
      return {
        ok: false,
        error: { file: filePath, line: 0, message: `「状态」非法：「${String(rawStatus)}」（合法值：进行中/已收尾/已放弃）` },
      }
    }
  }

  // 收集未知字段（容错保留）
  // R64-17（十二轮）：数组型未知字段此前 String(v) 落成 "a,b" ——回写 stringifyValue
  // 按标量引号化，往返后项内逗号错位。数组原样保留（writeLead 的 stringifyValue
  // 原生支持数组逐项序列化）。
  const _raw: Record<string, string | string[]> = {}
  for (const [k, v] of map) {
    if (!KNOWN_FM_KEYS.has(k)) {
      _raw[k] = Array.isArray(v) ? v : String(v)
    }
  }

  // R75-2（二十三轮）：Number() 无守卫——手写「十二」→ NaN 落模型，机检章号区间
  // 比较恒 false（「未来章」误判族）、回写 NaN 扩散。对齐 chapters.ts R64-19 口径：
  // 非有限数按「未写」处理，回落默认 0（缺字段/空串语义不变）。
  const 开启章Num = Number(map.get('开启章'))

  const lead: Lead = {
    编号,
    标题: String(map.get('标题') ?? ''),
    类型: (map.get('类型') as LeadType) ?? '悬念',
    状态: (map.get('状态') as Lead['状态']) ?? '进行中',
    开启章: Number.isFinite(开启章Num) ? 开启章Num : 0,
    履历: parseHistory(r.body),
    _bodyBeforeHistory: bodyBeforeHistory(r.body),
    _bodyAfterHistory: bodyAfterHistory(r.body),
    ...(Object.keys(_raw).length > 0 ? { _raw } : {}),
    _fmOrder: [...map.keys()],
    _path: filePath,
  }

  // 特化字段（仅当存在时赋值）
  if (map.has('境界体系')) lead.境界体系 = String(map.get('境界体系'))
  if (map.has('当前境界')) lead.当前境界 = String(map.get('当前境界'))
  if (map.has('父布局线')) lead.父布局线 = String(map.get('父布局线'))
  if (map.has('欠方')) lead.欠方 = String(map.get('欠方'))
  if (map.has('债主')) lead.债主 = String(map.get('债主'))

  return { ok: true, lead }
}

/** Lead 内存模型 → front matter Map（按源 md 原始字段顺序回写，#3 第 8 节"不重排"） */
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
  if (lead.父布局线 !== undefined) knownVal['父布局线'] = lead.父布局线
  if (lead.欠方 !== undefined) knownVal['欠方'] = lead.欠方
  if (lead.债主 !== undefined) knownVal['债主'] = lead.债主

  const emitted = new Set<string>()

  // #1 按源 md 原始顺序回写（保序，减少无谓 git diff）
  for (const key of lead._fmOrder ?? []) {
    if (Object.hasOwn(knownVal, key)) {
      map.set(key, knownVal[key])
      emitted.add(key)
    } else if (lead._raw && key in lead._raw) {
      map.set(key, lead._raw[key])
      emitted.add(key)
    }
  }

  // #2 原始顺序未覆盖的已知字段（内存新增）按 #3 第 3 节标准顺序追加
  for (const key of ['编号', '标题', '类型', '状态', '开启章', '境界体系', '当前境界', '父布局线', '欠方', '债主']) {
    if (Object.hasOwn(knownVal, key) && !emitted.has(key)) {
      map.set(key, knownVal[key])
      emitted.add(key)
    }
  }

  // #3 未知字段（_raw 中原始顺序未列的）追加末尾
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
  const preserved = lead._bodyBeforeHistory?.trim()
  // dd-P2：履历段后的人工正文（备注/关联线索）一并保留——此前任意一次账本回写
  // 都会把作者手写在 ## 履历 之后的内容静默删掉
  const after = lead._bodyAfterHistory?.trim()
  const parts = [...(preserved ? [preserved] : []), historyText, ...(after ? [after] : [])]
  const body = `\n${parts.join('\n\n')}\n`
  // ee-P1-6：账本是防吃书根基，写入与 manifest/version/journal 同级 fsync——tmp+rename
  // 防半截文件，但不防掉电时 rename 元数据先于内容持久化（账本整体回退旧状态的窗口）
  writeFile(filePath, fmText, body, { fsync: true })
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
    // R34D-11（三十四轮）：扩展名匹配大小写不敏感（win 手工改名 .MD 不再对账本扫描隐形）；
    // slice(-3) 只对小尾串做一次 toLowerCase，免全名分配
    files = readdirSync(dirPath).filter((f) => f.slice(-3).toLowerCase() === '.md' && !f.startsWith('._'))
  } catch {
    // 目录不存在（未启用的扩展类）→ 空结果，不报错（母本第 2.1 节）
    return { leads, errors }
  }

  for (const f of files) {
    const fp = join(dirPath, f)
    // dd-P3：readdir 与 stat 之间文件可能被删——单文件失败跳过（与「单文件解析失败不中断」契约一致），此前裸 ENOENT 会中断整扫描
    let isFile = false
    try {
      isFile = statSync(fp).isFile()
    } catch {
      continue
    }
    if (!isFile) continue
    const parsedName = parseLeadFileName(f)
    if (parsedName === null) {
      errors.push({ file: fp, line: 0, message: '账本文件名必须是 <编号>-<标题>.md，如 悬念-031-灭门真凶.md' })
      continue
    }
    const r = readLead(fp)
    if (r.ok) {
      if (r.lead.编号 !== parsedName.编号) {
        errors.push({ file: fp, line: 0, message: `账本文件名编号「${parsedName.编号}」与 front matter 编号「${r.lead.编号}」不一致` })
        continue
      }
      leads.push(r.lead)
    } else {
      errors.push(r.error)
    }
  }
  return { leads, errors }
}

/** 从文件名提取编号（#3 第 2 节：<编号>-<标题>.md） */
export function parseLeadFileName(fileName: string): { 编号: string; 标题: string } | null {
  const base = basename(fileName, '.md')
  // 编号格式：类型-三位序号（如 悬念-031），标题在编号之后
  const m = base.match(/^(.+?-\d{3})-(.+)$/)
  if (!m) return null
  return { 编号: m[1]!, 标题: m[2]! }
}
