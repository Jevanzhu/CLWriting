/**
 * 书架 + 单书 + 建书 REST 端点（#12.3 + 5.1）。
 *
 * - GET  /api/books          书架列表（读 books.jsonl）
 * - POST /api/books          建书（doInit；1.5 段 1 表单）
 * - GET  /api/books/:name    单书身份（读该书 book.yaml，含 host）
 * - GET  /api/boot           启动初始态（--book 直进支持）
 *
 * workDir 由 server 启动时 findWorkDir(cwd) 注入；为 null 时书架空 + 提示（不崩）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { rmSync, renameSync, existsSync, readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveWithinRoot } from '../../../fs/safe-path.js'
import {
  readBooks,
  readBooksStrict,
  removeBookEntry,
  bookStoragePath,
  readActive,
  writeActive,
  writeBooks,
  isInvalidBookName,
  tryBooksLock,
} from '../../../install/books.js'
import { resolveBook } from '../book-context.js'
import { forgetService, drainDocumentSaves } from './documents.js'
import { drainFilePutChainsUnder } from './files.js'
import { forgetSession } from '../../../driver/index.js'
import { invalidateTreeIndex } from '../../../document/tree.js'
import { clearChatHistory, abortChat, isChatRunning, waitChatSettled } from '../../../ai/orchestrate/chat.js'
import { abortSelfHeal, isSelfHealRunning, waitSelfHealSettled } from '../../../ai/orchestrate/self-heal.js'
import { waitBackgroundTasks, hasBackgroundTasks } from '../../../ai/orchestrate/background.js'
import { readBookConfig, setTopSectionKey } from '../../../format/yaml.js'
import { clearChapterDirCacheForBook } from '../../../format/chapters.js'
import { stringifyValue } from '../../../format/frontmatter.js'
import { applyGlobalDefaults } from '../../../format/global-defaults.js'
import { doInit } from '../../../install/init.js'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { computeBookSummary, invalidateBookSummary } from './progress.js'
import { migrateBookSession, bookHash } from '../../../events/store.js'
import { heldTaskGatesFor, crossProcessHeldTaskGatesFor } from './task-gate.js'
import { isReviewRunningForBook } from './review.js'
import { forgetRagBuildTask } from './rag.js'
import { isSpawnRunning, forgetSseCount } from './stream.js'
// R67-15（十五轮）：四个书键 TTL 结果缓存（体检扫描/概览态/风格语料/learn 候选）的
// 失效挂点——删书/改名正向清理，TTL 5s 退为兜底自愈
import { forgetStyleScanCache } from './health.js'
import { forgetOverviewCache } from './overview.js'
import { forgetStyleCorpusCache } from './analysis.js'
import { forgetLearnCache } from './knowledge.js'
// R75-D-P3b（批 D）：/state 与 /tree-issues 两个书键 TTL 结果缓存同挂点收编
import { forgetStateCache } from './state.js'
import { forgetTreeIssuesCache } from './check.js'
import { log } from '../../../log/index.js'

/** R67-15：删书/改名共用的书键缓存清理（TTL 结果缓存四件——内存卫生，防删书后
 *  5s 内残留概览/体检数据被同名重建书读到）。 */
function forgetBookKeyedCaches(bookRoot: string): void {
  forgetStyleScanCache(bookRoot)
  forgetOverviewCache(bookRoot)
  forgetStyleCorpusCache(bookRoot)
  forgetLearnCache(bookRoot)
  // R75-D-P3b：判态/树红点缓存同族清理
  forgetStateCache(bookRoot)
  forgetTreeIssuesCache(bookRoot)
}

interface BookCtx {
  workDir: string | null
  /** session token(P0 defense-in-depth,boot 注入前端,写端点校验) */
  token: string
  /** RB-SV-P1-1：Origin 是否可信（同源或 dev 白名单）——boot 据此决定是否回传 token */
  isTrustedOrigin: (origin: string) => boolean
  /** APP 级数据目录（Electron userData / CLI 模式跨平台约定路径）——事件库迁移用 */
  userDataPath: string | null
  /** A4（批 0）：启动通告投递口——事件库迁移失败等请求期故障进 App 级横幅（可选，
   *  兼容既有调用方；缺失时仅日志留痕） */
  onStartupNotice?: (kind: string, message: string) => void
}

let initialBook: string | undefined

