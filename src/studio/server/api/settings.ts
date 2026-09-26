/**
 * 设定台 REST 端点（#7.5 长篇只读 + 角色卡结构化读）。
 *
 * GET  /api/books/:name/settings → 境界体系 + 角色卡(结构化) + 时间线 + 关系线子图
 * GET  /api/books/:name/completion-names → 角色姓名 + 物品名称（编辑器补全用）
 *
 * 知识层:角色卡 front matter 约定(姓名/身份/目标/境界)+ 正文(性格/外貌/履历自由描述)。
 * 境界体系强结构化(RealmDoc);角色结构化;时间线自由 MD;关系线从账本。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, basename, relative, dirname } from 'node:path'
import { readFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { defineRoute } from './schema.js'
import { reply, readJson, HttpError, replyError } from '../http.js'
import { bookMovedFailure, resolveBookOrReply } from '../book-context.js'
import { readRealmDoc } from '../../../format/realms.js'
import { readLeadDir } from '../../../format/leads.js'
import { parseFlat, readFileFmOnly } from '../../../format/frontmatter.js'
import { isMdFileName } from '../../../format/filename.js'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { RELATION_MINE_SPEC } from '../../../ai/tasks/specs.js'
import { replyGenerationFailure, type TaskGateInjected } from './task-gate.js' // /：长任务门控包装 + 生成失败状态映射单源（走 ctx.gate 实例）
import { createTtlProbeCache } from '../ttl-cache.js'
import { yieldToEventLoop } from '../../../async.js' // 扫描段让出原语（rhythm/progress 同源）
import { sigStatFor } from './rhythm.js' // 精简批（SRV 域）：size:mtimeMs 签名单源（原本地同构副本收敛）
import type { RealmSystem } from '../../../format/types.js'

interface SettingsCtx extends TaskGateInjected {
  workDir: string | null
  userDataPath: string | null
  /** 收尾：settings / completion-names 两缓存 TTL 覆盖档——组装根
 * RouteOverrides 注入（undefined = 生产口径 5s 逐位不变）。completion-names 沿旧
 * 回落链：本壳覆盖 → settings 覆盖 → 常量。 */
  settingsTtlMs?: number | null
  completionNamesTtlMs?: number | null
}

/** md 词干剥尾（大小写不敏感）——basename(x, '.md') 只剥精确小写，
 *  .MD 时兜底名会带扩展名（.MD 文件此前还被本文件三处扫描过滤静默失明，一并收敛）。
 * 对齐 leads.ts 口径。 */
function mdStem(name: string): string {
  return isMdFileName(name) ? name.slice(0, -3) : basename(name, '.md')
}

/** 轻量读目录下 md 文件的 fm 字段名（编辑器补全用，不读正文）。
 * 读面异步化 + fm 头读——此前
 *  readFile 不带 content 回退 readFileSync 整文件同步读（角色卡正文全进 IO 面，
 *  长篇书库单请求阻塞事件循环百毫秒级），改走 readFileFmOnly（头部限量字节提 fm，
 *  围栏不完整回退全读；解析与错误文案单源不变）。 */
async function readFmNames(dir: string, field: string): Promise<string[]> {
  const names: string[] = []
  let files: string[]
  try {
    // .md 判定收敛 isMdFileName（大小写不敏感）；`._` 前缀跳过不变
    // 目录不存在/读取失败 → 空列表（原 existsSync 前置 + readdirSync try/catch 同口径）
    files = (await readdir(dir)).filter((x) => isMdFileName(x) && !x.startsWith('._'))
  } catch {
    return names
  }
  try {
    for (const f of files) {
      const r = await readFileFmOnly(join(dir, f))
      const map = r.ok ? parseFlat(r.fmRaw) : new Map<string, unknown>()
      const n = String(map.get(field) ?? mdStem(f))
      if (n) names.push(n)
    }
  } catch { /* 单项意外失败 → 保留已收集名单（原整体 try/catch 同口径） */ }
  return names
}

/** 角色卡读取 + 设定上下文注入已下沉 src/process/settings-context.ts（架构治理） */
import { readCharacterCards } from '../../../process/settings-context.js'
import { log } from '../../../log/index.js'

