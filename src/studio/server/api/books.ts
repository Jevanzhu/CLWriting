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
import { rmSync, realpathSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { route } from '../router.js'
import { defineRoute } from './schema.js'
import { readJson, reply } from '../http.js'
import {
  readBooks,
  removeBookEntry,
  bookStoragePath,
  readActive,
  writeActive,
  writeBooks,
  isInvalidBookName,
} from '../../../install/books.js'
import { forgetService } from './documents.js'
import { forgetSession } from '../../../driver/index.js'
import { invalidateTreeIndex } from '../../../document/tree.js'
import { clearChatHistory, abortChat, isChatRunning } from '../../../ai/orchestrate/chat.js'
import { abortSelfHeal, isSelfHealRunning } from '../../../ai/orchestrate/self-heal.js'
import { readBookConfig, stringifyBookConfig } from '../../../format/yaml.js'
import { doInit } from '../../../install/init.js'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { computeBookSummary, invalidateBookSummary } from './progress.js'
import { migrateBookSession } from '../../../events/store.js'

interface BookCtx {
  workDir: string | null
  /** session token(P0 defense-in-depth,boot 注入前端,写端点校验) */
  token: string
  /** RB-SV-P1-1：Origin 是否可信（同源或 dev 白名单）——boot 据此决定是否回传 token */
  isTrustedOrigin: (origin: string) => boolean
  /** APP 级数据目录（Electron userData / CLI 模式跨平台约定路径）——事件库迁移用 */
  userDataPath: string | null
}

let initialBook: string | undefined

export function registerBookRoutes(ctx: BookCtx): void {
  // 书架列表
  route('GET', '/api/books', (_req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) {
      reply(res, 200, {
        books: [],
        workDir: false,
        hint: '当前目录不是 CLWriting 工作目录。请在工作目录（含 .clwriting/）下启动 studio。',
      })
      return
    }
    // 书架卡补摘要：title / 进度(N 章/字数) / 最近编辑。单本损坏不崩整列（摘要降级缺省）。
    const books = readBooks(ctx.workDir).map((b) => {
      const bookRoot = join(ctx.workDir!, b.path)
      try {
        const { config } = readBookConfig(join(bookRoot, 'book.yaml'))
        // P2-BE-1：一次扫描算出进度+最近编辑+最新章节（消除三重 readChapterDir）
        const summary = computeBookSummary(bookRoot)
        return {
          ...b,
          title: config.book.title,
          chapters: summary.chapters,
          words: summary.words,
          lastEdited: summary.lastEdited,
          targetWords: config.book.target_words,
          latestChapter: summary.latestChapter,
          createdAt: b.created_at,
        }
      } catch {
        // 书仓库损坏/缺 book.yaml：保留登记原样，摘要缺省（前端容错）
        return b
      }
    })
    reply(res, 200, { books, workDir: true })
  })

  // 建书（1.5 段 1 表单 → doInit）
  route('POST', '/api/books', async (req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) {
      reply(res, 400, { error: '未定位到工作目录，无法建书' })
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
      reply(res, 400, { error: '书名不能为空' })
      return
    }
    // P2-27：书名校验与 doInit 逻辑层共用单一真相源（isInvalidBookName）——防 `../` 越出 workDir
    if (isInvalidBookName(name)) {
      reply(res, 400, { error: '书名不能包含路径分隔符或特殊路径段（/ \\ . ..）' })
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
      reply(res, 400, { error: result.reason })
      return
    }
    reply(res, 200, { name: result.bookName, kind, path: result.bookPath })
  })

  // 删书（物理删除：rmSync 书目录 + 移 books.jsonl 登记 + 清 active 指针）
  route('DELETE', '/api/books/:name', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) {
      reply(res, 400, { error: '未定位到工作目录' })
      return
    }
    const name = params['name'] ?? ''
    const entry = readBooks(ctx.workDir).find((b) => b.name === name)
    if (!entry) {
      reply(res, 404, { error: `没有这本书：${name}` })
      return
    }
    // U-P2-7：先中断该书在途的 AI 编排（self-heal 批量写稿可长达十几分钟，
    // 不中断会在删除后继续落盘重建目录、白耗 API 费用）
    if (isSelfHealRunning(name)) abortSelfHeal(name)
    if (isChatRunning(name)) abortChat(name)
    // 删书目录（递归，含 git 历史）
    const bookAbs = join(ctx.workDir, entry.path)
    // symlink realpath 校验：防 entry.path 中间组件是符号链接 → rmSync 删到书库外
    try {
      const realWorkDir = realpathSync(ctx.workDir)
      const realBookAbs = realpathSync(bookAbs)
      if (realBookAbs === realWorkDir || relative(realWorkDir, realBookAbs).startsWith('..')) {
        return reply(res, 400, { error: '书路径非法（越出书库）' })
      }
    } catch {
      // realpath 失败说明路径异常（文件不存在 / 权限），拒绝删除
      return reply(res, 400, { error: '书路径异常' })
    }
    try {
      rmSync(bookAbs, { recursive: true, force: true })
    } catch (e) {
      console.error('[api] 删除目录失败:', e)
      reply(res, 500, { error: '删除目录失败' })
      return
    }
    // 移 books.jsonl 登记 + 清活动书指针
    removeBookEntry(ctx.workDir, name)
    // 清理 service 缓存，防同 path 重建复用旧实例
    forgetService(bookAbs)
    // P1-S2：清理 driver session + 树索引缓存，防删书后资源泄漏
    forgetSession(name)
    invalidateTreeIndex(bookAbs)
    clearChatHistory(name)
    reply(res, 200, { ok: true, name })
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
      // 路径穿越净化（与建书一致）：书名直接用作目录名
      if (!name) throw new Error('书名不能为空')
      if (name.includes('\0') || /[\\/]/.test(name) || name === '.' || name === '..') {
        throw new Error('书名不能包含路径分隔符或特殊路径段（/ \\ . ..）')
      }
      return { name }
    },
    handler: ({ params, input }, _req: IncomingMessage, res: ServerResponse) => {
      if (!ctx.workDir) {
        reply(res, 400, { error: '未定位到工作目录' })
        return
      }
      const oldName = params['name'] ?? ''
      const entry = readBooks(ctx.workDir).find((b) => b.name === oldName)
      if (!entry) {
        reply(res, 404, { error: `没有这本书：${oldName}` })
        return
      }
      const newName = input.name
      const oldRoot = join(ctx.workDir, entry.path)
      const newPath = bookStoragePath(newName, entry.kind)
      const newRoot = join(ctx.workDir, newPath)
      const folderMove = newRoot !== oldRoot

      // 重名冲突（排除自身）；目录级冲突只在真正要移动目录时检查
      if (readBooks(ctx.workDir).some((b) => b.name === newName && b.name !== oldName)) {
        reply(res, 400, { error: `已有一本叫「${newName}」的书，换个名字` })
        return
      }
      if (folderMove && existsSync(newRoot) && readdirSync(newRoot).length > 0) {
        reply(res, 400, { error: `目录「${newName}」已存在且非空，换个名字` })
        return
      }

      /** 同步 book.yaml title（改名闭环的一部分；失败不阻塞——目录/登记已可自愈）。 */
      const writeTitle = (root: string): void => {
        try {
          const { config } = readBookConfig(join(root, 'book.yaml'))
          config.book.title = newName
          atomicWriteFile(join(root, 'book.yaml'), stringifyBookConfig(config))
        } catch (e) {
          console.error('[api] rename: 写 book.yaml title 失败:', e)
        }
      }

      // 同名（或目录未动）→ 只同步 title（兜底历史分歧：title≠name 的书存配置时回正），不做目录搬家
      if (!folderMove || newName === oldName) {
        writeTitle(oldRoot)
        reply(res, 200, { ok: true, renamed: false, name: oldName, path: entry.path })
        return
      }

      // 全量改名：中断在途 AI（同删书，防改名后继续落盘重建旧目录/白耗费用）
      if (isSelfHealRunning(oldName)) abortSelfHeal(oldName)
      if (isChatRunning(oldName)) abortChat(oldName)
      // 清内存对话态 + 迁移事件库（尽力而为：失败留旧库可找回，不删数据）
      clearChatHistory(oldName)
      migrateBookSession(ctx.userDataPath, oldRoot, newRoot, oldName, newName)
      // 清缓存（service/driver 会话/树索引/书架摘要）
      forgetService(oldRoot)
      forgetSession(oldName)
      invalidateTreeIndex(oldRoot)
      invalidateBookSummary(oldRoot)

      // 移动磁盘目录
      try {
        renameSync(oldRoot, newRoot)
      } catch (e) {
        console.error('[api] rename: 改目录名失败:', e)
        reply(res, 500, { error: '改目录名失败' })
        return
      }
      writeTitle(newRoot)

      // 更新 books.jsonl 登记（保留 created_at/kind 等未知字段）
      const books = readBooks(ctx.workDir)
      const idx = books.findIndex((b) => b.name === oldName)
      if (idx >= 0) {
        books[idx] = { ...books[idx], name: newName, path: newPath, kind: books[idx]!.kind }
        writeBooks(ctx.workDir, books)
      }
      // active 指针指向旧名 → 换新
      if (readActive(ctx.workDir) === oldName) {
        writeActive(ctx.workDir, newName)
      }
      // --book 直进指针同步（second-instance --book 旧名不再命中）
      if (initialBook === oldName) setInitialBook(newName)

      reply(res, 200, { ok: true, renamed: true, name: newName, path: newPath })
    },
  })

  // 单书身份
  route(
    'GET',
    '/api/books/:name',
    (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const name = params['name']
      if (!name || !ctx.workDir) {
        reply(res, 400, { error: '未定位到工作目录' })
        return
      }
      const entry = readBooks(ctx.workDir).find((b) => b.name === name)
      if (!entry) {
        reply(res, 404, { error: `没有这本书：${name}` })
        return
      }
      const { config } = readBookConfig(join(ctx.workDir, entry.path, 'book.yaml'))
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
  )

  // 启动初始态（--book 直进 + session token 注入前端）
  route('GET', '/api/boot', (req: IncomingMessage, res: ServerResponse) => {
    // RB-SV-P1-1：token 仅在可信时回传——无 Origin（本机直连 curl/测试）或同源/dev 白名单
    // Origin（server/index.ts 注入）；外部 Origin 一律不给（防本地恶意页面免鉴权取 token
    // 换取全部写权限）。initialBook 无敏感性，照常回传。
    const origin = req.headers.origin
    const trusted = !origin || ctx.isTrustedOrigin(origin)
    reply(res, 200, trusted ? { initialBook, token: ctx.token } : { initialBook })
  })
}

export function setInitialBook(name: string | undefined): void {
  initialBook = name
}
