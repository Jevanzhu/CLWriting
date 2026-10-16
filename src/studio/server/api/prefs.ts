/**
 * 偏好端点：
 *
 * 书级布局（.clwriting/prefs.json，跟随书）：
 *   GET  /api/books/:name/prefs             → { prefs: BookPrefs, revision }
 *   PUT  /api/books/:name/prefs  body {prefs, expectedRevision?}
 *                                          → 写 .clwriting/prefs.json → {ok, revision}
 *
 * 全局编辑器偏好（userData/global.json，APP 级，跨书库共享）：
 *   GET  /api/library/prefs                 → { prefs: GlobalPrefs, revision }
 *   PUT  /api/library/prefs    body {prefs, expectedRevision?}
 *                                          → 写 userData/global.json → {ok, revision}
 *
 * 乐观并发（照 providers.ts 模式）：文件内嵌服务端管理的保留键 revision（存量文件无该键视为 0，
 * 每次 PUT +1）；写端点带可选 expectedRevision 比对，失配回 409（REVISION_CONFLICT），不带则
 * 放行（旧客户端/脚本向后兼容）。无守卫时两个面板同时保存会后写静默覆盖先写。其余读 global.json
 * 的模块（global-defaults / 快照保留策略 / rag 配置）按键读取，忽略 revision 保留键。
 * 书级 prefs.json 同款守卫（revision 保留键 + revisionError + 409 + GET 从 prefs 剥离单独回传）；
 * 当前唯一客户端（web 前端 workspace 保存链）尚未带 expectedRevision——守卫契约先收口，前端接线
 * 后即生效。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, dirname } from 'node:path'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { acquireCrossProcessLockAsync } from '../../../fs/cross-process-lock.js'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { revisionError } from './revision-guard.js' // 三处拷贝收敛单源（原本地实现）
import { resolveBook, bookMovedFailure } from '../book-context.js'
import { log } from '../../../log/index.js'

export interface BookPrefs {
  /** 可覆盖全局编辑器偏好 */
  pageWidth?: number
  autosaveInterval?: number
  /** 工作区布局（纯书库） */
  leftWidth?: number
  leftOpen?: boolean
  rightOpen?: boolean
  leftPanel?: string
  activeDocId?: string | null
  treeExpanded?: string[]
  [k: string]: unknown
}

interface PrefsCtx {
  workDir: string | null
  /** APP 级数据目录（Electron userData / CLI 模式跨平台约定路径） */
  userDataPath: string | null
}

/** 全局偏好写锁等待超时（毫秒）——写段为本地文件 IO 级毫秒，5s 极保守（同 providers 锁档） */
const GLOBAL_PREFS_WRITE_LOCK_TIMEOUT_MS = 5_000

/** 书级偏好写锁等待超时（毫秒）——同全局档预算（写段同为本地文件 IO 级毫秒） */
const BOOK_PREFS_WRITE_LOCK_TIMEOUT_MS = 5_000

// ── 写入面键白名单 + 值类型校验（两端点同源）────────────────────
// 背景：原实现把 payload 的任意键与任意 JSON 值直接 {...disk, ...prefs} 合并落盘——
// prefs.json / global.json 是「按名读键」的共享配置文件（版本保留策略、全局书级托底链、
// 预算两键、前端 PREF_ROWS 34 键都按名消费），任意键/任意值入库 = 单次请求即可写花配置面
//（此后 GET 还会原样回显脏值，只能靠各读侧的容错兜底）。
// 现收口为两段（对齐 config.ts numericChecks 的 fail-loud 口径）：
// - 白名单内键：粗粒度类型校验，不符 → 400 BAD_INPUT（`prefs.<键> 类型不符`）；
// - 白名单外键：丢弃不落盘 + log.warn 留痕，响应语义不变（200 {ok,revision}）。为何不是 400：
//   ① payload 里本就会混入服务端保留键与调用方自有键（前端全量回传、测试面任意键、
//      revision 保留键），400 会让整次保存失败——「丢未知键」比「丢整次保存」安全；
//   ② 白名单是防写花的收敛面，不是收窄契约面（预算是按名读，未知键在盘上本无消费方）。
// 只做粗粒度类型（不做值域/枚举）：值域与夹取窗在前端 PREF_ROWS（手改脏值由前端守卫
// 与读侧容错两层兜底），服务端收紧到值域会让旧客户端/扩展值（如手写 theme:'sepia'）
// 整次保存失败——超出「写侧收敛」的正当范围。
const isStr = (v: unknown): boolean => typeof v === 'string'
const isNum = (v: unknown): boolean => typeof v === 'number'
const isBool = (v: unknown): boolean => typeof v === 'boolean'
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === 'string'
const isStrArr = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string')
const isNumOrNull = (v: unknown): boolean => v === null || typeof v === 'number'