export type { CharacterCard } from '../../../process/settings-context.js'

// ── settings 全书扫描「目录指纹 + TTL」缓存壳 ────────────
// 手法照抄同族先例 rhythm.ts / foreshadows.ts（探针 + 纯 TTL + FIFO 上限 +
// 书键 forget 挂点）：GET /settings 此前每请求全量重算 settingsLong——境界体系读取 +
// 角色卡目录整读 + 时间线 md 扫描 + 关系线账本 + relations.json + countChapters 递归
// 列正文目录，设定台面板打开/轮询反复触发。指纹按本端点实际读面构成：境界体系.md 与
// .clwriting/relations.json 两单文件 size:mtime（单文件内容写不改任何目录 mtime，必须
// 以文件 stat 入指纹）+ 设定/角色、设定/时间线、大纲/关系线、写作/正文 四目录 mtime
//（增删改名/同目录 rename 落盘可见）；目录内就地内容改写由 TTL 5s 兜底（宁多扫不脏读，
// TTL 与先例同值）。计算是同步单段（无在途并发窗口），缓存壳取先例同款同步形态。
const SETTINGS_CACHE_TTL_MS = 5000
const SETTINGS_CACHE_MAX = 32
/** 收尾：__setSettingsCacheTtlForTest / __setCompletionNamesCacheTtlForTest
 * 删除——TTL 覆盖档改组装根 RouteOverrides 注入（两缓存 getter 的覆盖尾参，随实例
 * 隔离；completion-names 沿旧回落链「本壳覆盖 → settings 覆盖 → 常量」，由 getter
 * 调用点以 `completionNamesTtlMs ?? settingsTtlMs` 表达）。 */
/** 删书/改名失效挂点（books.ts forgetBookKeyedCaches 家族同款）。
 * 批并修 deepseek- 起**同清两壳**（completion-names 见下方同族块）。 */
export function forgetSettingsCache(bookRoot: string): void {
  settingsCache.forget(bookRoot)
  completionNamesCache.forget(bookRoot)
}
/** 钩子收敛：/的 4 个观测钩子（__settingsScanCountForTest
 *  / __completionNamesScanCountForTest 与各自 reset）删除——MISS 计数收编进缓存壳
 *  （ttl-cache.ts 的 stats），回归用例改读下面导出的两壳实例的 stats/resetStats。
 *  导出实例即观测面（生产对象，非测试专用 API）。 */

/** settings 读面指纹：境界体系.md + relations.json（单文件）+ 角色/时间线/关系线/正文（目录 mtime）。 */
function settingsSignature(bookRoot: string): string {
  const dirSig = (...dir: string[]): string => {
    try {
      return String(statSync(join(bookRoot, ...dir)).mtimeMs)
    } catch {
      return '-'
    }
  }
  return [
    sigStatFor(join(bookRoot, '设定', '境界体系.md')),
    sigStatFor(join(bookRoot, '.clwriting', 'relations.json')),
    dirSig('设定', '角色'),
    dirSig('设定', '时间线'),
    dirSig('大纲', '关系线'),
    dirSig('写作', '正文'),
  ].join(',')
}

/** 缓存壳收编 ttl-cache.ts 通用件（原本地 Map + FIFO
 *  本地壳删除；命中/失效时序/逐出序逐位不变——单级探针 + 同步计算 + FIFO 32；
 *  特记 evictExpiredOnMiss:false——本壳原无过期顺手逐出行，逐条核对后按原
 *  样保留，见 ttl-cache.ts 头部收敛映射表）。 */