/** #7：等被 abort 的在途编排（chat / self-heal / M-2 后台任务）真正收尾。abort 只是异步
 * 信号——straggler 编排要跑到下一个 await 点才解旋，其收尾写库/flush 若在关库或目录搬移
 * 之后恢复，会抛「连接未打开」或对已删/已搬路径重建孤儿目录。上限 10s：等待是尽善，
 * 挂死编排不应阻塞删/改请求（超时后行为同旧版，事件库启动修复兜底）。
 * M-2：补 waitBackgroundTasks——定稿章摘要/账本草稿等 fire-and-forget 后台任务同样
 * 有对书根落盘的收尾窗口（无 abort 句柄，只能等或超时放行）。 */
async function awaitOrchestrationsSettled(name: string): Promise<void> {
  await Promise.race([
    Promise.all([waitChatSettled(name), waitSelfHealSettled(name), waitBackgroundTasks(name)]),
    new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref()), // R62-41：兜底定时器 unref——不再因等待中的备选定时器拖延进程退出
  ])
}

/** M-4：spawn/三审/task-gate 三闸联合检查——任一在途返回 BUSY 文案（否则 null）。
 * 各闸背景：ee-P2-11 /spawn 手动写稿分钟级且持 bookRoot 闭包（收尾落盘写旧路径重建
 * 孤儿目录）；hh-P1 三审同为分钟级长任务；dd-P2 task-gate（analyze/rewrite/rag-build
 * 等）无 abort 通道——三者持闸时都只能拒删/拒改（409），白烧 API 费用同理。 */
function busyGate(name: string, verb: '删' | '改名'): { error: string } | null {
  if (isSpawnRunning(name)) return { error: `本书正在生成（手动写稿），先等它完成或中断后再${verb}` }
  if (isReviewRunningForBook(name)) return { error: `本书三审进行中，先等它完成后再${verb}` }
  // R75-5（批 D）：进程内 Set 与跨进程锁文件扫描合并去重——dev-api/脚本与 GUI 双进程
  // 并存时，此前只查 heldTaskGatesFor（进程内）看不见进程 A 的分钟级任务闸，放行删/改
  // 后任务收尾原子写在旧路径重建孤儿目录并白烧 API 费。跨进程侧陈锁（死 pid/超龄）由
  // 锁原语语义剔除，不算在持；本进程闸两侧都会报（锁文件也在），去重防文案双报。
  const held = [...new Set([...heldTaskGatesFor(name), ...crossProcessHeldTaskGatesFor(name)])]
  if (held.length > 0) return { error: `本书有任务在跑（${held.join('、')}），先等它完成或稍后再${verb}` }
  return null
}