/** 书级 .clwriting/prefs.json 白名单 —— 对照前端 stores/workspace.ts 写面 8 键（BookPrefs 全字段）。 */
const BOOK_PREF_TYPES: Readonly<Record<string, (v: unknown) => boolean>> = {
  // 书级覆盖两键的 null = 显式声明「本书无覆盖」（前端设置面「关」即写 null，见
  // NULL_DELETE_KEYS）；其余键的 null 是有效值（activeDocId 无打开文档即 null）。
  pageWidth: isNumOrNull,
  autosaveInterval: isNumOrNull,
  leftWidth: isNum,
  leftOpen: isBool,
  rightOpen: isBool,
  leftPanel: isStr,
  activeDocId: isStrOrNull,
  treeExpanded: isStrArr,
}

/** 载荷里 null 按「删键」处理的键（书级覆盖语义）：这两键无覆盖是「键不存在」而非
 *  「值 null」——合并写（`{...disk, ...prefs}`）保留盘上旧键，一旦不删，作者关掉覆盖后
 *  重进本书旧键复活（界面又回覆盖值）。删键后读侧 posNum(undefined) → 跟随全局默认。 */
const NULL_DELETE_KEYS: ReadonlySet<string> = new Set(['pageWidth', 'autosaveInterval'])

/** 全局 userData/global.json 白名单 —— 前端 stores/prefs.ts PREF_ROWS 34 键（落盘名）
 *  + 预算两键（global-defaults 读侧消费的 tokensPerChapter/costPerChapter）。 */
const GLOBAL_PREF_TYPES: Readonly<Record<string, (v: unknown) => boolean>> = {
  // 外观 + 全局编辑器偏好
  theme: isStr,
  proseSize: isNum,
  proseLh: isNum,
  uiFontCn: isStr,
  uiFontEn: isStr,
  uiFontSizeStep: isNum,
  proseFontCn: isStr,
  proseFontEn: isStr,
  pageWidth: isNum,
  autosaveInterval: isNum,
  shelfView: isStr,
  chatEnabled: isBool,
  compact: isBool,
  // 版本保留全局默认
  snapMaxDays: isNum,
  snapMaxCount: isNum,
  // 书级设定全局托底 14 键
  defaultGenre: isStr,
  defaultVolumeSize: isNum,
  defaultTargetWords: isNum,
  defaultChapterTargetWords: isNum,
  defaultShortStrict: isBool,
  styleInjection: isStr,
  autoConfirmOutline: isBool,
  autoBatchSize: isNum,
  callsPerChapter: isNum,
  relationAutoMine: isBool,
  relationMineThreshold: isNum,
  ragEnabled: isBool,
  ragProvider: isStr,
  // 知识层方法参考注入全局默认（书级 auto.knowledge_injection 未设才托底）
  knowledgeInjection: isBool,
  // 机检阈值五键
  checkRepeatThreshold: isNum,
  checkRepeatCharsThreshold: isNum,
  checkMaxSentenceLen: isNum,
  checkImageryThreshold: isNum,
  checkWordCountTolerance: isNum,
  // 预算两键（按文档由脚本/手工写盘；端点同收——白名单外一律丢弃会让「经端点写预算」静默失效）
  tokensPerChapter: isNum,
  costPerChapter: isNum,
}

/** 白名单过筛：白名单内键留原值（类型不符即抛，调用方转 400）、白名单外键丢弃并留痕。
 *  调用方两形态：parse 段（library.prefs.put，抛错 → defineRoute 400 信封）与 handler
 *  内联段（books.prefs.put，readJson 迁移留而不迁，见该端点注）——两处 400 文案同源。 */