/** 导出供回归用例读 stats 观测（MISS 计数收编在壳内）。 */
export const settingsCache = createTtlProbeCache<string, unknown>({
  name: 'settings',
  keyOf: (k) => k,
  max: SETTINGS_CACHE_MAX,
  ttl: () => SETTINGS_CACHE_TTL_MS,
  probe: settingsSignature,
  computeSync: (bookRoot) => settingsLong(bookRoot),
  // async 孪生——本端点此前是全域
  // 唯一「MISS 同步全书扫描」的书键端点（同域 search/foreshadows/rhythm/progress/
  // overview 均已落 async 孪生）。MISS 时同步链（境界体系 + 角色卡整目录 + 时间线目录 +
  // 关系线 + 正文目录计数）整段无让出，本地 HTTP 服务端与桌面主进程同事件循环，大书首
  // 请求会卡住同刻的 SSE/IPC 心跳。让出范式与 rhythmComputeAsync
  // 逐位同款：扫描段前后各让出一次，结果复用同一 computeSync 体（逐位一致），并发 MISS
  // 经 in-flight 去重只扫一次。
  // 0918修复批（D001）：上句宣称此前不成立——创建 options 缺 inFlight，去重在
  // ttl-cache.ts 只走 opts.inFlight 分支（同族 search.ts/rhythm.ts/foreshadows.ts 均有），
  // 并发 MISS 各起一个 job 全量重扫。补 inFlight:true 后与宣称逐位一致：同键并发 MISS
  // 合并为同一 Promise（判定段已先行走完命中判定/过期处理，evictExpiredOnMiss:false
  // 组合下无逐出副作用）；不同键各算各的；getSync 同步孪生无在途窗口不受影响。
  computeAsync: settingsLongAsync,
  inFlight: true,
  evictExpiredOnMiss: false,
})

/** settings 聚合查询（目录指纹 + TTL 缓存壳）。导出供回归测试直测。
 *  ：生产路径已改走 async 孪生（下方 getSettingsCachedAsync）；同步版
 * 保留原样作回归测试直测面（rhythm 域 getRhythmCached 同款处置）。
 * 收尾：ttlOverrideMs = 逐调用 TTL 覆盖档（组装根 RouteOverrides 经
 * handler 传入；直测面显式传——undefined = 生产口径 5s）。 */
export function getSettingsCached(bookRoot: string, ttlOverrideMs?: number | null): unknown {
  return settingsCache.getSync(bookRoot, ttlOverrideMs ?? undefined)
}

/** 缓存壳的异步孪生（端点生产路径）。命中语义与同步版逐位一致（同壳
 *  共 Map 同 TTL 同签名），MISS 时走 settingsLongAsync 让出 + in-flight 去重。
 *  导出供回归测试直测。边界如实记：扫描体内核（readCharacterCards / readChapterDir 等）
 *  仍是单段同步读——本孪生只保证端点 handler 链上不再是「无让出的整段同步链」，
 *  不宣称内核已可中断。 */
export function getSettingsCachedAsync(bookRoot: string, ttlOverrideMs?: number | null): Promise<unknown> {
  return settingsCache.get(bookRoot, undefined, ttlOverrideMs ?? undefined)
}

// ── completion-names「目录指纹 + TTL」缓存壳 ──
// 手法照抄上方 settings 缓存壳（探针 + 纯 TTL + FIFO 上限）：补全名单端点此前
// 无任何缓存键，每次请求两遍全目录 fm 读（切书 + 编辑器 @ 键 5min 补拉反复触发）。
// 指纹按本端点实际读面构成：设定/角色、设定/物品 两目录 mtime（增删改名落盘可见）；
// 目录内就地内容改写不动目录 mtime，由 TTL 5s 兜底（与 同值，宁多扫不脏读）。
// 计算体已异步化（事件循环无阻塞段），缓存壳取同款「同步检查 + 异步计算」形态。
// 批并修 deepseek- 同题在 mac 树独立落地，win 合并批
// 收口合成：forget 挂点收编 forgetSettingsCache 同清两壳（删书/改名即时出清，较
// 首版「TTL/FIFO 自然出清」收紧）；TTL 生效值链 = 本壳注入口 → settings
// 壳注入口（同控回落档）→ 常量。
const COMPLETION_NAMES_CACHE_TTL_MS = 5000
const COMPLETION_NAMES_CACHE_MAX = 32
/** 收尾：__setCompletionNamesCacheTtlForTest 删除——TTL 覆盖档改组装根
 * RouteOverrides 注入（getCompletionNamesCached 覆盖尾参；回落链「本壳覆盖 → settings
 * 覆盖 → 常量」由调用点 `completionNamesTtlMs ?? settingsTtlMs` 表达，随实例隔离）。 */
/** 回归观测（起经导出的壳实例读 stats，钩子已删；见上方同族注）。 */

