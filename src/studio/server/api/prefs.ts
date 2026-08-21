/**
 * 偏好端点：
 *
 * 书级布局（.clwriting/prefs.json，跟随书）：
 *   GET  /api/books/:name/prefs             → { prefs: BookPrefs }
 *   PUT  /api/books/:name/prefs  body {prefs} → 写 .clwriting/prefs.json → {ok}
 *
 * 全局编辑器偏好（userData/global.json，APP 级，跨书库共享）：
 *   GET  /api/library/prefs                 → { prefs: GlobalPrefs, revision }
 *   PUT  /api/library/prefs    body {prefs, expectedRevision?}
 *                                          → 写 userData/global.json → {ok, revision}
 *
 * GG-P2-7（照 providers.ts P4 乐观并发模式）：global.json 内嵌服务端管理的保留键 revision
 * （存量文件无该键视为 0，每次 PUT +1）——写端点带可选 expectedRevision 比对，失配回 409，
 * 不带则放行（旧客户端/脚本向后兼容）。此前两面板同时保存后写静默覆盖先写，revision 形同虚设。
 * 其余读 global.json 的模块（global-defaults / 快照保留策略 / rag 配置）按键读取，
 * 忽略 revision 保留键，读路径不受影响。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, dirname } from 'node:path'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
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

export function registerPrefsRoutes(ctx: PrefsCtx): void {
  /** 解析书库的 .clwriting/prefs.json 路径（找书走公共 resolveBook，error 带机器码） */
  function prefsPath(name: string): { ok: true; path: string } | { ok: false; code: number; errCode: string; error: string } {
    const r = resolveBook(ctx.workDir, name)
    if ('error' in r) return { ok: false, code: r.status, errCode: r.code, error: r.error }
    return { ok: true, path: join(r.bookRoot, '.clwriting', 'prefs.json') }
  }

  defineRoute('books.prefs.get', {
    method: 'GET',
    path: '/api/books/:name/prefs',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = prefsPath(params['name']!)
    if (!r.ok) return replyError(res, r.code, r.errCode, r.error)
    if (!existsSync(r.path)) return reply(res, 200, { prefs: {} })
    try {
      const prefs = JSON.parse(readFileSync(r.path, 'utf8')) as BookPrefs
      reply(res, 200, { prefs })
    } catch {
      reply(res, 200, { prefs: {} })
    }
  },
  })

  defineRoute('books.prefs.put', {
    method: 'PUT',
    path: '/api/books/:name/prefs',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = prefsPath(params['name']!)
    if (!r.ok) return replyError(res, r.code, r.errCode, r.error)
    const body = await readJson(req)
    const prefs = body['prefs']
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return replyError(res, 400, 'BAD_INPUT', 'prefs 必填且须为对象')
    try {
      // 低级项（第六轮）：合并写（对齐 library.prefs.put 第五轮口径）——prefs.json 同样
      // 可能存在端点 payload 之外的使用方（手工/脚本写入的键），整体覆写会静默清键。
      // 盘上键 ← 客户端键覆盖；无删键场景（前端已知键全量回传）。读盘→写盘在
      // await readJson 之后全同步，单事件循环内原子
      let disk: Record<string, unknown> = {}
      if (existsSync(r.path)) {
        try {
          // P5-服务端（第七轮）：形状校验——prefs.json 内容为数组/字符串/数字（损坏或
          // 误写）时，{...disk, ...prefs} 会把索引键/字符位混入写回（损坏扩散一轮）
          const parsed: unknown = JSON.parse(readFileSync(r.path, 'utf8'))
          disk = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
        } catch { /* 文件损坏视作空：本次整体重写（与原直写行为一致） */ }
      }
      mkdirSync(dirname(r.path), { recursive: true })
      atomicWriteFile(r.path, JSON.stringify({ ...disk, ...prefs }, null, 2) + '\n')
      reply(res, 200, { ok: true })
    } catch (e) {
      log.error('api', '写 prefs 失败', e)
      replyError(res, 500, 'IO', '写 prefs 失败')
    }
  },
  })

  // ── 全局编辑器偏好（userData/global.json，APP 级）──
  // 跨书库共享的外观设置（主题/字体/字号/行距/段距/纸张宽度/自动保存）。
  // 放在 APP 数据目录（非书库目录），切书库不受影响——对齐 Obsidian 全局配置位置。

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
      const raw = JSON.parse(readFileSync(r.path, 'utf8')) as Record<string, unknown>
      // GG-P2-7：revision 是服务端管理的保留键——从 prefs 剥离后单独回传（不混入偏好语义），
      // 供前端下次 PUT 带 expectedRevision；存量文件无该键视为 0
      const { revision, ...prefs } = raw
      reply(res, 200, { prefs, revision: typeof revision === 'number' ? revision : 0 })
    } catch {
      reply(res, 200, { prefs: {}, revision: 0 })
    }
  },
  })

  defineRoute('library.prefs.put', {
    method: 'PUT',
    path: '/api/library/prefs',
    handler: async (_, req: IncomingMessage, res: ServerResponse) => {
    const r = globalPath()
    if (!r.ok) return replyError(res, r.code, r.errCode, r.error)
    // GG-P2-7（照 providers dd-P2 口径）：body 先读——读盘/比对/写盘三段必须同步无 await，
    // 单事件循环内原子，否则并发 PUT 交错仍会后写覆盖先写
    const body = await readJson(req)
    const prefs = body['prefs']
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return replyError(res, 400, 'BAD_INPUT', 'prefs 必填且须为对象')
    try {
      let disk: Record<string, unknown> = {}
      if (existsSync(r.path)) {
        try {
          // P5-服务端（第七轮）：形状校验（与 books.prefs.put 同款）——数组/标量损坏内容
          // 不混入合并写
          const parsed: unknown = JSON.parse(readFileSync(r.path, 'utf8'))
          disk = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
        } catch { /* 文件损坏视作空：revision 0，本次整体重写（与原直写行为一致） */ }
      }
      const current = typeof disk.revision === 'number' ? disk.revision : 0
      const revErr = revisionError(body['expectedRevision'], current)
      if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
      const next = current + 1
      mkdirSync(dirname(r.path), { recursive: true })
      // revision 由服务端计算覆盖（客户端传入的同名键不采信），随偏好一起落盘。
      // 第五轮：合并写——global.json 存在前端 payload 之外的使用方（按文档手工/脚本
      // 写入的 tokensPerChapter/costPerChapter 预算键等）。整体覆写会让任何一次面板
      // 保存（500ms debounce）静默清掉这些键、预算闸随之失效。盘上键 ← 客户端键覆盖；
      // 客户端无法经此端点显式删键是可接受代价（前端已知键全量回传，无删键场景）。
      atomicWriteFile(r.path, JSON.stringify({ ...disk, ...prefs, revision: next }, null, 2) + '\n')
      reply(res, 200, { ok: true, revision: next })
    } catch (e) {
      log.error('api', '写全局偏好失败', e)
      replyError(res, 500, 'ERROR', '写全局偏好失败')
    }
  },
  })
}

/** GG-P2-7：写端点并发守卫（照 providers.ts P4 同款结构）——expectedRevision 缺失放行
 *  （旧客户端/脚本向后兼容）；存在且与盘上 revision 不匹配 → 409 文案 */
function revisionError(expected: unknown, current: number): string | null {
  if (expected === undefined || expected === null) return null
  if (typeof expected !== 'number' || expected !== current) {
    return '全局偏好已在其他窗口被修改，请刷新'
  }
  return null
}