function filterPrefPayload(
  payload: Record<string, unknown>,
  types: Readonly<Record<string, (v: unknown) => boolean>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(payload)) {
    const guard = types[k]
    if (!guard) {
      dropped.push(k)
      continue
    }
    if (!guard(v)) throw new Error(`prefs.${k} 类型不符`)
    // 键已在白名单内（固定字面量集）→ 不存在把 __proto__ 写成原型键的注入面
    out[k] = v
  }
  if (dropped.length > 0) {
    log.warn('api', `prefs 写入丢弃白名单外键（不落盘）：${dropped.join(', ')}`)
  }
  return out
}

export function registerPrefsRoutes(ctx: PrefsCtx): void {
  /** 解析书库的 .clwriting/prefs.json 路径（找书走公共 resolveBook，error 带机器码；
   *  ok 分支带回 bookRoot——PUT 侧写前重验要用入口快照做比对） */
  function prefsPath(
    name: string,
  ): { ok: true; path: string; bookRoot: string } | { ok: false; code: number; errCode: string; error: string } {
    const r = resolveBook(ctx.workDir, name)
    if ('error' in r) return { ok: false, code: r.status, errCode: r.code, error: r.error }
    return { ok: true, path: join(r.bookRoot, '.clwriting', 'prefs.json'), bookRoot: r.bookRoot }
  }

  defineRoute('books.prefs.get', {
    method: 'GET',
    path: '/api/books/:name/prefs',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = prefsPath(params['name']!)
      if (!r.ok) return replyError(res, r.code, r.errCode, r.error)
      if (!existsSync(r.path)) return reply(res, 200, { prefs: {}, revision: 0 })
      try {
        const parsed: unknown = JSON.parse(readFileSync(r.path, 'utf8'))
        // L-S1GET 侧形状校验——PUT 侧已防（坏形状不再扩散），此处对齐：
        // 数组/标量损坏形状原先裸 as 直接回显出网一轮，现回空对象
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reply(res, 200, { prefs: {}, revision: 0 })
        }
        // revision 是服务端管理的保留键——从 prefs 剥离单独回传（不混入布局语义），
        // 供客户端下次 PUT 带 expectedRevision；存量文件无该键视为 0（对齐全局 prefs 口径）
        const raw = parsed as Record<string, unknown>
        const { revision, ...prefs } = raw
        reply(res, 200, { prefs: prefs as BookPrefs, revision: typeof revision === 'number' ? revision : 0 })
      } catch {
        reply(res, 200, { prefs: {}, revision: 0 })
      }
    },
  })

  defineRoute('books.prefs.put', {
    method: 'PUT',
    path: '/api/books/:name/prefs',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = prefsPath(params['name']!)
      if (!r.ok) return replyError(res, r.code, r.errCode, r.error)
      // defineRoute parse 迁移跳过：校验顺序依赖前置门，parse 化会翻转错误优先级
      //（直调 handler 悬持 body 于 readJson——入口快照→窗口→bookMoved 409 判序被钉）
      const body = await readJson(req)
      const prefsRaw = body['prefs']
      if (!prefsRaw || typeof prefsRaw !== 'object' || Array.isArray(prefsRaw))
        return replyError(res, 400, 'BAD_INPUT', 'prefs 必填且须为对象')
      // 白名单过筛——类型不符 400（前置门之后，与 config.ts numericChecks 同段位）
      let prefs: Record<string, unknown>
      try {
        prefs = filterPrefPayload(prefsRaw as Record<string, unknown>, BOOK_PREF_TYPES)
      } catch (e) {
        return replyError(res, 400, 'BAD_INPUT', e instanceof Error ? e.message : 'prefs 类型不符')
      }
      // （服务端端点/摘要簇）：readJson 窗口后写前重验书注册
      //（时序见 bookMovedFailure 头注）；family：config 同款——此前窗口跨越
      // 删书/改名后，mkdirSync recursive 重建无 book.yaml 幽灵目录 + 布局偏好静默写旧路径
      const moved = bookMovedFailure(ctx.workDir, params['name'], r.bookRoot)
      if (moved) return replyError(res, 409, moved.code, moved.reason)
      // 书级 prefs.json 同为跨进程共享可写面（同书多窗口/CLI 进程并发 PUT）：读盘→合并
      // →写盘三段只保「单进程内原子」，跨进程仍是 TOCTOU——两侧各按自己读到的盘面合并落盘，
      // 一方键静默丢失（revision 乐观锁管用户可见冲突，丢更新由锁兜；与全局档同构）。
      // 取锁排在书注册重验之后：取锁会 mkdirSync 派生目录，先取锁会在已删书上重建幽灵目录。
      const release = await acquireCrossProcessLockAsync(`${r.path}.lock`, BOOK_PREFS_WRITE_LOCK_TIMEOUT_MS)
      if (!release) {
        log.error('api', `写书级偏好获取跨进程锁超时（其他窗口长期占用）：${r.path}`)
        return replyError(res, 500, 'IO_ERROR', '本书偏好正被其他窗口写入，请稍后重试')
      }
      try {
        // 低级项：合并写（对齐 library.prefs.put 口径）——prefs.json 同样
        // 可能存在端点 payload 之外的使用方（手工/脚本写入的键），整体覆写会静默清键。
        // 盘上键 ← 客户端键覆盖；无删键场景（前端已知键全量回传）。读盘→合并→写盘
        // 三段在锁内同步无 await——盘面在锁内重读，跨进程串行由锁保证
        let disk: Record<string, unknown> = {}
        if (existsSync(r.path)) {
          try {
            // 服务端：形状校验——prefs.json 内容为数组/字符串/数字（损坏或
            // 误写）时，{...disk, ...prefs} 会把索引键/字符位混入写回（损坏扩散一轮）
            const parsed: unknown = JSON.parse(readFileSync(r.path, 'utf8'))
            disk =
              parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
          } catch {
            /* 文件损坏视作空：revision 0，本次整体重写（与原直写行为一致） */
          }
        }
        // 内容版本乐观锁——revision 保留键（存量无 → 0，每次 PUT +1）比对
        // expectedRevision（可选，缺失直通向后兼容），失配 409 — 参照全局 prefs 409 链
        const current = typeof disk.revision === 'number' ? disk.revision : 0
        const revErr = revisionError(body['expectedRevision'], current, '本书布局')
        if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
        const next = current + 1
        mkdirSync(dirname(r.path), { recursive: true })
        // revision 由服务端计算覆盖（客户端传入的同名键不采信），随布局一起落盘。
        // 覆盖两键的显式 null 走删键（见 NULL_DELETE_KEYS）——合并写保不删旧键，
        // 会把「已关掉的书级覆盖」原样留在盘上。
        const merged: Record<string, unknown> = { ...disk, ...prefs }
        for (const k of NULL_DELETE_KEYS) if (prefs[k] === null) delete merged[k]
        atomicWriteFile(r.path, JSON.stringify({ ...merged, revision: next }, null, 2) + '\n')
        reply(res, 200, { ok: true, revision: next })
      } catch (e) {
        log.error('api', '写 prefs 失败', e)
        replyError(res, 500, 'IO_ERROR', '写 prefs 失败')
      } finally {
        release()
      }
    },
  })

  // ── 全局编辑器偏好（userData/global.json，APP 级）──
  // 跨书库共享的外观设置（主题/字体/字号/行距/纸张宽度/自动保存）。
  // 放在 APP 数据目录（非书库目录），切书库不受影响。

  function globalPath(): { ok: true; path: string } | { ok: false; code: number; errCode: string; error: string } {
    if (!ctx.userDataPath) return { ok: false, code: 400, errCode: 'NO_USERDATA', error: '未定位到应用数据目录' }
    return { ok: true, path: join(ctx.userDataPath, 'global.json') }
  }

  defineRoute('library.prefs.get', {
    method: 'GET',
    path: '/api/library/prefs',
    handler: (_, _req: IncomingMessage, res: ServerResponse) => {
      const r = globalPath()
      if (!r.ok) return replyError(res, r.code, r.errCode, r.error)
      if (!existsSync(r.path)) return reply(res, 200, { prefs: {}, revision: 0 })
      try {
        const parsed: unknown = JSON.parse(readFileSync(r.path, 'utf8'))
        // L-S1GET 侧形状校验——数组形状解构会把索引键 {"0":..} 混进 prefs 回传
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reply(res, 200, { prefs: {}, revision: 0 })
        }
        const raw = parsed as Record<string, unknown>
        // revision 是服务端管理的保留键——从 prefs 剥离后单独回传（不混入偏好语义），
        // 供前端下次 PUT 带 expectedRevision；存量文件无该键视为 0
        const { revision, ...prefs } = raw
        reply(res, 200, { prefs, revision: typeof revision === 'number' ? revision : 0 })
      } catch {
        reply(res, 200, { prefs: {}, revision: 0 })
      }
    },
  })

  // body 形状校验迁 parse——400 BAD_INPUT 信封与
  // 原内联路径逐字节同源；唯一前置 globalPath（NO_USERDATA）无测试钉先后序（cliReq
  // 用例 body 合法仍落 NO_USERDATA），照 chat.send 先例迁移。
  // 键白名单 + 值类型校验随 parse 前置（与书级端点同段位——类型不符 400 先于
  // 锁/revision 前置门；既有测试面 payload 键合法，优先级无回归）。
  defineRoute('library.prefs.put', {
    method: 'PUT',
    path: '/api/library/prefs',
    parse: (raw) => {
      const body = (raw ?? {}) as Record<string, unknown>
      const prefs = body['prefs']
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw new Error('prefs 必填且须为对象')
      return {
        prefs: filterPrefPayload(prefs as Record<string, unknown>, GLOBAL_PREF_TYPES),
        expectedRevision: body['expectedRevision'],
      }
    },
    handler: async ({ input }, _req, res) => {
      const r = globalPath()
      if (!r.ok) return replyError(res, r.code, r.errCode, r.error)
      // 多库多窗：global.json 在共享根，同机多实例（各库一进程）可并发 PUT——
      // 原「单事件循环内原子」只保同进程，跨进程 TOCTOU 会丢更新（两侧同读 rev N、
      // 同写 rev N+1，且不报 409）。补跨进程锁：锁内重读盘面 → revision 比对 → 写
      //（读盘/比对/写盘三段仍同步无 await）；revision 乐观锁管用户可见冲突、锁管
      // 丢更新，两闸互补（providers.json 先例）。
      const release = await acquireCrossProcessLockAsync(`${r.path}.lock`, GLOBAL_PREFS_WRITE_LOCK_TIMEOUT_MS)
      if (!release) {
        log.error('api', `写全局偏好获取跨进程锁超时（其他窗口长期占用）：${r.path}`)
        return replyError(res, 500, 'IO_ERROR', '全局偏好正被其他窗口写入，请稍后重试')
      }
      try {
        let disk: Record<string, unknown> = {}
        if (existsSync(r.path)) {
          try {
            // 服务端：形状校验（与 books.prefs.put 同款）——数组/标量损坏内容
            // 不混入合并写
            const parsed: unknown = JSON.parse(readFileSync(r.path, 'utf8'))
            disk =
              parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
          } catch {
            /* 文件损坏视作空：revision 0，本次整体重写（与原直写行为一致） */
          }
        }
        const current = typeof disk.revision === 'number' ? disk.revision : 0
        const revErr = revisionError(input.expectedRevision, current, '全局偏好')
        if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
        const next = current + 1
        mkdirSync(dirname(r.path), { recursive: true })
        // revision 由服务端计算覆盖（客户端传入的同名键不采信），随偏好一起落盘。
        // 合并写——global.json 存在前端 payload 之外的使用方（按文档手工/脚本
        // 写入的 tokensPerChapter/costPerChapter 预算键等）。整体覆写会让任何一次面板
        // 保存（500ms debounce）静默清掉这些键、预算闸随之失效。盘上键 ← 客户端键覆盖；
        // 客户端无法经此端点显式删键是可接受代价（前端已知键全量回传，无删键场景）。
        atomicWriteFile(r.path, JSON.stringify({ ...disk, ...input.prefs, revision: next }, null, 2) + '\n')
        reply(res, 200, { ok: true, revision: next })
      } catch (e) {
        log.error('api', '写全局偏好失败', e)
        // 错误码与书级 prefs 写失败（125）统一 IO_ERROR——同一
        // 失败形态（落盘 IO 异常）双端点码面漂移（全局 ERROR / 书级 IO_ERROR）使前端
        // 按码分类的降级/提示路径分叉
        replyError(res, 500, 'IO_ERROR', '写全局偏好失败')
      } finally {
        release()
      }
    },
  })
}