/** completion-names 读面指纹：设定/角色 + 设定/物品 目录 mtime。 */
function completionNamesSignature(bookRoot: string): string {
  const dirSig = (...dir: string[]): string => {
    try {
      return String(statSync(join(bookRoot, ...dir)).mtimeMs)
    } catch {
      return '-'
    }
  }
  return [dirSig('设定', '角色'), dirSig('设定', '物品')].join(',')
}

/** 缓存壳收编 ttl-cache.ts 通用件（原本地 Map + FIFO
 *  本地壳删除；命中/失效时序/逐出序逐位不变——单级探针 + 异步计算 + FIFO 32；
 *  特记 evictExpiredOnMiss:false（原无逐出行）+ TTL 链「本壳注入口 → settings
 *  壳注入口 → 常量」以闭包原样表达，见 ttl-cache.ts 头部收敛映射表）。
 * 0918修复批（D001）：补 inFlight:true——本壳计算体全异步（readFmNames
 *  readdir/fm 读），并发 MISS（切书 + 编辑器 @ 补拉同刻触发）此前各扫一遍全目录；
 *  补后同键并发合并为一次扫描（settings 壳同款语义，见上方 D001 注）。 */
/** 导出供回归用例读 stats 观测（MISS 计数收编在壳内）。 */
export const completionNamesCache = createTtlProbeCache<string, unknown>({
  name: 'completion-names',
  keyOf: (k) => k,
  max: COMPLETION_NAMES_CACHE_MAX,
  ttl: () => COMPLETION_NAMES_CACHE_TTL_MS,
  probe: completionNamesSignature,
  computeAsync: async (bookRoot) => {
    const setDir = join(bookRoot, '设定')
    const [characters, items] = await Promise.all([
      readFmNames(join(setDir, '角色'), '姓名'),
      readFmNames(join(setDir, '物品'), '名称'),
    ])
    return { characters, items }
  },
  inFlight: true,
  evictExpiredOnMiss: false,
})

/** completion-names 聚合查询（目录指纹 + TTL 缓存壳）。导出供回归测试直测（
 *  -0912-4 口径，直调须 await）；起读面异步化 + fm 头读。响应体契约
 * { characters, items } 逐字节不变（键序/结构与改前一致）。
 * 收尾：ttlOverrideMs = 逐调用 TTL 覆盖档（组装根 RouteOverrides 经
 * handler 以回落链传入；直测面显式传——undefined = 生产口径 5s）。 */
export async function getCompletionNamesCached(bookRoot: string, ttlOverrideMs?: number | null): Promise<unknown> {
  return completionNamesCache.get(bookRoot, undefined, ttlOverrideMs ?? undefined)
}

