/**
 * 版本档案 version —— 统一编辑快照 + 定稿版本（去 git 版本系统）。
 *
 * 由 snapshot.ts 泛化而来：同一套「全文 + front matter 元信息」机制，
 * origin 区分来源（autosave 编辑快照 / finalize 定稿版本 / restore 恢复留底…）。
 *
 * 落点：工作区/.版本/<docId>/<ULID>.md（原 .snapshots 改名 .版本，首次启动自动迁移）。
 * id 即 ULID，含时间戳可排序。用 atomicWriteFile 整文件写（版本是独立文件，非追加日志）。
 *
 * pinned（永久保留）：finalize 写的定稿版本 pinned=true，prune 清理**跳过**——
 * 定稿里程碑不因分层保留/数量兜底被删，文章历史永久可回溯。
 *
 * 密度控制三件套（全文副本不做 diff 链——省下的空间换不来"恢复要重放、链断全废、
 * 文件不再是能直接打开的 markdown"）：
 * 1. 去重：与最新版本同内容 → 不落新文件
 * 2. 节流：同一文档窗口内只留一个（force 时跳过，如删除/改名前留底）
 * 3. 分层保留：写入后顺带 prune，越近越细越远越粗（pinned 跳过）
 */
import { existsSync, readdirSync, unlinkSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { atomicWriteFile, renameWithRetry } from '../fs/atomic.js'
import { safeDocId } from '../fs/safe-path.js'
import { ulid, decodeUlidTime } from './stable-id.js'
import { readFile, parseFlat, splitFrontMatter, stringifyValue } from '../format/frontmatter.js'
import { isMdFileName } from '../format/filename.js'
import type { Revision } from './revision.js'
import { log } from '../log/index.js'

/** 版本目录名（工作区/ 下，treeskip + 迁移用）。 */
export const VERSIONS_DIR_NAME = '.版本'
/** 旧快照目录名（迁移源）。 */
export const LEGACY_SNAPSHOTS_DIR_NAME = '.snapshots'

/**
 * docId → 版本子目录名的跨平台映射（win 适配 F4 缺陷修复，2026-08-27）。
 * stable-id 的 legacy 方案含 `:`（`legacy:<sha256 前 16 位>`），是 Windows 目录名
 * 非法字符——写入端统一编码（`:`→`_`）。两 id 仅差 `:` 与 `_` 才可能碰撞，id 空间
 * （hex/doc_ 前缀）实践中不存在；新写入恒编码保证 win 可建，mac 对无冒号目录名不受影响。
 */
export function encodeDocDirName(docId: string): string {
  return docId.replace(/:/g, '_')
}

/**
 * R68-3/R68-4：docId 编码文件/目录名的反解（journal 文件名、分析文件名、版本目录名
 * 的读侧统一入口）。id 空间三前缀（doc_ / folder_ / legacy:，见 stable-id.ts）保证
 * 无歧义：无冒号且 `legacy_` 开头的名字只能来自编码写入（真 legacy id 恒含 `:`）→
 * 逆推 `legacy:`；含 `:` 的字面名（mac 存量）原样即 docId；其余（doc_/folder_）编码
 * 前后同名原样返回。
 */
export function decodeDocDirName(name: string): string {
  if (name.startsWith('legacy_')) return 'legacy:' + name.slice('legacy_'.length)
  return name
}

/** docId 的候选版本目录（字面历史在前、win 编码在后；同一目录则去重为单元素）。
 *  字面目录仅 mac 存量库存在（`:` 在 POSIX 文件名合法、win 非法，win 上永不出现）——
 *  编码写入开启前同一 docId 的版本可能分布在两目录（存量在字面、之后在编码），
 *  任何单目录解析都会读写分裂：新版本写入后 list/read 不可见、prune 只扫一侧。
 *  R68-2：purgeTrash 连删版本目录按本函数同款「字面在前、编码在后、同名去重」
 *  口径（trash.ts 内联名称候选——文件名层面同构）。 */
function docVersionDirs(versionsDir: string, docId: string): string[] {
  const literal = join(versionsDir, docId)
  const encoded = join(versionsDir, encodeDocDirName(docId))
  return literal === encoded ? [encoded] : [literal, encoded]
}

/** 在候选目录中定位版本文件（双目录回退）；不存在返回 null。 */
function findVersionFile(versionsDir: string, docId: string, id: string): string | null {
  for (const dir of docVersionDirs(versionsDir, docId)) {
    const file = join(dir, `${id}.md`)
    if (existsSync(file)) return file
  }
  return null
}

export interface VersionMeta {
  /** 来源：autosave 编辑快照 / manual 手动留底 / finalize 定稿 / restore 恢复 / rename / delete… */
  origin: string
  reason?: string
  baseRevision?: Revision
  /** 正文字数（剥 front matter 后）。 */
  words?: number
  /** 永久保留（finalize 定稿版本）；prune 不清理。 */
  pinned?: boolean
}

export interface VersionInfo {
  id: string
  path: string
}

/** 版本列表项（对外，含解出的时间与元信息）。 */
export interface VersionEntry {
  id: string
  /** 毫秒时间戳（ULID 解出）。 */
  time: number
  origin: string
  reason: string
  /** 正文字数（剥 front matter 后）。 */
  words: number
  /** 永久保留标记（finalize 定稿版本）。 */
  pinned: boolean
}

/** 保留策略。maxDays/maxCount 由 book.yaml 配置，throttleMinutes 为内部规则。 */
export interface VersionPolicy {
  /** 超期删除（天）。 */
  maxDays: number
  /** 每文档保留上限（个）。 */
  maxCount: number
  /** 写入节流（分钟）：窗口内已有版本则跳过。 */
  throttleMinutes: number
}

export const DEFAULT_VERSION_POLICY: VersionPolicy = {
  maxDays: 14,
  maxCount: 30,
  throttleMinutes: 5,
}

export interface WriteVersionOptions {
  policy?: VersionPolicy
  /** 跳过节流：删除/改名前留底、restore 覆盖前留底等"必须留"的时刻。 */
  force?: boolean
}

const HOUR_MS = 3600_000
const DAY_MS = 86_400_000
/** 最近 2 小时的版本全留（细粒度回退窗口）。 */
const FINE_WINDOW_MS = 2 * HOUR_MS

/**
 * P3-14：最新同 origin 版本内容指纹缓存（去重优化）。
 * 写版本前的去重此前每次全量读盘扫历史（复杂度随版本数线性涨）；现改为
 * 「指纹缓存命中 O(1) 跳过，冷缓存才读盘比对」。
 *
 * AA-P1-1 修正：缓存值改存「版本 id + fp」，命中需满足两个条件——
 *   ① fp 相等；② 缓存指向的版本 id 仍有效（R34D-15 收紧为「仍是盘上最新同 origin
 *   版本」，覆盖原「仍在盘」判定——他进程写入更新的同 origin 版本时旧 id 仍在盘但
 *   已非最新，按旧 id 去重会错误跳写、快照链尾部失真）。
 * 版本被 prune 删掉后，缓存必须失效（回到读盘比对）——否则「内容恰好等于被删
 * 版本」的强制留底（移动/改名/restore 覆盖前）会被静默吞掉，违背 W0-1 留底纪律。
 * 另有第二道防线：pruneVersions 删除时同步失效对应缓存条目。
 * 缓存 key 含 versionsDir + docId + origin，Map 有 size 上限（进程级防缓涨）。
 */
interface VersionFpCacheEntry {
  /** 缓存指向的版本 id（用于校验其是否仍在盘） */
  id: string
  fp: string
}
const latestOriginHash = new Map<string, VersionFpCacheEntry>()
/** 进程级缓存上限（防多书长跑缓涨）——超限丢最旧（Map 按插入序） */
const MAX_CACHE_ENTRIES = 500

function contentFingerprint(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** 缓存超限修剪（写入后调用） */
function trimVersionCache(): void {
  while (latestOriginHash.size > MAX_CACHE_ENTRIES) {
    const oldest = latestOriginHash.keys().next().value
    if (oldest === undefined) break
    latestOriginHash.delete(oldest)
  }
}

/** 写缓存条目 + 超限修剪（AA-P1-1：Map 有 size 上限，防多书长跑缓涨） */
function setVersionCache(cacheKey: string, entry: VersionFpCacheEntry): void {
  latestOriginHash.set(cacheKey, entry)
  trimVersionCache()
}

/**
 * 建版本：全文 + front matter 元信息（来源/原因/基线/字数/永久）。
 * 返回版本 id；被去重或节流跳过时返回 null。写入成功后顺带 prune（不引定时器）。
 */
export function writeVersion(
  versionsDir: string,
  docId: string,
  content: string | Buffer,
  meta: VersionMeta,
  options: WriteVersionOptions = {},
): string | null {
  const policy = options.policy ?? DEFAULT_VERSION_POLICY
  // 默认 force=true（兼容旧快照调用方行为——编辑器保存每次都留底；需节流的调用方显式传 force:false）
  const force = options.force ?? true
  // docId 防穿越（与 listVersions/readVersion 一致，write 路径也需校验）
  // N1（五十九轮）：拒绝不再静默——去重/节流的 null 是合法跳过，但「非法 docId 拒写」
  // 是留底纪律失守（调用方无从区分），至少 warn 留痕供诊断。
  if (!safeDocId(docId)) {
    log.warn('version', `版本留底拒绝非法 docId（含路径分隔符或 ..）：${JSON.stringify(docId)}——调用方留底契约失守`)
    return null
  }
  const existing = listVersions(versionsDir, docId)
  const latest = existing[0]
  // P3-14：去重指纹缓存 key（含 versionsDir 防跨书碰撞）
  const cacheKey = `${versionsDir}\u0000${docId}\u0000${meta.origin}`
  const fp = contentFingerprint(content)

  if (latest) {
    // 节流：窗口内已有版本 → 跳过（force 时不限）
    if (!force && policy.throttleMinutes > 0) {
      // RB-KN-P2-6：节流按 origin 分域（与 X-P2-3 去重语义对齐）——原先按「最新任意
      // origin」版本判窗口，刚写过 finalize/ai 版本后窗口内的 autosave 修改前留底
      // 会被静默吞掉，跨 origin 误节流。
      for (const s of existing) {
        // R66-19（十四轮）：节流判定只需 origin——整读 readVersion 把全文读进内存，
        // 长书高频 autosave 留底每次扫到最新同 origin 前触发多次全文读；改走 R62-36
        // 已建的 readVersionMeta 头部 bounded read（此三处当年漏迁移）。
        const prevMeta = readVersionMeta(versionsDir, docId, s.id)
        // R73-35（二十一轮）：meta 不可读（头部损坏/截断）视为**无法判定**——continue
        // 落到更旧版本会把窗口判定锚在错误锚点上（最新版可能恰在窗口内却节流失效/
        // 误节流），fail-open 不节流直接落写（留底宁多勿失，与下方去重循环同口径）。
        if (!prevMeta) break
        if (prevMeta.meta.origin !== meta.origin) continue
        const age = Date.now() - decodeUlidTime(s.id)
        if (age < policy.throttleMinutes * 60_000) return null
        break // 最新同 origin 版本已出窗 → 不节流
      }
    }
    // X-P2-3：去重按 origin 分域——ai 轨迹（origin 'ai'，X-P2-3 无 git 书库后端）与编辑快照/
    // 覆写留底共处同一档案但语义不同：跨 origin 同内容去重会把「覆写留底」吞掉（snapshotted
    // 假 false、恢复点被 ai 记录顶替），反向也会让 ai 轨迹被快照顶掉。只与「最新的同 origin
    // 版本」比对同内容；不同 origin 的内容独立保留（各自受分层/数量策略约束）。
    // P3-14 + AA-P1-1：先查指纹缓存；命中须同时满足 ① fp 相等 ② 缓存指向的版本 id
    // 仍是**盘上最新同 origin 版本**（R34D-15 收紧：原校验只验「id 在盘」，双进程下
    // 他进程已写入更新的同 origin 版本时，旧 id 仍在盘但已非最新——fp 恰与旧版相等
    // 时错误跳写，快照链尾部失真为旧内容，违背 X-P2-3「只与最新同 origin 比对」的
    // 去重语义；「id 已被 prune/外部删除」是本校验的子集，AA-P1-1 防线语义不变）。
    // 任一不满足 → 缓存失效，落读盘比对。冷缓存直接读盘。校验从新到旧扫至缓存 id
    // 为止：常见单进程路径缓存 id 即 existing[0]（零读盘，优化不回退）；跨 origin
    // 新版至多多读几个头部 bounded read。
    const cached = latestOriginHash.get(cacheKey)
    let cacheAlive = false
    if (cached !== undefined) {
      for (const s of existing) {
        if (s.id === cached.id) {
          cacheAlive = true // 途中无更新同 origin 版本 → 缓存仍指向最新同 origin
          break
        }
        // 新于缓存 id 的版本逐个验 origin：同 origin 已存在 → 缓存非最新；meta 不可读
        // → 同源与否无法判定（R73-35 口径）→ 一并按失效处理，回读盘比对兜底。
        const m = readVersionMeta(versionsDir, docId, s.id)
        if (!m || m.meta.origin === meta.origin) break
      }
    }
    if (cacheAlive) {
      if (cached!.fp === fp) return null // 命中：去重跳过
    } else if (cached !== undefined) {
      // 缓存已非最新同 origin（他进程覆写同源新版 / 指向版本已被删）→ 失效，回读盘比对
      latestOriginHash.delete(cacheKey)
    }
    for (const s of existing) {
      // R66-19（十四轮）：origin 过滤先走 meta 头部读——跨 origin 版本不再整读全文
      //（ai/finalize/autosave 混排的长书，冷缓存落盘比对从 N 次全文读降到 1 次）；
      // 仅最新同 origin 版本需要正文比对才整读（去重语义不变）。
      const prevMeta = readVersionMeta(versionsDir, docId, s.id)
      // R73-35（二十一轮）：meta 不可读（损坏）的同源候选不再 continue 落到更旧版本
      // 比对——恰等旧版时会跳写致快照链尾部失真（最新同 origin 版本的内容既没比对上、
      // 新版本又被吞）。meta 不可读 = 同源与否无法判定 = 去重无法判定，fail-open 直接
      // 落写（W0-1 留底纪律：宁多留一版，不可静默丢一版）。
      if (!prevMeta) break
      if (prevMeta.meta.origin !== meta.origin) continue
      const prev = readVersion(versionsDir, docId, s.id)
      // R26-52 + R28-17（二十八轮注释口径修正）：字节档（Buffer）不走 readVersion 的
      // utf-8 文本回读比对——readVersion 的文本对非 UTF-8 原字节必然失配，比不中；
      // 但内容级去重并未缺席：上方指纹缓存路径（contentFingerprint 对 Buffer 同样
      // 成立，写盘后 setVersionCache 必更新）在 fp 相等且缓存指向版本仍在盘时照样
      // 去重（return null），同内容重复留底仍被跳过、行为无害。此处仅是跳过「文本
      // 回读比对」这一条路径，W0-1 宁多勿失由 fail-open 分支（meta 不可读 → break
      // 落写）与缓存失效回读盘比对继续兜住。
      if (prev && !Buffer.isBuffer(content) && prev.content === content) {
        setVersionCache(cacheKey, { id: s.id, fp })
        return null
      }
      break
    }
  }

  const id = ulid()
  const ts = new Date().toISOString()
  const front: string[] = ['---', `版本ID: ${id}`, `时间: ${ts}`, `来源: ${meta.origin}`]
  if (meta.reason) front.push(`原因: ${stringifyValue(sanitizeFmLine(meta.reason))}`)
  if (meta.baseRevision) front.push(`基线: ${meta.baseRevision}`)
  if (meta.words !== undefined) front.push(`字数: ${meta.words}`)
  if (meta.pinned) front.push('永久: true')
  front.push('---', '')
  const file = join(versionsDir, encodeDocDirName(docId), `${id}.md`)
  // R26-52（二十六轮）：Buffer 直存字节档——非 UTF-8 源（GBK 旧档）的结构性留底
  //（移动/删除前，service.ts 调用点）若按 utf-8 文本写，U+FFFD 替换符落盘后原字节
  // 永久失真（假留底：正文被覆盖后无任何字节级可恢复副本）。fm 头恒 utf-8，正文段
  // 原字节拼接，快照文件即字节档。
  const frontText = front.join('\n')
  atomicWriteFile(
    file,
    Buffer.isBuffer(content) ? Buffer.concat([Buffer.from(frontText, 'utf8'), content]) : frontText + content,
    { fsync: true },
  )
  // P3-14 + AA-P1-1：写入成功后更新指纹缓存（存「版本 id + fp」，下次同 origin 同内容
  // 命中时校验该 id 仍在盘；Map 有 size 上限防缓涨）
  setVersionCache(cacheKey, { id, fp })
  pruneVersions(versionsDir, docId, policy)
  return id
}

/** R64-12（十二轮）：fm 值单行化消毒——reason 含章节标题，标题带换行时直拼会把后续
 *  行伪装成 front matter 键值行，版本元数据失真（readVersionMeta 可能 null → 该版本从
 *  AI 轨迹消失）。控制字符折空格收一行；` # `/引号由 stringifyValue 按需引号化兜住
 *  （与解析端 unquote 对称）。 */
function sanitizeFmLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').trim()
}

/** 列某文档的版本（按 id 降序，新的在前；id 是 ULID 时间排序）。
 *  字面 + 编码两目录取并集（mac 存量库历史版本分布在两目录，win 上字面目录不存在）。 */
export function listVersions(versionsDir: string, docId: string): VersionInfo[] {
  if (!safeDocId(docId)) return []
  const out: VersionInfo[] = []
  const seen = new Set<string>()
  for (const dir of docVersionDirs(versionsDir, docId)) {
    if (!existsSync(dir)) continue
    // R72-6（二十轮 B-5）：existsSync→readdirSync 之间并发 purge 落间则 readdir 裸抛，
    // 列表调用整体失败。该目录按空处理（读失败无数据损伤；另一侧目录照常取并集）
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      // R42-39（四十二轮）：.md 判定收敛 isMdFileName（大小写不敏感）——win 资源管理器
      // 改 .MD 后版本档案列表静默失明；AppleDouble `._` 前缀跳过条件不变。
      // 下方 slice(0, -3) 剥 '.MD' 同为 3 字符，无需改。
      if (name.startsWith('._') || !isMdFileName(name)) continue
      const id = name.slice(0, -3)
      // 同 id 理论上只在一侧（写入恒编码）；防手搬/复制出双份时重复列
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, path: join(dir, name) })
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id))
}

