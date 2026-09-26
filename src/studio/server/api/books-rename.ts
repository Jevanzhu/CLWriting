/**
 * 改书名路由 + --book 直进指针 —— 自 src/studio/server/api/books.ts 缝 B 拆出。
 *
 * （⑤④产品巨件拆分波4）：books.ts（870 行）缝 A+B 纯移动拆分。
 * 本文件承载缝 B：改书名路由 book.rename（全量同步：磁盘目录 + books.jsonl 登记 +
 * active 指针 + book.yaml title）+ initialBook / --book 直进指针（setInitialBook——
 * rename 命中旧名时回写、残核 boot 路由经活绑定单向读取，单源本文件不经环回引）。
 * 删书路由 + 删/改名共用生命周期助手族见 books-lifecycle.ts（缝 A）；本文件自其
 * 单向 import 四助手（forgetBookKeyedCaches / busyGate / awaitOrchestrationsSettled /
 * drainAndRecheckBookMutation）。
 * 书架列表 / 建书 / 单书身份 / boot 残核留 books.ts，其头注末尾拆分沿革记全账。
 * setInitialBook 迁出后经 books.ts 逐名 re-export 桥接，全库消费方 import 面零改动。
 * 依赖方向单向（无环回引）：本文件仅 runtime import books-lifecycle.ts（缝 A），
 * 对 books.ts 仅 import type BookCtx（编译期擦除）。注释全部原样随迁；行为、断言、
 * 测试零改动。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { renameWithRetry } from '../../../fs/atomic.js'
import { join } from 'node:path'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { resolveWithinRoot } from '../../../fs/safe-path.js'
import {
  readBooks,
  readBooksStrict,
  bookStoragePath,
  readActive,
  writeActive,
  writeBooks,
  isInvalidBookName,
  BOOK_NAME_INVALID_REASON,
  tryBooksLockAsync,
} from '../../../install/books.js'
import { resolveBookOrReply } from '../book-context.js'
import { forgetService } from './documents.js'
import { invalidateTreeIndex } from '../../../document/tree.js'
import { clearChatHistory, abortChat, isChatRunning } from '../../../ai/orchestrate/chat.js'
import { abortSelfHeal, isSelfHealRunning } from '../../../ai/orchestrate/self-heal.js'
import { hasBackgroundTasks } from '../../../ai/orchestrate/background.js'
import { setTopSectionKey } from '../../../format/yaml.js'
import { clearChapterDirCacheForBook } from '../../../format/chapters.js'
import { stringifyValue } from '../../../format/frontmatter.js'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { invalidateBookSummary } from './progress.js'
import { migrateBookSession, bookHash } from '../../../events/store.js'
import { forgetRagBuildTask } from './rag.js'
import { forgetSseCount } from './stream.js'
import { log } from '../../../log/index.js'
import {
  forgetBookKeyedCaches,
  busyGate,
  awaitOrchestrationsSettled,
  drainAndRecheckBookMutation,
} from './books-lifecycle.js'
import type { BookCtx } from './books.js'

export let initialBook: string | undefined

export function registerBookRenameRoutes(ctx: BookCtx): void {
  // 改书名（全量同步：磁盘目录 + books.jsonl 登记 + active 指针 + book.yaml title 一起改，
  // 防「书名/文件夹/登记名」三分歧。body {name} = 新书名；校验复用建书净化规则。
  // 新路由走 defineRoute（input 形状 parse 声明，失败统一 400 {error} 信封）。
  defineRoute('book.rename', {
    method: 'POST',
    path: '/api/books/:name/rename',
    parse: (raw) => {
      const body = (raw ?? {}) as Record<string, unknown>
      // 新书名 NFC 归一——与建书（init.ts 平台规范化批）同口径；
      // mac 侧输入的 NFD 形态名直接落目录/登记，跨机到 NFC 惯例卷（win）即「找不到
      // 文件」。归一在 trim 后、全部校验之前，登记名/目录名/title 天然一致。
      const name = typeof body['name'] === 'string' ? body['name'].trim().normalize('NFC') : ''
      // dd-书名校验复用单一真相源（isInvalidBookName，与建书/删书同源）——
      // 此前内联复制规则，两处将来会漂移
      if (!name) throw new Error('书名不能为空')
      if (isInvalidBookName(name)) {
        // -mac适配：文案收编 BOOK_NAME_INVALID_REASON 单源（同上）
        throw new Error(BOOK_NAME_INVALID_REASON)
      }
      return { name }
    },
    handler: async ({ params, input }, _req: IncomingMessage, res: ServerResponse) => {
      if (!ctx.workDir) {
        replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
        return
      }
      const oldName = params['name'] ?? ''
      const r = resolveBookOrReply(ctx.workDir, oldName, res)
      if (!r) return
      const entry = r.entry
      const newName = input.name
      const oldRoot = join(ctx.workDir, entry.path)
      const newPath = bookStoragePath(newName, entry.kind)
      const newRoot = join(ctx.workDir, newPath)
      const folderMove = newRoot !== oldRoot
      // （总七十一轮）：纯大小写改名（同名不同大小写）在大小写不敏感 FS（mac/win）
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
      // （总七十一轮）：改名目标目录存在即拒（原先只拒非空）——空目录在 POSIX
      // 上被 renameSync 原子替换成功、Windows 上报 EPERM/EEXIST → 跨平台行为分叉且
      // win 落 500。统一「存在即拒」（的纯大小写分支 newRoot 即 oldRoot 同一
      // 目录，须先判 caseOnly 再到此处，避免误拒）
      if (folderMove && !caseOnly && existsSync(newRoot)) {
        const nonEmpty = readdirSync(newRoot).length > 0
        replyError(res, 400, 'BAD_INPUT', `目录「${newName}」已存在${nonEmpty ? '且非空' : '（空目录）'}，换个名字`)
        return
      }

      /** 同步 book.yaml title（改名闭环的一部分；失败不阻塞——目录/登记已可自愈）。
       *  ：文本级单键行替换（setTopSectionKey）——原实现 readBookConfig→stringify
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

      // 编排闸检查前置——「同名/目录未动」早退分支原在闸检查之前，
      // 同名改名完全绕过 spawn/三审/任务闸联合检查（title 同步写 book.yaml 与在途任务并发）。
      // 现先过闸（闸忙 409 与全量改名同口径）再进早退分支；在途 AI 中断仍只在真正搬目录的
      // 全量路径执行（此处到原闸点之间无 await，检查结果与原位置逐位一致，全量路径行为等价）。
      // ee- / hh- / dd-三闸联合检查（同删书口径，busyGate 集中各闸背景）
      const busy = busyGate(ctx.gate, oldName, '改名')
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
      // 接线收口：同删书——后台任务（定稿摘要等）独立判定，无 chat/self-heal
      // 在途时也不能放走
      if (hadSelfHeal || hadChat || hasBackgroundTasks(oldName)) await awaitOrchestrationsSettled(oldName)
      // 五连 drain + 闸后复查收编 drainAndRecheckBookMutation
      // 单源（同删书段口径，沿革与顺序见 helper 头注）——原为与删书 handler 逐位复制的 55 行。
      const blocked = await drainAndRecheckBookMutation(ctx.gate, oldRoot, oldName, '改名')
      if (blocked) {
        return replyError(res, 409, 'BUSY', blocked.error)
      }
      // L-S5newName 冲突复查——入口检查在 10s settle await 之前（TOCTOU）：
      // 等待窗口内并发建同名书后 POSIX renameSync 对已存在空目录静默替换 → 同名同
      // path 双登记。复检到 renameSync 之间全同步
      if (readBooks(ctx.workDir).some((b) => b.name === newName && b.name !== oldName)) {
        return replyError(res, 400, 'BAD_INPUT', `已有一本叫「${newName}」的书，换个名字`)
      }
      // 目录存在即拒（与入口检查同口径；caseOnly 的 newRoot 即 oldRoot，豁免）
      if (folderMove && !caseOnly && existsSync(newRoot)) {
        const nonEmpty = readdirSync(newRoot).length > 0
        return replyError(
          res,
          400,
          'BAD_INPUT',
          `目录「${newName}」已存在${nonEmpty ? '且非空' : '（空目录）'}，换个名字`,
        )
      }

      // dd-先移磁盘目录，成功后才动会话/事件库/缓存——此前 migrateBookSession 先行，
      // renameSync 失败回 500 时事件库已落在新名 hash 下而登记仍是旧名，对话历史/审计
      // 从此永久失联且无回滚。先改名失败 = 纯净 500 可安全重试（migrate 现对「目标库
      // 已存在」也是返回 false 防覆盖，kk-，不再静默跳过）。
      // 改名同删书补越出/symlink 守卫（批 6 统一 resolveWithinRoot；此前改名 handler
      // 无此校验——books.jsonl 篡改 entry.path 后 renameSync 可把书库外目录搬进书库）
      if (!resolveWithinRoot(ctx.workDir, entry.path)) {
        return replyError(res, 400, 'BAD_PATH', '书路径非法（越出书库）')
      }
      // 纯大小写改名走「同目录原位」——不 renameSync（目标即源目录本身），直接
      // 进下方注册面同步（事件库按 bookHash(oldRoot)→bookHash(newRoot) 搬库、books.jsonl
      // 登记/active 指针/book.yaml title/各缓存清理全量照走；盘上目录名保留原大小写，
      // 大小写不敏感 FS 上登记与盘互访不受影响）
      if (!caseOnly) {
        try {
          // 同上——改目录名收编 EPERM/EBUSY 退避
          renameWithRetry(oldRoot, newRoot)
        } catch (e) {
          log.error('api', `rename: 改目录名失败（${oldName} → ${newName}）`, e)
          replyError(res, 500, 'IO_ERROR', '改目录名失败')
          return
        }
      }

      // 清内存对话态 + 迁移事件库（5.1-3：失败不再静默——migrate 返回 false 时源库
      // 原地完整可重试，但必须让用户看得见：改名后书在新目录，事件库却没跟过来，
      // 对话历史/审计在 UI 上无声消失）
      // clearChatHistory 防御性收编——对齐删书路径的 try/catch +
      // log.warn 降级口径。本调用位于 renameWithRetry 成功之后，目录已搬家**不可
      // 回滚**：清史若裸奔抛错，已生效的改名被打成 500，客户端按失败重试只会撞上
      // 目标名已存在的分叉状态。失败留痕后继续（事件库迁移失败的独立回传通道为
      // 下方 eventsMigrated，不受本兜底影响；对话内存态残留由下次清史兜底）。
      try {
        // migrateBookSession/clearChatSession 转异步——迁移锁对与
        // 开库锁等待不再阻塞服务事件循环（双进程争用窗最坏 2×5s Atomics.wait 消除）
        await clearChatHistory(oldName)
      } catch (e) {
        // 低-6同款：留痕走项目 logger（console 在打包态 mirrorConsole=false
        // 无人看见也不进 JSONL），tag 与本文件其余降级留痕同源 'api'
        log.warn('api', `改名清史失败（${oldName} → ${newName}，改名已生效不回滚，残留内存态待下次清史兜底）`, e)
      }
      const eventsMigrated = await migrateBookSession(ctx.userDataPath, oldRoot, newRoot, oldName, newName)
      // 清缓存（service/driver 会话/树索引/书架摘要）
      forgetService(oldRoot)
      ctx.driver.forgetSession(oldName)
      // （总六十五轮）：rename 清理序列补 forgetSseCount(oldName)——对齐 delete
      // 路径。改名后旧名残留 SSE 计数，随后新建同名书 SSE 配额被旧连接
      // 顶到 429（计数只在 req close 时递减，改名后旧名再无归零通路）。
      forgetSseCount(oldName)
      // 书键 TTL 结果缓存清旧键（新键惰性重建——新 root 尚无请求）
      forgetBookKeyedCaches(oldRoot)
      invalidateTreeIndex(oldRoot, true)
      invalidateBookSummary(oldRoot)
      // 内存闸（审计）：旧路径前缀的章节元数据缓存一并清（新路径键惰性重建）
      clearChapterDirCacheForBook(oldRoot)
      forgetRagBuildTask(oldName) // dd-模块级索引任务表随改名清理（rag-build 已被闸拒绝，不会运行中改名）
      writeTitle(newRoot)

      // 更新 books.jsonl 登记（保留 created_at/kind 等未知字段）。
      // DA-3读失败（null）跳过整写——降级空表会把其余登记清掉；repair 兜底
      // 读改写进 books.lock 跨进程锁（CLI 与桌面并发改名/建书互斥）；
      // 超时跳过整写留痕——目录已改名成功，登记暂指旧路径，下次启动 repairBooks 按
      // book.yaml 重关联（missing 报告可见）
      // 端点内嵌 RMW 的锁等待走异步孪生（事件循环不阻塞）
      {
        const release = await tryBooksLockAsync(ctx.workDir)
        if (!release) {
          log.warn(
            'api',
            `rename: books.jsonl 登记锁获取超时，跳过登记更新（${oldName} → ${newName}）——自愈将重关联兜底`,
          )
        } else {
          try {
            const books = readBooksStrict(ctx.workDir)
            if (books !== null) {
              // （四轮处置批）：锁内重名重查——上方 L- 复查到本 RMW 之间隔着
              // clearChatHistory/migrateBookSession 两个 await，跨进程并发建同名书可在此
              // 窗口入表；锁内命中则跳过本登记更新（与锁超时分支同款降级：目录已搬、登记
              // 暂指旧名，repairBooks 按 book.yaml 重关联兜底），防 books.jsonl 同名双登记。
              if (books.some((b) => b.name === newName && b.name !== oldName)) {
                log.warn('api', `rename: 锁内重查发现并发同名登记（${newName}），跳过登记更新——自愈将重关联兜底`)
              } else {
                const idx = books.findIndex((b) => b.name === oldName)
                if (idx >= 0) {
                  books[idx] = { ...books[idx], name: newName, path: newPath, kind: books[idx]!.kind }
                  writeBooks(ctx.workDir, books)
                }
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
      // 同步进启动通告——rename 响应只在设置页当场可见，App 级横幅保证
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
}

export function setInitialBook(name: string | undefined): void {
  initialBook = name
}