export function registerSettingsRoutes(ctx: SettingsCtx): void {
  defineRoute('books.settings', {
    method: 'GET',
    path: '/api/books/:name/settings',
    // handler 挂 async 走 async 主路（router dispatch 对 async handler
    // 已有 catch 兜底，rhythm 域同款）
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBookOrReply(ctx.workDir, params['name'], res)
    if (!r) return

    const bookRoot = r.bookRoot
    // 全书扫描走缓存壳（命中即跳过 settingsLong 的全量重算）
    // 改走 async 孪生（扫描段让出 + in-flight 去重），同步版保留为
    // 回归测试直测面；响应 schema 逐位不变
    // 收尾：TTL 覆盖档经 ctx（组装根 RouteOverrides）逐调用传入
    reply(res, 200, await getSettingsCachedAsync(bookRoot, ctx.settingsTtlMs ?? undefined))
  },
  })

  // 补全名称列表（编辑器自动补全用；轻量：角色姓名 + 物品名称，只读 fm 不读正文）
  // 与 批并修 deepseek-
  // 两树同题独立落地，win 合并批收口合成：走缓存壳（命中即跳过全目录 fm 读）+
  // handler 异步化——扫描体不再同步阻塞事件循环；响应契约不变
  defineRoute('books.completion-names', {
    method: 'GET',
    path: '/api/books/:name/completion-names',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBookOrReply(ctx.workDir, params['name'], res)
    if (!r) return
    // 收尾：TTL 覆盖档经 ctx 逐调用传入（回落链「本壳 → settings → 常量」）
    reply(res, 200, await getCompletionNamesCached(r.bookRoot, ctx.completionNamesTtlMs ?? ctx.settingsTtlMs ?? undefined))
  },
  })

  // AI 关系梳理：通读名册/角色卡/正文，提炼关系边 → 落盘 .clwriting/relations.json
  defineRoute('books.relations.mine', {
    method: 'POST',
    path: '/api/books/:name/relations/mine',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBookOrReply(ctx.workDir, params['name'], res)
    if (!r) return
    // 编排互斥预检 + 任务闸（409 文案逐位保留）+
    // -①中断通道（owner='relations-mine:<书名>'）
    // ——十段复制收编 runGatedGeneration 单源（接法头注见
    // task-gate.ts；GET settings/completion-names 无 AI 生成段，不接线）。
    return ctx.gate.runGatedGeneration(res, {
      book: params['name']!,
      workDir: ctx.workDir!,
      action: 'relations-mine',
      busyText: '本书正在梳理角色关系，请等待完成后再试',
    }, async (ctrl) => {
      // 幂等：body.force=true 强制重新梳理；否则已有缓存则直接返回
      // （readJson 的 HttpError（如 413 超限）透传，只容错「无 body/坏 JSON」）
      // （输入校验两套纪律）：本端点体量最小，确有两处 parse 不可表达的
      // 既有语义，故留内联读取并显式判型（force 仅此一处消费，无第二套校验口径）：
      // ① 闸先于读体——runGatedGeneration 的编排互斥/task 闸 409 必须早于 body 400，
      //    迁 parse 要把闸搬进 gate，而闸包装正本在 task-gate.ts（本批范围外）；
      // ② 容错读取——非 HttpError 的连接层失败按空 body 兜底继续（同 providers.test 的
      // 口径），defineRoute 的 readJson 失败先于 parse 短路回 400，容错不可表达。
      const body = (await readJson(req).catch((e: unknown) => {
        if (e instanceof HttpError) throw e
        return {}
      })) as { force?: boolean }
      const force = body?.force === true
      const bookRoot = r.bookRoot
      const cachePath = join(bookRoot, RELATION_CACHE)
      if (!force && existsSync(cachePath)) {
        return reply(res, 200, { ok: true, cached: true, relations: readRelationCache(bookRoot).relations })
      }
      const mined = buildMineContext(bookRoot)
      const context = mined.text
      if (!context.trim()) return replyError(res, 400, 'BAD_INPUT', '没有可梳理的材料（名册/角色卡/正文均空）')
      const out = await runSpec(RELATION_MINE_SPEC, {
        userDataPath: ctx.userDataPath,
        bookRoot,
        userPrompt: `## 任务\n通读以下材料，提炼这部书的角色关系网络。\n\n${context}`,
        // 聚合材料注入源登记（铁律①）——名册/角色卡目录/正文节选各章
        promptFiles: mined.files,
        ctrl, // -①：中断通道透传
      })
      if (!out.ok) {
        // -①：中断收口——ABORTED → 499 人话信封。：
        // 状态映射收编 replyGenerationFailure 单源；本端点文案变体逐位保留（ABORTED 固定
        // 「已中断」非 out.error、其余坍缩 GEN_FAIL 并组装「AI 梳理失败:…」）——经形状
        // 归一喂单源，status 判定（499/500）与信封字节不变。
        return replyGenerationFailure(res, out.code === 'ABORTED'
          ? { ok: false, code: 'ABORTED', error: '已中断' }
          : { ok: false, code: 'GEN_FAIL', error: `AI 梳理失败:${out.error}` })
      }
      const input = out.data.input as { relations?: { from: string; to: string; type: string; note?: string }[] } | null
      const relations = input?.relations ?? []
      // 零关系也是合法产出——此前空结果不落缓存，下次请求重新
      // 烧一遍 AI 费用；且该分支返回 cached:true 语义失真（实为新鲜产出非缓存命中）。
      // 空数组同样落盘，与有产出共用下方写路径，本请求如实标 cached:false
      // -③：落盘前重验书注册（对齐 style.ts 现行防线）——runSpec
      // 分钟级 await 窗口内书可能被删/改名，向旧 bookRoot 写 .clwriting/relations.json
      // 会复活幽灵目录（无 book.yaml，repairBooks 不认领）。已删或变化 → 409 BOOK_MOVED。
      // 并合注：本地同构实现已收敛 book-context.ts bookMovedFailure 单源。
      const moved = bookMovedFailure(ctx.workDir, params['name'], bookRoot)
      if (moved) return replyError(res, 409, moved.code, moved.reason)
      try {
        mkdirSync(dirname(cachePath), { recursive: true })
        atomicWriteFile(cachePath, JSON.stringify({ relations, chapterCount: countChapters(bookRoot) }, null, 2))
      } catch (e) {
        log.error('api', '落盘缓存失败（角色关系）', e)
        return replyError(res, 500, 'IO_ERROR', '落盘缓存失败')
      }
      reply(res, 200, { ok: true, cached: false, relations })
    })
  },
  })
}