/** fm 键值 map → 版本 meta（readVersion / readVersionMeta / readVersionRaw 三读入口
 *  共用口径，防三处各抄一份后漂移）。 */
function metaFromMap(map: Map<string, unknown>, id: string): VersionMeta & { time: number } {
  const meta: VersionMeta & { time: number } = {
    origin: String(map.get('来源') ?? ''),
    time: decodeUlidTime(id),
  }
  const reason = map.get('原因')
  if (reason) meta.reason = String(reason)
  const base = map.get('基线')
  if (base) meta.baseRevision = String(base) as Revision
  const words = map.get('字数')
  if (typeof words === 'number' && words > 0) meta.words = words
  const pinnedRaw = map.get('永久')
  if (pinnedRaw === true || pinnedRaw === 'true') meta.pinned = true
  return meta
}

/** 读单个版本：剥 front matter → 内容 + 元信息。文件缺失/损坏返回 null。
 *  注意 content 是 utf-8 文本视图：对 R26-52 字节档（非 UTF-8 源按原字节留底）必然
 *  有损（U+FFFD）——字节保真读用 readVersionRaw（R34D-18）。 */
export function readVersion(
  versionsDir: string,
  docId: string,
  id: string,
): { content: string; meta: VersionMeta & { time: number } } | null {
  // id 防穿越：ULID 是 26 位 Crockford base32，不含分隔符
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null
  // docId 防穿越（manifest 可篡改数据面 defense-in-depth）
  if (!safeDocId(docId)) return null
  const file = findVersionFile(versionsDir, docId, id)
  if (!file) return null
  const r = readFile(file)
  if (!r.ok) return null
  const map = parseFlat(r.fmRaw)
  return { content: r.body, meta: metaFromMap(map, id) }
}

