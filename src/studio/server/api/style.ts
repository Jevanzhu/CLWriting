/**
 * 文风系统 REST 端点（文风系统重整 S6）：条目库 + 候选箱 + 收割。
 *
 * GET    /api/books/:name/style/entries              条目列表（首读触发自动迁移，结果附返回供 toast）
 * POST   /api/books/:name/style/entries              新增条目（源4 作者手动直达入库）
 * DELETE /api/books/:name/style/entries              删条目（body {path}，限条目目录内）
 * GET    /api/books/:name/style/candidates           候选列表（呈现状态含 30 天过期）
 * POST   /api/books/:name/style/candidates/confirm   确认（→ 条目库，删候选文件）
 * POST   /api/books/:name/style/candidates/ignore    忽略（落盘留档，查重闸记住）
 * POST   /api/books/:name/style/harvest              收割：源1 轨迹比对 + 源2 漂移映射（零 AI）
 * GET    /api/books/:name/style/config               定标：铁律阈值 + 基线摘要 + 注入强度
 * POST   /api/books/:name/style/baseline/freeze      重新冻结基线（样章条目按场景算指纹）
 *
 * 「候选制，品味归人」：确认/新增是仅有的入库通道，收割只落候选。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, relative, isAbsolute } from 'node:path'
import { rmSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { defineRoute } from './schema.js'
import { reply, replyError, readJson } from '../http.js'
import { readBookConfig } from '../../../format/yaml.js'
import { applyGlobalDefaults } from '../../../format/global-defaults.js'
import { parseIronRules } from '../../../format/iron-rules.js'
import { readBaseline, freezeBaseline } from '../../../metrics/style.js'
import {
  readEntries,
  addEntry,
  ENTRIES_DIR,
  ENTRY_KINDS,
  SOURCE_RANK,
} from '../../../format/style-entry.js'
import {
  readCandidates,
  effectiveStatus,
  confirmCandidate,
  ignoreCandidate,
  CANDIDATES_DIR,
} from '../../../format/style-candidate.js'
import { migrateStyleLibrary } from '../../../format/style-migrate.js'
import { harvestStyleCandidates } from '../../../process/style-harvest.js'
import { readKind, resolveBook } from '../book-context.js'
import { redactSecret } from '../../../ai/provider/redact.js' // P2-4：API 错误脱敏
import type { EntryKind, EntrySource, StyleEntry } from '../../../format/types.js'

interface StyleCtx {
  workDir: string | null
  /** APP 级数据目录：注入强度走「书级 → global.json → 硬编码」三层链时读全局默认 */
  userDataPath: string | null
}

/** 服务端今天（候选 创建/过期口径统一在服务端） */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 绝对 _path → 书内相对路径（前端确认/忽略/删除都用相对路径互传） */
function relPath(bookRoot: string, p: string | undefined): string {
  if (!p) return ''
  return isAbsolute(p) ? relative(bookRoot, p) : p
}

/** 相对路径是否落在指定书内目录（防穿越：拒绝 ..、绝对路径、NUL 字节） */
function insideDir(rel: string, dir: string): boolean {
  return rel.startsWith(`${dir}/`) && !rel.includes('..') && !rel.includes('\0') && !isAbsolute(rel)
}