/** async 孪生 MISS 计算体（生产路径）。让出范式同 rhythmComputeAsync /
 * progress.ts （扫描段前后各一次），数值与 settingsLong 逐位一致（复用同一体）。 */
async function settingsLongAsync(bookRoot: string): Promise<unknown> {
  await yieldToEventLoop()
  const value = settingsLong(bookRoot)
  await yieldToEventLoop()
  return value
}

function settingsLong(bookRoot: string): unknown {
  const setDir = join(bookRoot, '设定')

  // 境界体系（强结构化）
  let realm: { 体系: RealmSystem[]; 正文?: string } | null = null
  const rr = readRealmDoc(join(setDir, '境界体系.md'))
  if (rr.ok) {
    realm = { 体系: rr.doc.体系 }
    if (rr.doc.正文) realm.正文 = rr.doc.正文
  }

  // 角色卡(结构化) / 时间线(自由 MD)
  const characters = readCharacterCards(join(setDir, '角色'), bookRoot)
  const timeline = scanFreeMd(join(setDir, '时间线'))

  // 关系线子图（账本关系线类）
  const { leads } = readLeadDir(join(bookRoot, '大纲', '关系线'))
  const debtGraph = leads
    .filter((l) => l.欠方 || l.债主)
    .map((l) => ({ 编号: l.编号, 标题: l.标题, 状态: l.状态, 欠方: l.欠方 ?? '', 债主: l.债主 ?? '' }))

  // 角色关系：AI 梳理缓存（.clwriting/relations.json，优先）+ 角色卡 front matter「关系」字段（补充）
  const relCache = readRelationCache(bookRoot)
  const mined = relCache.relations
  const seen = new Set<string>()
  const characterRelations: { from: string; to: string; type: string; note?: string }[] = []
  // AI 梳理数据：type 已是完整短语（prompt 要求），不规范化，原样使用 + 传 note
  for (const e of mined) {
    if (!e.from || !e.to || e.from === e.to) continue
    const k = e.from < e.to ? `${e.from} ${e.to}` : `${e.to} ${e.from}`
    if (seen.has(k)) continue
    seen.add(k)
    characterRelations.push({ from: e.from, to: e.to, type: e.type, note: e.note })
  }
  // 角色卡手填数据：自由文本简写需归一化（师→师徒），无 note
  for (const c of characters) {
    for (const r of parseRelations(c.关系)) {
      if (!c.姓名 || !r.to || c.姓名 === r.to) continue
      const k = c.姓名 < r.to ? `${c.姓名} ${r.to}` : `${r.to} ${c.姓名}`
      if (seen.has(k)) continue
      seen.add(k)
      characterRelations.push({ from: c.姓名, to: r.to, type: normalizeRelationType(r.type) })
    }
  }

  return {
    kind: 'long' as const, realm, characters, timeline, debtGraph, characterRelations,
    relationCache: { chapterCount: relCache.chapterCount, currentChapters: countChapters(bookRoot) },
  }
}

/** AI 关系梳理缓存的相对路径（.clwriting/relations.json）。 */
const RELATION_CACHE = '.clwriting/relations.json'

// -③：本端点书注册重验原持本地同构实现
// relationsBookMoved；并合 后收敛到
// book-context.ts bookMovedFailure 单源（判定口径与人话文案逐字一致），本地拷贝删除。