/**
 * R62-36：只读版本 front matter（头部），不加载正文——收割判定 origin 用。
 * readVersion 会连同整篇正文一起读进内存（listAiVersions 对非 git 后端逐版全量
 * 整读两遍，长文大海捞针只为拿 origin/原因/字数）；本变体用 bounded read 只取
 * 文件头 4KB（版本 front matter 是文件起始的固定小段，远小于该上界），解析出与
 * readVersion 相同的 meta（origin/reason/baseRevision/words/pinned），不返回 content。
 * 文件缺失/损坏返回 null，与 readVersion 口径一致。
 */
export function readVersionMeta(
  versionsDir: string,
  docId: string,
  id: string,
): { meta: VersionMeta & { time: number } } | null {
  // id 防穿越：ULID 是 26 位 Crockford base32，不含分隔符
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null
  // docId 防穿越（manifest 可篡改数据面 defense-in-depth）
  if (!safeDocId(docId)) return null
  const file = findVersionFile(versionsDir, docId, id)
  if (!file) return null
  let head: string
  try {
    // bounded read 只取头部，避免整读大正文入内存
    // R67-12（十五轮）：4KB → 64KB——超长 frontmatter（异常长的「原因」等 fm 字段，
    // 或历史工具写入的赘余 fm）跨过 4KB 边界时闭合 --- 落在读取窗外，splitFrontMatter
    // 失败整版本被静默跳过；64KB 覆盖一切现实 fm 规模仍保有界（MB 级正文不入内存）
    const HEAD_LIMIT = 65_536
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(HEAD_LIMIT)
      const n = readSync(fd, buf, 0, HEAD_LIMIT, 0)
      head = buf.toString('utf-8', 0, n)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  const split = splitFrontMatter(head)
  if (split === null) return null
  const map = parseFlat(split.fmRaw)
  return { meta: metaFromMap(map, id) }
}

/** 行是否恰为零缩进 fence `---`（容忍 \r 尾）——与 splitFrontMatter 的闭合判定同口径。 */
function isFenceLine(b: Buffer): boolean {
  if (b.length !== 3 && b.length !== 4) return false
  if (b[0] !== 0x2d || b[1] !== 0x2d || b[2] !== 0x2d) return false // '---'
  return b.length === 3 || b[3] === 0x0d
}

/**
 * 字节层剥版本文件的 front matter：fm 头恒 utf-8（writeVersion 写侧保证），正文可为
 * 任意字节（R26-52 字节档）。先整体 utf-8 文本化再 split 的做法对非 UTF-8 正文必有损
 * （U+FFFD 替换不可逆），故闭合 --- 在字节层按行定位——\n 分行对多字节正文无歧义
 * （UTF-8/GBK 等编码的非 ASCII 字节恒 ≥0x80，不与 \n / `-` 碰撞）。判定口径与
 * frontmatter-core 的 splitFrontMatter 对齐：去 UTF-8 BOM、首行整行 ---、闭合行
 * 零缩进容忍 \r。无起始 fence / 未闭合返回 null（与文本侧同判损坏）。
 */
function splitVersionFileBytes(buf: Buffer): { fmRaw: string; body: Buffer } | null {
  let start = 0
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3 // UTF-8 BOM
  const firstNl = buf.indexOf(0x0a, start)
  if (firstNl === -1) return null // 单行文件无闭合可能
  if (!isFenceLine(buf.subarray(start, firstNl))) return null
  let lineStart = firstNl + 1
  while (lineStart < buf.length) {
    const nl = buf.indexOf(0x0a, lineStart)
    const lineEnd = nl === -1 ? buf.length : nl
    if (isFenceLine(buf.subarray(lineStart, lineEnd))) {
      // 与 splitFrontMatter 同切法：fm = 首行后～闭合行前；body = 闭合行换行后～尾
      return {
        fmRaw: buf.subarray(firstNl + 1, lineStart - 1).toString('utf-8'),
        body: nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1),
      }
    }
    if (nl === -1) break // 扫到尾无闭合 fence
    lineStart = nl + 1
  }
  return null
}