export function registerStyleRoutes(ctx: StyleCtx): void {
  // 找书走公共 resolveBook（hh §八-12：信封统一 replyError）——原局部复制的 workDir 判空 + find + 404 样板
  const resolveStyleBook = (
    res: ServerResponse,
    params: Record<string, string | undefined>,
  ): string | null => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) {
      replyError(res, r.status, r.code, r.error)
      return null
    }
    return r.bookRoot
  }

  // 条目列表（老书首读自动迁移——幂等，常态 no-op；迁移发生时附结果供 toast）
  defineRoute('books.style.entries.get', {
    method: 'GET',
    path: '/api/books/:name/style/entries',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const bookRoot = resolveStyleBook(res, params)
    if (!bookRoot) return
    const migration = migrateStyleLibrary(bookRoot)
    const { entries, errors } = readEntries(join(bookRoot, ENTRIES_DIR))
    reply(res, 200, {
      ok: true,
      entries: entries.map((e) => ({ ...e, _path: relPath(bookRoot, e._path) })),
      errors,
      migration: migration.migrated > 0 ? migration : null,
    })
  },
  })

  // 新增条目（源4 作者手动：选中存样章/反例、条目库直接新增）
  defineRoute('books.style.entries.post', {
    method: 'POST',
    path: '/api/books/:name/style/entries',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const bookRoot = resolveStyleBook(res, params)
    if (!bookRoot) return
    const body = (await readJson(req)) as Record<string, unknown>
    const kind = body['类型']
    if (typeof kind !== 'string' || !(ENTRY_KINDS as readonly string[]).includes(kind)) {
      return replyError(res, 400, 'BAD_INPUT', '类型须为 样章/手法/反例/禁词')
    }
    const text = typeof body['正文'] === 'string' ? body['正文'].trim() : ''
    if (!text) return replyError(res, 400, 'BAD_INPUT', '正文为空')
    const scene = typeof body['场景'] === 'string' && body['场景'].trim() ? body['场景'].trim() : '通用'
    const source = body['来源']
    const entry: StyleEntry = {
      类型: kind as EntryKind,
      场景: scene,
      来源: typeof source === 'string' && source in SOURCE_RANK ? (source as EntrySource) : '作者标注',
      ...(typeof body['说明'] === 'string' && body['说明'].trim() ? { 说明: body['说明'].trim() } : {}),
      ...(typeof body['出处'] === 'string' && body['出处'].trim() ? { 出处: body['出处'].trim() } : {}),
      ...(Array.isArray(body['标签']) ? { 标签: (body['标签'] as unknown[]).map(String) } : {}),
      正文: text,
    }
    reply(res, 200, { ok: true, path: addEntry(bookRoot, entry) })
  },
  })

  // 删条目（限 文风/条目/ 内）
  defineRoute('books.style.entries.delete', {
    method: 'DELETE',
    path: '/api/books/:name/style/entries',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const bookRoot = resolveStyleBook(res, params)
    if (!bookRoot) return
    const body = (await readJson(req)) as Record<string, unknown>
    const p = typeof body['path'] === 'string' ? body['path'] : ''
    if (!insideDir(p, ENTRIES_DIR)) {
      return replyError(res, 400, 'BAD_INPUT', 'path 须在 文风/条目/ 内')
    }
    const absPath = join(bookRoot, p)
    // symlink realpath 校验（防 entry.path 中间组件是符号链接 → rmSync 删到书库外）
    // P1-S1：realpathSync 须 try-catch（TOCTOU / 断链 → fail-closed，与其他 safePath 一致）
    if (existsSync(absPath)) {
      try {
        const realBook = realpathSync(bookRoot)
        const realAbs = realpathSync(absPath)
        if (relative(realBook, realAbs).startsWith('..')) {
          return replyError(res, 400, 'BAD_INPUT', '路径越出书库')
        }
      } catch {
        return replyError(res, 400, 'BAD_INPUT', '路径异常')
      }
    }
    rmSync(absPath, { force: true })
    reply(res, 200, { ok: true })
  },
  })

  // 候选列表（状态经 30 天过期呈现；文件不动，已忽略可翻出）
  defineRoute('books.style.candidates', {
    method: 'GET',
    path: '/api/books/:name/style/candidates',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const bookRoot = resolveStyleBook(res, params)
    if (!bookRoot) return
    const t = today()
    const { candidates, errors } = readCandidates(join(bookRoot, CANDIDATES_DIR))
    reply(res, 200, {
      ok: true,
      candidates: candidates.map((c) => ({
        ...c,
        状态: effectiveStatus(c, t),
        _path: relPath(bookRoot, c._path),
      })),
      errors,
    })
  },
  })

  // 确认候选 → 条目库
  defineRoute('books.style.candidates.confirm', {
    method: 'POST',
    path: '/api/books/:name/style/candidates/confirm',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const bookRoot = resolveStyleBook(res, params)
    if (!bookRoot) return
    const body = (await readJson(req)) as Record<string, unknown>
    const p = typeof body['path'] === 'string' ? body['path'] : ''
    if (!insideDir(p, CANDIDATES_DIR)) {
      return replyError(res, 400, 'BAD_INPUT', 'path 须在 文风/候选/ 内')
    }
    const entryPath = confirmCandidate(bookRoot, p)
    if (entryPath === null) {
      return replyError(res, 404, 'NOT_FOUND', '候选不存在或已损坏')
    }
    reply(res, 200, { ok: true, entryPath })
  },
  })

  // 忽略候选（落盘留档）
  defineRoute('books.style.candidates.ignore', {
    method: 'POST',
    path: '/api/books/:name/style/candidates/ignore',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const bookRoot = resolveStyleBook(res, params)
    if (!bookRoot) return
    const body = (await readJson(req)) as Record<string, unknown>
    const p = typeof body['path'] === 'string' ? body['path'] : ''
    if (!insideDir(p, CANDIDATES_DIR)) {
      return replyError(res, 400, 'BAD_INPUT', 'path 须在 文风/候选/ 内')
    }
    if (!ignoreCandidate(bookRoot, p)) {
      return replyError(res, 404, 'NOT_FOUND', '候选不存在或已损坏')
    }
    reply(res, 200, { ok: true })
  },
  })

  // 收割（零 AI：源1 轨迹比对 + 源2 漂移映射；查重闸保证可重复点）
  defineRoute('books.style.harvest', {
    method: 'POST',
    path: '/api/books/:name/style/harvest',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const bookRoot = resolveStyleBook(res, params)
    if (!bookRoot) return
    const r = harvestStyleCandidates(bookRoot, readKind(bookRoot), today())
    reply(res, 200, { ok: true, created: r.created.length, skipped: r.skipped })
  },
  })

  // 定标数据：铁律阈值（纯配置本身，不合并条目禁词）+ 基线摘要 + 注入强度。
  // 注入强度是喂写作链路的有效值——readBookConfig 结果过 applyGlobalDefaults
  // （书级未设 → global.json styleInjection → 硬编码 'light'；raw 判断归 /config 端点）
  defineRoute('books.style.config', {
    method: 'GET',
    path: '/api/books/:name/style/config',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const bookRoot = resolveStyleBook(res, params)
    if (!bookRoot) return
    const rulesFile = join(bookRoot, '文风', '文风铁律.md')
    const rules = existsSync(rulesFile) ? parseIronRules(readFileSync(rulesFile, 'utf-8')) : {}
    const baseline = readBaseline(bookRoot)
    const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
    const injection = applyGlobalDefaults(cfg.config, ctx.userDataPath).style.injection
    reply(res, 200, {
      ok: true,
      rules,
      baseline: baseline
        ? { frozenAt: baseline.frozenAt, frozenFrom: baseline.frozenFrom, scenes: Object.keys(baseline.byScene) }
        : null,
      injection,
    })
  },
  })

  // 重新冻结基线（条目库样章按场景算指纹；无样章 → 400 诚实报错）
  defineRoute('books.style.baseline.freeze', {
    method: 'POST',
    path: '/api/books/:name/style/baseline/freeze',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const bookRoot = resolveStyleBook(res, params)
    if (!bookRoot) return
    try {
      const b = freezeBaseline(bookRoot)
      reply(res, 200, { ok: true, baseline: { frozenAt: b.frozenAt, frozenFrom: b.frozenFrom, scenes: Object.keys(b.byScene) } })
    } catch (e) {
      // P2-4：API 错误脱敏
      replyError(res, 400, 'NO_SAMPLES', redactSecret(e instanceof Error ? e.message : String(e)))
    }
  },
  })
}