/** 读 AI 关系梳理缓存（不存在/损坏 → 空）。返回 relations 数组 + 梳理时的章节数（新鲜度判断用）。 */
function readRelationCache(bookRoot: string): {
  relations: { from: string; to: string; type: string; note?: string }[]
  chapterCount: number | null
} {
  try {
    const p = join(bookRoot, RELATION_CACHE)
    if (!existsSync(p)) return { relations: [], chapterCount: null }
    const d = JSON.parse(readFileSync(p, 'utf8'))
    if (!Array.isArray(d?.relations)) return { relations: [], chapterCount: null }
    const relations = d.relations.filter(
      (e: unknown): e is { from: string; to: string; type: string; note?: string } =>
        !!e && typeof (e as { from?: unknown }).from === 'string' &&
        typeof (e as { to?: unknown }).to === 'string' &&
        typeof (e as { type?: unknown }).type === 'string',
    )
    const chapterCount = typeof d.chapterCount === 'number' ? d.chapterCount : null
    return { relations, chapterCount }
  } catch {
    return { relations: [], chapterCount: null }
  }
}

/** 组关系梳理输入材料：名册 + 角色卡摘要 + 已写正文节选（防超长，正文截断）。 */
/** 返回 {text, files}——files 为实际注入源的相对路径清单
 *  （铁律①「模型可见⟺已记录」；角色卡按目录登记，与 rules 词表同口径） */
function buildMineContext(bookRoot: string): { text: string; files: string[] } {
  const parts: string[] = []
  const files: string[] = []
  // 名册
  const rosterPath = join(bookRoot, '设定', '名册.md')
  if (existsSync(rosterPath)) {
    const t = readFileSync(rosterPath, 'utf8').trim()
    if (t) {
      parts.push(`## 角色名册\n${t}`)
      files.push('设定/名册.md')
    }
  }
  // 角色卡摘要（姓名/身份/目标/关系 + 正文前 300 字）
  const chars = readCharacterCards(join(bookRoot, '设定', '角色'), bookRoot)
  if (chars.length) {
    files.push('设定/角色')
    parts.push(
      '## 角色卡',
      chars
        .map((c) => {
          const meta = [c.身份, c.目标].filter(Boolean).join('/')
          const body = c.正文.replace(/\s+/g, ' ').slice(0, 300)
          return `### ${c.姓名}${meta ? `(${meta})` : ''}\n${body}${c.正文.length > 300 ? '…' : ''}`
        })
        .join('\n\n'),
    )
  }
  // 已写正文节选（正文目录，每章前 200 字，最多 8 章）
  const proseDir = join(bookRoot, '写作', '正文')
  if (existsSync(proseDir)) {
    const mdFiles = listMdRecursive(proseDir).slice(0, 8)
    if (mdFiles.length) {
      const excerpts = mdFiles.map((f) => {
        const rel = relative(bookRoot, f).replace(/\\/g, '/') // -数据层： 收口漏点（展示口径统一正斜杠）
        const t = readFileSync(f, 'utf8').replace(/^---[\s\S]*?---/, '').replace(/\s+/g, ' ').trim().slice(0, 200)
        files.push(rel)
        return `### ${rel}\n${t}`
      })
      parts.push('## 已写正文节选\n' + excerpts.join('\n\n'))
    }
  }
  return { text: parts.join('\n\n'), files }
}

/** 递归列出 md 文件（排序稳定）。 */
function listMdRecursive(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir, { recursive: true })) {
    if (typeof f !== 'string') continue
    // .md 判定收敛 isMdFileName（大小写不敏感）；`._` 前缀跳过不变
    // （评审）：recursive readdir 条目含子目录前缀（如 `卷一/._001.md`）——
    // startsWith 只拦顶层，嵌套 AppleDouble 文件漏拦，污染 countChapters 与
    // relations.mine 的正文节选（拼 AI prompt）。改段级判定：任一路径段以 `._`
    // 开头即过滤（win/posix 分隔符都顾）；扁平条目单段，与 overview.ts 等扁平版
    // startsWith 过滤行为逐项一致。
    if (!isMdFileName(f) || f.split(/[\\/]/).some((seg) => seg.startsWith('._'))) continue
    const fp = join(dir, f)
    if (existsSync(fp)) out.push(fp)
  }
  out.sort()
  return out
}