/**
 * R34D-18（三十四轮）：字节保真读——正文段原样返回 Buffer，不做法定编码假设。
 * 动机：R26-52 写侧对非 UTF-8 源（GBK 旧档）按原字节留底，但读侧唯一入口
 * readVersion 走 utf-8 文本化，U+FFFD 替换后原字节读不出（盘上字节在、读出必失真）
 * ——写读不对称使字节档的「恢复」形同虚设。本入口闭合「写入保的字节可无损读出」
 * 不变量：fm 头解析口径与 readVersion 完全一致（metaFromMap 同源），正文零解码。
 * 文件缺失/头部损坏返回 null，与 readVersion 口径一致。恢复链路（api restore →
 * save 接 Buffer）的接线属调用方批次，本层先落对称读能力。
 */
export function readVersionRaw(
  versionsDir: string,
  docId: string,
  id: string,
): { content: Buffer; meta: VersionMeta & { time: number } } | null {
  // id/docId 防穿越：与 readVersion 同判（同一数据面）
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null
  if (!safeDocId(docId)) return null
  const file = findVersionFile(versionsDir, docId, id)
  if (!file) return null
  let buf: Buffer
  try {
    buf = readFileSync(file)
  } catch {
    return null
  }
  const split = splitVersionFileBytes(buf)
  if (split === null) return null
  return { content: split.body, meta: metaFromMap(parseFlat(split.fmRaw), id) }
}