export function registerBookRoutes(ctx: BookCtx): void {
  // 书架列表
  defineRoute('books.get', {
    method: 'GET',
    path: '/api/books',
    handler: (_, _req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) {
      reply(res, 200, {
        books: [],
        workDir: false,
        hint: '当前目录不是 CLWriting 工作目录。请在工作目录（含 .clwriting/）下启动 studio。',
      })
      return
    }
    // 书架卡补摘要：title / 进度(N 章/字数) / 最近编辑。单本损坏不崩整列（摘要降级缺省）。
    // R33-69（三十三轮）：entry.path 过 resolveWithinRoot——readBooks 已拒 `..`/绝对
    // 路径，此处补与删/改路径同强度的越界/symlink 校验（校验强度对称化）；不合法条目
    // 按损坏标记降级（不崩整列）。
    const books = readBooks(ctx.workDir).map((b) => {
      const within = resolveWithinRoot(ctx.workDir!, b.path)
      if (!within) return { ...b, damaged: true, createdAt: b.created_at }
      const bookRoot = within.abs
      try {
        const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
        // 低-3（第十轮）：book.yaml 损坏/缺失显式标 damaged——readBookConfig 容错不抛，
        // 此前回落默认骨架的空 title 混进列表装作正常书，与单书端点 500 口径分叉
        //（第九轮 L-1 只修了单书侧）。前端按 damaged 展示可后续轮次接线
        if (!cfgResult.ok) return { ...b, damaged: true, createdAt: b.created_at }
        const { config } = cfgResult
        // P2-BE-1：一次扫描算出进度+最近编辑+最新章节（消除三重 readChapterDir）。
        // 全局托底：targetWords 进度是喂运行时的有效值——书级未设回落 global.json
        // defaultTargetWords（无回落键，global 没有则保持未设 → 前端不显示完成度）
        const effective = applyGlobalDefaults(config, ctx.userDataPath)
        const summary = computeBookSummary(bookRoot)
        return {
          ...b,
          title: effective.book.title,
          chapters: summary.chapters,
          words: summary.words,
          lastEdited: summary.lastEdited,
          targetWords: effective.book.target_words,
          latestChapter: summary.latestChapter,
          createdAt: b.created_at,
        }
      } catch {
        // 书仓库损坏/缺 book.yaml：保留登记原样 + 显式损坏标记（前端容错）
        return { ...b, damaged: true, createdAt: b.created_at }
      }
    })
    reply(res, 200, { books, workDir: true })
  },
  })

  // 建书（1.5 段 1 表单 → doInit）
  defineRoute('books.post', {
    method: 'POST',
    path: '/api/books',
    handler: async (_, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) {
      replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录，无法建书')
      return
    }
    const body = (await readJson(req)) as {
      name?: unknown
      genre?: unknown
      kind?: unknown
      leads?: unknown
      host?: unknown
      targetWords?: unknown
      brief?: unknown
    }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      replyError(res, 400, 'BAD_INPUT', '书名不能为空')
      return
    }
    // P2-27：书名校验与 doInit 逻辑层共用单一真相源（isInvalidBookName）——防 `../` 越出 workDir
    if (isInvalidBookName(name)) {
      replyError(res, 400, 'BAD_PATH', '书名不能包含路径分隔符或特殊路径段（/ \\ . ..）')
      return
    }
    const genre = typeof body.genre === 'string' ? body.genre.trim() : ''
    const kind = body.kind === 'short' ? 'short' : 'long'
    const leads = Array.isArray(body.leads)
      ? body.leads.filter((x): x is string => typeof x === 'string')
      : undefined
    const host = body.host === 'codex' ? 'codex' : 'cc'
    // 目标字数（可选，落 book.yaml target_words，总览页算完成度）
    const targetWords =
      typeof body.targetWords === 'number' && Number.isFinite(body.targetWords) && body.targetWords > 0
        ? body.targetWords
        : undefined
    // 简介（可选，落 简介.md）
    const brief = typeof body.brief === 'string' ? body.brief.trim() : undefined
    const result = doInit({
      workDir: ctx.workDir,
      name,
      genre: genre || undefined,
      leads,
      kind,
      host,
      targetWords,
      brief,
    })
    if (!result.ok) {
      replyError(res, 400, 'BAD_INPUT', result.reason)
      return
    }
    reply(res, 200, { name: result.bookName, kind, path: result.bookPath })
  },
  })

  // R73-34（二十一轮 D-1）：删书墓地——workDir 根下点前缀目录（与 .journal/.旧版 同族，
  // 书架扫描与启动 repair 不触达），同盘 rename 保证原子性
  const DELETE_GRAVEYARD_DIR = '.删书墓地'

  // 删书（物理删除：rmSync 书目录 + 移 books.jsonl 登记 + 清 active 指针）
  defineRoute('books.delete', {
    method: 'DELETE',
    path: '/api/books/:name',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) {
      replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
      return
    }
    const name = params['name'] ?? ''
    const r = resolveBook(ctx.workDir, name)
    if ('error' in r) {
      replyError(res, r.status, r.code, r.error)
      return
    }
    const entry = r.entry
    // U-P2-7：先中断该书在途的 AI 编排（self-heal 批量写稿可长达十几分钟，
    // 不中断会在删除后继续落盘重建目录、白耗 API 费用）
    const hadSelfHeal = isSelfHealRunning(name)
    if (hadSelfHeal) abortSelfHeal(name)
    const hadChat = isChatRunning(name)
    if (hadChat) abortChat(name)
    // ee-P2-11 / hh-P1 / dd-P2：三闸联合检查（busyGate 集中各闸口径）
    const busy = busyGate(name, '删')
    if (busy) {
      return replyError(res, 409, 'BUSY', busy.error)
    }
    // #7：等被中断的编排收尾后再动磁盘/事件库——straggler 的 session/end 与链路
    // flush 落定后才 clearChatHistory，防「清完表又被 straggler 写回」（清不彻底）。
    // M-2 接线收口：后台任务须独立判定——定稿章摘要等 fire-and-forget 常发生在
    // 无 chat/self-heal 在途时（hadSelfHeal/hadChat 均 false），漏判会让摘要任务
    // 对已删路径重建孤儿目录
    if (hadSelfHeal || hadChat || hasBackgroundTasks(name)) await awaitOrchestrationsSettled(name)
    // 第五轮：drain 该书串行保存队列——在途 save 的收尾（journal+快照+fsync）若在
    // rmSync 之后恢复，会对已删路径 atomicWriteFile 重建孤儿文件（窗口毫秒级但真实）
    await drainDocumentSaves(join(ctx.workDir, entry.path))
    // R69-25（十七轮）：PUT /file 的 per-file 串行链同款 drain——临界段内 readFileHashed
    // 跨 rm 的 await 窗口理论上会重建目录（删除路径基线 ENOENT → 404 天然免疫，一并
    // drain 求同口径）
    await drainFilePutChainsUnder(join(ctx.workDir, entry.path))
    // M-4：闸后复查——settle 等待的 await 间隙里新 acquire 的闸（spawn/三审/task-gate）
    // 在此拦截；复检到 rmSync 之间全同步（单线程事件循环无新任务可插入），三闸 TOCTOU
    // 窗归零（chat/self-heal 在窗内新起的情形由 10s settle 超时降级兜底，与旧版一致）
    // R33-63（三十三轮）：复查补 hasBackgroundTasks——10s settle 窗口内新登记的
    // 后台摘要任务此前可绕过复查，对已删路径收尾写（对齐上方 settle 三条件口径）。
    const recheck = busyGate(name, '删') ?? (hasBackgroundTasks(name) ? { error: '本书后台任务进行中，请稍后再删' } : null)
    if (recheck) {
      return replyError(res, 409, 'BUSY', recheck.error)
    }
      // 删书目录（递归，含 git 历史）
      const bookAbs = join(ctx.workDir, entry.path)
      // symlink/越出校验：防 entry.path 中间组件是符号链接或 .. → rmSync 删到书库外。
      // 批 6 统一：resolveWithinRoot（防穿越 + symlink 双侧 realpath；书路径 = workDir 自身
      // 时 rel='' 同判非法）。realpath 失败（不存在/权限）→ null → 拒绝删除
      if (!resolveWithinRoot(ctx.workDir, entry.path)) {
        return replyError(res, 400, 'BAD_PATH', '书路径非法（越出书库）')
      }
      // R73-34（二十一轮 D-1）：裸 rmSync 中途抛错（占用/权限/磁盘满）会留下半删目录 +
      // 未清的 books.jsonl 登记（启动 repair 只兜底整目录缺失，半删态登记悬空且不可逆）。
      // 改先整体 rename 进删书墓地（同盘 rename 原子：成功即原位不存在半删态），墓地副本
      // 清理失败仅留痕不阻断——数据在墓地可手工恢复，登记照常移除（与作者删除意图一致）。
      const graveAbs = join(ctx.workDir, DELETE_GRAVEYARD_DIR, `${Date.now()}-${basename(entry.path)}`)
      try {
        mkdirSync(dirname(graveAbs), { recursive: true })
        renameSync(bookAbs, graveAbs)
      } catch (e) {
        log.error('api', `删书移入墓地失败（${name}，书原样保留）`, e)
        replyError(res, 500, 'IO', '删除书目录失败（书未受影响，可重试）')
        return
      }
      try {
        rmSync(graveAbs, { recursive: true, force: true })
      } catch (e) {
        log.error('api', `删书墓地清理失败（${name}，留档待手工处理：${graveAbs}）`, e)
      }
    // 移 books.jsonl 登记 + 清活动书指针
    removeBookEntry(ctx.workDir, name)
    // 清理 service 缓存，防同 path 重建复用旧实例
    forgetService(bookAbs)
    // P1-S2：清理 driver session + 树索引缓存，防删书后资源泄漏
    forgetSession(name)
    // R-18（第十六轮）：per-book SSE 计数一并清——残留计数会让同名重建书被顶到 429 上限
    forgetSseCount(name)
    // R67-15（十五轮）：书键 TTL 结果缓存一并清（见顶部 forgetBookKeyedCaches 注释）
    forgetBookKeyedCaches(bookAbs)
    // R69-24（十七轮）：书架摘要缓存一并清——rename 分支（:444）有 invalidateBookSummary，
    // delete 分支漏配：删后 5s TTL 窗口内同名重建书，书架卡会读到旧章数/字数/最近编辑
    invalidateBookSummary(bookAbs)
    invalidateTreeIndex(bookAbs, true)
    // 内存闸（2026-08-24 审计 C2）：章节元数据缓存按书前缀一并清——删书后目录已不在，
    // 每章元数据条目成死重（bookAbs 即各调用方 readChapterDir 键的 join 前缀）
    clearChapterDirCacheForBook(bookAbs)
    // GG-P2-3：事件库一并清（Y-P2-7 双键：book=书名 + book=bookHash(bookRoot)）——
    // 只清内存时事件库残留，同名重建书会在 audit 重放里继承旧书会话/链路事件。
    // L-S4（第八轮）：删除主流程已完成（登记已移、目录已删），清史收尾若抛（SQLITE_BUSY
    // 等）不该让客户端看到 500「内部错误」且跳过下方 db 文件清理留孤儿——防御性收编
    try {
      clearChatHistory(name, ctx.userDataPath ?? undefined, bookAbs)
    } catch (e) {
      // 低-6（第十轮）：留痕走项目 logger——console 在打包态 mirrorConsole=false 无人看见
      // 也不进 JSONL（诊断失明）；tag 与本文件 log.error 删除目录失败同源 'api'
      log.warn('api', `删书清史失败（${name}，残留 db 文件将由下方清理兜底）`, e)
    }
    // 二轮复审（低级）：事件库**文件**一并删（<hash>.db + WAL/SHM 伴生）——clearChatHistory
    // 只清行，库文件本体滞留 userData 成永久孤儿（每书一库）；settle 已保证无人持有句柄，
    // 清理失败不阻断删书（残留文件无读者）
    if (ctx.userDataPath) {
      const dbBase = join(ctx.userDataPath, 'clwriting', 'session', bookHash(bookAbs) + '.db')
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          rmSync(dbBase + suffix, { force: true })
        } catch {
          /* 单个伴生文件清理失败忽略 */
        }
      }
    }
    forgetRagBuildTask(name) // dd-P3：模块级索引任务表随删书清理
    reply(res, 200, { ok: true, name })
  },
  })

  // 改书名（全量同步：磁盘目录 + books.jsonl 登记 + active 指针 + book.yaml title 一起改，
  // 防「书名/文件夹/登记名」三分歧。body {name} = 新书名；校验复用建书净化规则。
  // E2：新路由走 defineRoute（input 形状 parse 声明，失败统一 400 {error} 信封）。
  defineRoute('book.rename', {
    method: 'POST',
    path: '/api/books/:name/rename',
    parse: (raw) => {
      const body = (raw ?? {}) as Record<string, unknown>
      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      // dd-P3：书名校验复用单一真相源（isInvalidBookName，与建书/删书同源）——
      // 此前内联复制规则，两处将来会漂移
      if (!name) throw new Error('书名不能为空')
      if (isInvalidBookName(name)) {
        throw new Error('书名不能包含路径分隔符或特殊路径段（/ \\ . ..）')
      }
      return { name }
    },
    handler: async ({ params, input }, _req: IncomingMessage, res: ServerResponse) => {
      if (!ctx.workDir) {
        replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
        return
      }
      const oldName = params['name'] ?? ''
      const r = resolveBook(ctx.workDir, oldName)
      if ('error' in r) {
        replyError(res, r.status, r.code, r.error)
        return
      }
      const entry = r.entry
      const newName = input.name
      const oldRoot = join(ctx.workDir, entry.path)
      const newPath = bookStoragePath(newName, entry.kind)
      const newRoot = join(ctx.workDir, newPath)
      const folderMove = newRoot !== oldRoot
      // R71-8（总七十一轮）：纯大小写改名（同名不同大小写）在大小写不敏感 FS（mac/win）
      // 上 newRoot 与 oldRoot 是**同一物理目录**——renameSync 前的目录冲突检查
      // existsSync(newRoot) 恒真且目录必非空 → 恒 400「已存在且非空」。判定依据
      // 「目标词法路径已存在 + 与源目录是同一物理目录（dev+inode 相等；macOS realpath
      // 保留输入大小写、字符串比对不可用；源不存在 = 登记与盘大小写已分歧的存量书，
      // 同样原位自愈）」：大小写不敏感 FS 命中同一目录（走原位改名——不搬目录，只改
      // 登记名/path/title 等注册面）；大小写敏感 FS 上新名是另一独立目录时 inode 不等
      // → 不进原位分支，照常 400 拒（不误吞他目录）
      const caseOnly =
        folderMove &&
        newName !== oldName &&
        newName.toLowerCase() === oldName.toLowerCase() &&
        existsSync(newRoot) &&
        (() => {
          if (!existsSync(oldRoot)) return true // 登记名大小写与盘分歧——newRoot 即本书目录
          try {
            const a = statSync(oldRoot)
            const b = statSync(newRoot)
            return a.dev === b.dev && a.ino === b.ino
          } catch {
            return false // stat 失败（EACCES 等）→ 不赌，走既有冲突检查
          }
        })()

      // 重名冲突（排除自身）；目录级冲突只在真正要移动目录时检查
      if (readBooks(ctx.workDir).some((b) => b.name === newName && b.name !== oldName)) {
        replyError(res, 400, 'BAD_INPUT', `已有一本叫「${newName}」的书，换个名字`)
        return
      }
      // R71-12（总七十一轮）：改名目标目录存在即拒（原先只拒非空）——空目录在 POSIX
      // 上被 renameSync 原子替换成功、Windows 上报 EPERM/EEXIST → 跨平台行为分叉且
      // win 落 500。统一「存在即拒」（R71-8 的纯大小写分支 newRoot 即 oldRoot 同一
      // 目录，须先判 caseOnly 再到此处，避免误拒）
      if (folderMove && !caseOnly && existsSync(newRoot)) {
        const nonEmpty = readdirSync(newRoot).length > 0
        replyError(res, 400, 'BAD_INPUT', `目录「${newName}」已存在${nonEmpty ? '且非空' : '（空目录）'}，换个名字`)
        return
      }

      /** 同步 book.yaml title（改名闭环的一部分；失败不阻塞——目录/登记已可自愈）。
       *  GG-P2-8：文本级单键行替换（setTopSectionKey）——原实现 readBookConfig→stringify
       *  全量重生成会静默丢作者 # 注释与未知段/未知子键（旧注释「已有键原样保留」口径失真）；
       *  文件缺失时落最小段（书架建书必有完整 book.yaml，此为兜底）。 */
      const writeTitle = (root: string): void => {
        try {
          const cfgPath = join(root, 'book.yaml')
          const raw = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : ''
          atomicWriteFile(cfgPath, setTopSectionKey(raw, 'book', 'title', stringifyValue(newName)))
        } catch (e) {
          log.error('api', `rename: 写 book.yaml title 失败（${newName}）`, e)
        }
      }

      // R26-58（二十六轮）：编排闸检查前置——「同名/目录未动」早退分支原在闸检查之前，
      // 同名改名完全绕过 spawn/三审/任务闸联合检查（title 同步写 book.yaml 与在途任务并发）。
      // 现先过闸（闸忙 409 与全量改名同口径）再进早退分支；在途 AI 中断仍只在真正搬目录的
      // 全量路径执行（此处到原闸点之间无 await，检查结果与原位置逐位一致，全量路径行为等价）。
      // ee-P2-11 / hh-P1 / dd-P2：三闸联合检查（同删书口径，busyGate 集中各闸背景）
      const busy = busyGate(oldName, '改名')
      if (busy) {
        return replyError(res, 409, 'BUSY', busy.error)
      }

      // 同名（或目录未动）→ 只同步 title（兜底历史分歧：title≠name 的书存配置时回正），不做目录搬家
      if (!folderMove || newName === oldName) {
        writeTitle(oldRoot)
        reply(res, 200, { ok: true, renamed: false, name: oldName, path: entry.path })
        return
      }

      // 全量改名：中断在途 AI（同删书，防改名后继续落盘重建旧目录/白耗费用）
      const hadSelfHeal = isSelfHealRunning(oldName)
      if (hadSelfHeal) abortSelfHeal(oldName)
      const hadChat = isChatRunning(oldName)
      if (hadChat) abortChat(oldName)
      // #7：等被中断的编排收尾后再搬目录/关库——abort 是异步信号，straggler 的收尾
      // 写库若在强制关库后恢复会抛「连接未打开」（对话以 error 收尾）；等待把这一窗
      // 收敛为零（确定性时序：本 handler 的同步段此前必然先于 straggler 恢复执行）。
      // M-2 接线收口：同删书——后台任务（定稿摘要等）独立判定，无 chat/self-heal
      // 在途时也不能放走
      if (hadSelfHeal || hadChat || hasBackgroundTasks(oldName)) await awaitOrchestrationsSettled(oldName)
      // 第五轮：同删书——drain 串行保存队列，防在途 save 收尾对旧路径重建孤儿文件
      await drainDocumentSaves(oldRoot)
      // R69-25（十七轮）：PUT /file 串行链同款 drain——临界段 readFileHashed 的 await 跨
      // renameSync 时「旧内容基线 + atomicWriteFile mkdir recursive」会重建旧路径目录树
      //（无 book.yaml 孤儿，repairBooks 不认领）——与 drainDocumentSaves 当年堵的同型窗
      await drainFilePutChainsUnder(oldRoot)
      // M-4：闸后复查——同删书：settle 等待的 await 间隙新 acquire 的闸在此拦截，
      // 复检到 renameSync 之间全同步（三闸 TOCTOU 归零；chat/self-heal 由超时降级兜底）
      // R33-63（三十三轮）：同删书复查——补 hasBackgroundTasks（settle 窗口内新登记后台任务）
      const recheck = busyGate(oldName, '改名') ?? (hasBackgroundTasks(oldName) ? { error: '本书后台任务进行中，请稍后再改名' } : null)
      if (recheck) {
        return replyError(res, 409, 'BUSY', recheck.error)
      }
      // L-S5（第八轮）：newName 冲突复查——入口检查在 10s settle await 之前（TOCTOU）：
      // 等待窗口内并发建同名书后 POSIX renameSync 对已存在空目录静默替换 → 同名同
      // path 双登记。复检到 renameSync 之间全同步
      if (readBooks(ctx.workDir).some((b) => b.name === newName && b.name !== oldName)) {
        return replyError(res, 400, 'BAD_INPUT', `已有一本叫「${newName}」的书，换个名字`)
      }
      // R71-12：目录存在即拒（与入口检查同口径；caseOnly 的 newRoot 即 oldRoot，豁免）
      if (folderMove && !caseOnly && existsSync(newRoot)) {
        const nonEmpty = readdirSync(newRoot).length > 0
        return replyError(res, 400, 'BAD_INPUT', `目录「${newName}」已存在${nonEmpty ? '且非空' : '（空目录）'}，换个名字`)
      }

      // dd-P1：先移磁盘目录，成功后才动会话/事件库/缓存——此前 migrateBookSession 先行，
      // renameSync 失败回 500 时事件库已落在新名 hash 下而登记仍是旧名，对话历史/审计
      // 从此永久失联且无回滚。先改名失败 = 纯净 500 可安全重试（migrate 现对「目标库
      // 已存在」也是返回 false 防覆盖，kk-P2-3，不再静默跳过）。
      // 改名同删书补越出/symlink 守卫（批 6 统一 resolveWithinRoot；此前改名 handler
      // 无此校验——books.jsonl 篡改 entry.path 后 renameSync 可把书库外目录搬进书库）
      if (!resolveWithinRoot(ctx.workDir, entry.path)) {
        return replyError(res, 400, 'BAD_PATH', '书路径非法（越出书库）')
      }
      // R71-8：纯大小写改名走「同目录原位」——不 renameSync（目标即源目录本身），直接
      // 进下方注册面同步（事件库按 bookHash(oldRoot)→bookHash(newRoot) 搬库、books.jsonl
      // 登记/active 指针/book.yaml title/各缓存清理全量照走；盘上目录名保留原大小写，
      // 大小写不敏感 FS 上登记与盘互访不受影响）
      if (!caseOnly) {
        try {
          renameSync(oldRoot, newRoot)
        } catch (e) {
          log.error('api', `rename: 改目录名失败（${oldName} → ${newName}）`, e)
          replyError(res, 500, 'IO', '改目录名失败')
          return
        }
      }

      // 清内存对话态 + 迁移事件库（5.1-3：失败不再静默——migrate 返回 false 时源库
      // 原地完整可重试，但必须让用户看得见：改名后书在新目录，事件库却没跟过来，
      // 对话历史/审计在 UI 上无声消失）
      clearChatHistory(oldName)
      const eventsMigrated = migrateBookSession(ctx.userDataPath, oldRoot, newRoot, oldName, newName)
      // 清缓存（service/driver 会话/树索引/书架摘要）
      forgetService(oldRoot)
      forgetSession(oldName)
      // R65-44（总六十五轮）：rename 清理序列补 forgetSseCount(oldName)——对齐 delete
      // 路径（R-18）。改名后旧名残留 SSE 计数，随后新建同名书 SSE 配额被旧连接
      // 顶到 429（计数只在 req close 时递减，改名后旧名再无归零通路）。
      forgetSseCount(oldName)
      // R67-15（十五轮）：书键 TTL 结果缓存清旧键（新键惰性重建——新 root 尚无请求）
      forgetBookKeyedCaches(oldRoot)
      invalidateTreeIndex(oldRoot, true)
      invalidateBookSummary(oldRoot)
      // 内存闸（2026-08-24 审计 C2）：旧路径前缀的章节元数据缓存一并清（新路径键惰性重建）
      clearChapterDirCacheForBook(oldRoot)
      forgetRagBuildTask(oldName) // dd-P3：模块级索引任务表随改名清理（rag-build 已被闸拒绝，不会运行中改名）
      writeTitle(newRoot)

      // 更新 books.jsonl 登记（保留 created_at/kind 等未知字段）。
      // DA-3（第七轮）：读失败（null）跳过整写——降级空表会把其余登记清掉；repair 兜底
      // R63-2（十一轮）：读改写进 books.lock 跨进程锁（CLI 与桌面并发改名/建书互斥）；
      // 超时跳过整写留痕——目录已改名成功，登记暂指旧路径，下次启动 repairBooks 按
      // book.yaml 重关联（missing 报告可见）
      {
        const release = tryBooksLock(ctx.workDir)
        if (!release) {
          log.warn('api', `rename: books.jsonl 登记锁获取超时，跳过登记更新（${oldName} → ${newName}）——自愈将重关联兜底`)
        } else {
          try {
            const books = readBooksStrict(ctx.workDir)
            if (books !== null) {
              const idx = books.findIndex((b) => b.name === oldName)
              if (idx >= 0) {
                books[idx] = { ...books[idx], name: newName, path: newPath, kind: books[idx]!.kind }
                writeBooks(ctx.workDir, books)
              }
            }
          } finally {
            release()
          }
        }
      }
      // active 指针指向旧名 → 换新
      if (readActive(ctx.workDir) === oldName) {
        writeActive(ctx.workDir, newName)
      }
      // --book 直进指针同步（second-instance --book 旧名不再命中）
      if (initialBook === oldName) setInitialBook(newName)

      // 5.1-3：迁移失败随响应带回（成功时不带该键，对齐本文件「条件展开」的响应风格）；
      // A4（批 0）：同步进启动通告——rename 响应只在设置页当场可见，App 级横幅保证
      // 「对话历史/审计没跟过来」这件事跨页面不失明（横幅一次性，关闭即静默）
      if (!eventsMigrated) {
        const msg = `书「${oldName}」改名后事件库迁移失败：对话历史/审计暂未跟到新名下，旧库原地完整保留于 ${bookHash(oldRoot)}.db，可重试改名找回`
        log.error('events-migration', msg)
        ctx.onStartupNotice?.('events-migration', msg)
      }
      reply(res, 200, {
        ok: true,
        renamed: true,
        name: newName,
        path: newPath,
        ...(eventsMigrated ? {} : { eventsMigrationFailed: true }),
      })
    },
  })

  // 单书身份
  defineRoute('books.by-name.get', {
    method: 'GET',
    path: '/api/books/:name',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      // R72-10（二十轮 D-4）：删 !name 死分支——path 参数 :name 为空的 404 由下方
      // find 未命中统一给出（原并入 NO_WORKDIR 是错误码语义错位）
      const name = params['name']
      if (!ctx.workDir) {
        replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
        return
      }
      const entry = readBooks(ctx.workDir).find((b) => b.name === name)
      if (!entry) {
        replyError(res, 404, 'NOT_FOUND', `没有这本书：${name}`)
        return
      }
      // 第九轮 L-1：book.yaml 损坏/缺失时回落默认骨架会静默回传空 title——与
      // GET /api/books/:name/config 的 500 IO 口径对齐（读失败显式报错，不代答默认身份）
      // 低-2（第十轮）：error 是 ParseError {file,line,message} 对象——直接插值会串成
      // 「[object Object]」，取 .message 展示真实解析错误（与 state.ts 同场景口径）
      const cfgResult = readBookConfig(join(ctx.workDir, entry.path, 'book.yaml'))
      if (!cfgResult.ok) return replyError(res, 500, 'IO', `读 book.yaml 失败:${cfgResult.error.message}`)
      const { config } = cfgResult
      // 单书身份回显：保持 raw（与 GET /api/books/:name/config 同口径——身份 = 书文件里
      // 实际写的值；genre 未设 = undefined 由前端自行回落全局默认，服务端不代答）
      reply(res, 200, {
        name: entry.name,
        kind: entry.kind,
        path: entry.path,
        ...(entry.created_at ? { created_at: entry.created_at } : {}),
        title: config.book.title,
        genre: config.book.genre,
        host: config.host ?? 'cc',
      })
    },
  })

  // 启动初始态（--book 直进 + session token 注入前端）
  defineRoute('boot', {
    method: 'GET',
    path: '/api/boot',
    handler: (_, req: IncomingMessage, res: ServerResponse) => {
    // RB-SV-P1-1：token 仅在可信时回传——无 Origin（本机直连 curl/测试）或同源/dev 白名单
    // Origin（server/index.ts 注入）；外部 Origin 一律不给。initialBook 无敏感性，照常回传。
    // ee-P2-12 口径修正（2026-08-17 拍板）：本机进程=同信任域——本地进程无 Origin 直连
    // 本端点即可拿 token，故 token 不承诺防本机进程；其实际作用是把写端点/SSE 可驱动面
    // 收敛到拿到 boot 的客户端，配合 Host/Origin 校验（server/index.ts）防远端网页驱动。
    const origin = req.headers.origin
    const trusted = !origin || ctx.isTrustedOrigin(origin)
    reply(res, 200, trusted ? { initialBook, token: ctx.token } : { initialBook })
  },
  })
}

export function setInitialBook(name: string | undefined): void {
  initialBook = name
}