/** 统计正文章节数（写作/正文/ 下的 .md 文件数，用于关系缓存新鲜度判断）。 */
function countChapters(bookRoot: string): number {
  const proseDir = join(bookRoot, '写作', '正文')
  if (!existsSync(proseDir)) return 0
  return listMdRecursive(proseDir).length
}

/** 解析角色卡「关系」字段 → 关系边：「林远(师徒);赵衡(仇敌)」→ [{to:林远,type:师徒}]（#7.5） */
export function parseRelations(raw: string): { to: string; type: string }[] {
  if (!raw) return []
  const out: { to: string; type: string }[] = []
  for (const part of raw.split(/[;；,，]/)) {
    const seg = part.trim()
    if (!seg) continue
    // 新格式「对象=类型」(等号,无歧义) 优先；旧格式「对象(类型)」(括号,兼容历史数据)
    const m = seg.match(/^(.+?)=(.+)$/) ?? seg.match(/^(.+?)[(（](.+?)[)）]$/)
    if (m) out.push({ to: m[1]!.trim(), type: m[2]!.trim() })
  }
  return out
}

/** 关系类型规范表：关键词 → 标准短语（关系图标签用）。
 *  角色卡「关系」是自由文本，写法因书因人而异（师/师父/师徒/授业…）；
 *  此表把常见简写/同义词统一到完整短语，避免标签过简、换书也一致。
 *  按顺序匹配，先命中先用；都不中 → 保留原文（「暗棋」「血契」等自定义关系原样显示）。
 *  扩展：新别名补进对应类的正则即可。详见 Dev/Main/Plans/关系类型规范.md。 */
const RELATION_NORM: { label: string; test: RegExp }[] = [
  { label: '仇敌', test: /敌|仇|恨|怨/ },
  { label: '主仆', test: /主|仆|属|臣|奴|侍|麾下/ },
  { label: '师徒', test: /师|徒|弟子|传人|授业|同门/ },
  { label: '恋人', test: /恋|情人|爱人|红颜|相思/ },
  { label: '夫妻', test: /妻|夫|婚|配偶|嫁|娶|妾/ },
  { label: '手足', test: /兄|弟|姐|妹|同胞|手足/ },
  { label: '亲子', test: /父|母|爹|娘|双亲|亲子/ },
  { label: '挚友', test: /友|知交|故交|知己/ },
  { label: '同僚', test: /同僚|同袍|搭档|伙伴|战友|同窗/ },
]

/** 规范化关系类型（自由文本 → 标准短语）；无匹配则保留原文。 */
export function normalizeRelationType(raw: string): string {
  const t = raw.trim()
  for (const r of RELATION_NORM) if (r.test.test(t)) return r.label
  return t
}

/** 自由 MD 卡片扫描(时间线用):标题（首行 # 或文件名）+ 摘要（正文前 120 字） */
function scanFreeMd(dirPath: string): { 标题: string; 摘要: string }[] {
  const out: { 标题: string; 摘要: string }[] = []
  if (!existsSync(dirPath)) return out
  let files: string[]
  try {
    // .md 判定收敛 isMdFileName（大小写不敏感）；`._` 前缀跳过不变
    files = readdirSync(dirPath).filter((f) => isMdFileName(f) && !f.startsWith('._'))
  } catch {
    return out
  }
  for (const f of files) {
    out.push(readFreeMd(join(dirPath, f)))
  }
  return out
}

function readFreeMd(filePath: string): { 标题: string; 摘要: string } {
  let text = ''
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    // 剥尾走 mdStem（大小写不敏感，.MD 兜底标题不再带扩展名）
    return { 标题: mdStem(filePath), 摘要: '' }
  }
  const m = text.match(/^#\s+(.+)$/m)
  // 剥尾走 mdStem（大小写不敏感，.MD 兜底标题不再带扩展名）
  const 标题 = m ? m[1]!.trim() : mdStem(filePath)
  const body = text.replace(/^#[^\n]*\n?/m, '').trim()
  const 摘要 = body.slice(0, 120).trim()
  return { 标题, 摘要 }
}