/** 列版本（对外：含时间/来源/原因/字数/永久，供 UI 展示）。 */
export function listVersionEntries(
  versionsDir: string,
  docId: string,
  countWords: (text: string) => number,
): VersionEntry[] {
  const out: VersionEntry[] = []
  for (const s of listVersions(versionsDir, docId)) {
    const read = readVersion(versionsDir, docId, s.id)
    if (!read) continue
    out.push({
      id: s.id,
      time: read.meta.time,
      origin: read.meta.origin,
      reason: read.meta.reason ?? '',
      words: read.meta.words ?? countWords(read.content),
      pinned: read.meta.pinned ?? false,
    })
  }
  return out
}

/**
 * 分层保留清理（Time Machine 式）：越近越细，越远越粗，匹配真实需求分布——
 * 刚写的想细粒度退，几天前只需一个锚点。pinned（定稿里程碑）恒保留。
 *
 * | 最近 2 小时      | 全留               |
 * | 2 - 24 小时      | 每小时 1 个（取最早）|
 * | 1 天 - maxDays   | 每天 1 个（取最早）  |
 * | 超过 maxDays     | 删（pinned 仍留）   |
 * | 总数超 maxCount  | 从最旧删（pinned 不删）|
 *
 * pinned（定稿里程碑）恒保留；头部不可读（是否定稿无法判定）的版本按 pinned 同等
 * 保护不删（R34D-14，宁多勿失——与写侧 R73-35 fail-open 口径同向）。
 *
 * @returns 删除的版本数
 */
