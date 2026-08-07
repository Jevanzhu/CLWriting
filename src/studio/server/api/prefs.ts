/**
 * 偏好端点：
 *
 * 书级布局（.clwriting/prefs.json，跟随书）：
 *   GET  /api/books/:name/prefs             → { prefs: BookPrefs }
 *   PUT  /api/books/:name/prefs  body {prefs} → 写 .clwriting/prefs.json → {ok}
 *
 * 全局编辑器偏好（userData/global.json，APP 级，跨书库共享）：
 *   GET  /api/library/prefs                 → { prefs: GlobalPrefs }
 *   PUT  /api/library/prefs    body {prefs}  → 写 userData/global.json → {ok}
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, dirname } from 'node:path'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'

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
  /** 解析书库的 .clwriting/prefs.json 路径 */
  function prefsPath(name: string): { ok: true; path: string } | { ok: false; code: number; error: string } {
    if (!ctx.workDir) return { ok: false, code: 400, error: '未定位到工作目录' }
    const entry = readBooks(ctx.workDir).find((b) => b.name === name)
    if (!entry) return { ok: false, code: 404, error: `没有这本书:${name}` }
    return { ok: true, path: join(ctx.workDir, entry.path, '.clwriting', 'prefs.json') }
  }

  route('GET', '/api/books/:name/prefs', (_req: IncomingMessage, res: ServerResponse, params) => {
    const r = prefsPath(params['name']!)
    if (!r.ok) return reply(res, r.code, { error: r.error })
    if (!existsSync(r.path)) return reply(res, 200, { prefs: {} })
    try {
      const prefs = JSON.parse(readFileSync(r.path, 'utf8')) as BookPrefs
      reply(res, 200, { prefs })
    } catch {
      reply(res, 200, { prefs: {} })
    }
  })

  route('PUT', '/api/books/:name/prefs', async (req: IncomingMessage, res: ServerResponse, params) => {
    const r = prefsPath(params['name']!)
    if (!r.ok) return reply(res, r.code, { error: r.error })
    const body = await readJson(req)
    const prefs = body['prefs']
    if (!prefs || typeof prefs !== 'object') return reply(res, 400, { error: 'prefs 必填' })
    try {
      mkdirSync(dirname(r.path), { recursive: true })
      atomicWriteFile(r.path, JSON.stringify(prefs, null, 2) + '\n')
      reply(res, 200, { ok: true })
    } catch (e) {
      console.error('[api] 写 prefs:', e)
      reply(res, 500, { error: '写 prefs 失败' })
    }
  })

  // ── 全局编辑器偏好（userData/global.json，APP 级）──
  // 跨书库共享的外观设置（主题/字体/字号/行距/段距/纸张宽度/自动保存）。
  // 放在 APP 数据目录（非书库目录），切书库不受影响——对齐 Obsidian 全局配置位置。

  function globalPath(): { ok: true; path: string } | { ok: false; code: number; error: string } {
    if (!ctx.userDataPath) return { ok: false, code: 400, error: '未定位到应用数据目录' }
    return { ok: true, path: join(ctx.userDataPath, 'global.json') }
  }

  route('GET', '/api/library/prefs', (_req: IncomingMessage, res: ServerResponse) => {
    const r = globalPath()
    if (!r.ok) return reply(res, r.code, { error: r.error })
    if (!existsSync(r.path)) return reply(res, 200, { prefs: {} })
    try {
      const prefs = JSON.parse(readFileSync(r.path, 'utf8')) as Record<string, unknown>
      reply(res, 200, { prefs })
    } catch {
      reply(res, 200, { prefs: {} })
    }
  })

  route('PUT', '/api/library/prefs', async (req: IncomingMessage, res: ServerResponse) => {
    const r = globalPath()
    if (!r.ok) return reply(res, r.code, { error: r.error })
    const body = await readJson(req)
    const prefs = body['prefs']
    if (!prefs || typeof prefs !== 'object') return reply(res, 400, { error: 'prefs 必填' })
    try {
      mkdirSync(dirname(r.path), { recursive: true })
      atomicWriteFile(r.path, JSON.stringify(prefs, null, 2) + '\n')
      reply(res, 200, { ok: true })
    } catch (e) {
      console.error('[api] 写全局偏好:', e)
      reply(res, 500, { error: '写全局偏好失败' })
    }
  })
}