export function pruneVersions(
  versionsDir: string,
  docId: string,
  policy: VersionPolicy = DEFAULT_VERSION_POLICY,
  now: number = Date.now(),
): number {
  const all = listVersions(versionsDir, docId)
  if (!all.length) return 0

  // 升序（旧→新）遍历，每个时间桶的第一个即该桶最早的
  const ascending = [...all].reverse()
  const keep = new Set<string>()
  const pinned = new Set<string>()
  const hourBuckets = new Set<number>()
  const dayBuckets = new Set<number>()
  const maxAge = policy.maxDays * DAY_MS

  for (const s of ascending) {
    // R66-19（十四轮）：分层清理只判 pinned（meta 字段）——整读 readVersion 把全文
    // 读进内存只为拿一个布尔位；改 readVersionMeta 头部 bounded read（R62-36 漏迁移），
    // prune 每文档全量扫版本时的全文读归零。
    const meta = readVersionMeta(versionsDir, docId, s.id)
    // R34D-14（三十四轮）：头部不可读（截断/损坏）⇒ 是否定稿 pinned 无法判定——此前
    // 落「非 pinned」分支，头部受损的定稿档照样被超期/maxCount 清理删除，「定稿永久
    // 保留」承诺失守，与写侧 R73-35「meta 不可读 fail-open 落写」的宁多勿失口径相反。
    // 删侧同向：无法判定 ⇒ 不删，按 pinned 同等保护（含 maxCount 兜底不裁，防兜底
    // 兜不住再被裁）。注：readVersionMeta 对「文件已被并发删」同样返回 null，此时
    // keep 一个已不存在的 id 无副作用。
    if (!meta) {
      keep.add(s.id)
      pinned.add(s.id)
      continue
    }
    if (meta.meta.pinned) {
      // 定稿版本永久保留：不参与分层/超期清理
      keep.add(s.id)
      pinned.add(s.id)
      continue
    }
    const t = decodeUlidTime(s.id)
    const age = now - t
    if (age > maxAge) continue // 超期不留
    if (age <= FINE_WINDOW_MS) {
      keep.add(s.id)
    } else if (age <= DAY_MS) {
      const bucket = Math.floor(t / HOUR_MS)
      if (!hourBuckets.has(bucket)) {
        hourBuckets.add(bucket)
        keep.add(s.id)
      }
    } else {
      const bucket = Math.floor(t / DAY_MS)
      if (!dayBuckets.has(bucket)) {
        dayBuckets.add(bucket)
        keep.add(s.id)
      }
    }
  }

  // 数量兜底：留最新的 maxCount 个；pinned 恒在（all 已按 id 降序 = 新在前）
  if (keep.size > policy.maxCount) {
    // P2-BE-2：pinned >= maxCount 时 maxCount - pinned.size 为负，slice(0, -N) 返回除末尾 N 个外全部（非空）→ Math.max 兜底
    const survivors = all.filter((s) => keep.has(s.id) && !pinned.has(s.id)).slice(0, Math.max(0, policy.maxCount - pinned.size))
    keep.clear()
    for (const s of pinned) keep.add(s)
    for (const s of survivors) keep.add(s.id)
  }

  let removed = 0
  // kk-P2-6：本 doc 缓存条目的 key 前缀（删除版本时同步失效用——头注释承诺的第二道防线）
  const cacheScope = `${versionsDir}\u0000${docId}\u0000`
  for (const s of all) {
    if (keep.has(s.id)) continue
    try {
      unlinkSync(s.path)
      removed++
    } catch {
      continue // 已被别处删掉无妨
    }
    // 失效指向被删版本的指纹缓存条目（此前未实现：残留缓存会让「内容恰好等于被删
    // 版本」的强制留底被去重吞掉，违背 W0-1 留底纪律——虽有读盘比对第一道防线，
    // 但该防线只在写路径顺带查询时触发，删后到下次写之间存在错窗）
    for (const [key, entry] of latestOriginHash) {
      if (key.startsWith(cacheScope) && entry.id === s.id) latestOriginHash.delete(key)
    }
    // macOS AppleDouble 伴生文件一并清理
    try {
      unlinkSync(join(dirname(s.path), `._${s.id}.md`))
    } catch {
      /* 没有就算了 */
    }
  }
  return removed
}

/**
 * 目录迁移：`工作区/.snapshots/` → `工作区/.版本/`（幂等）。
 * 旧快照默认 pinned=false（除非 front matter 已带 永久 字段）。
 * - 源不存在 → no-op
 * - 目标已存在 → 跳过（防覆盖）
 *
 * @returns 是否执行了迁移
 */
export function migrateVersionsDir(bookRoot: string): boolean {
  const legacy = join(bookRoot, '工作区', LEGACY_SNAPSHOTS_DIR_NAME)
  const target = join(bookRoot, '工作区', VERSIONS_DIR_NAME)
  if (!existsSync(legacy)) return false
  if (existsSync(target)) return false
  try {
    // R38-13（三十八轮）：收编 renameWithRetry——win 瞬时占用（杀软/索引器/同步盘）
    // 整目录 rename EPERM/EBUSY 时 3×50ms 退避自愈；失败语义不变（warn + false 幂等重试）
    renameWithRetry(legacy, target)
    return true
  } catch (e) {
    // R29-n/C-6（二十九轮）：迁移失败补 warn 留痕——原静默 return false。
    // R30-19（三十轮）：文案如实化——旧文称「读取方仍兼容旧位置」不实：listVersions
    // 只读 .版本/，迁移失败时旧位置快照在版本历史中**不可见**（文件仍在盘上，可手工
    // 恢复），按真实后果与处置指引告警。
    log.warn(
      'version',
      `版本目录迁移失败（${legacy} → ${target}）：旧位置快照在版本历史中不可见（文件仍在盘上，可手工恢复），请排查后重试迁移——${e instanceof Error ? e.message : String(e)}`,
    )
    return false
  }
}