/**
 * 账本七类 REST 端点（#7.3，长篇专属）。
 *
 * GET /api/books/:name/leads → 七类概览 + 推进矩阵 + 停滞预警 + 全部线
 *
 * 数据源：大纲/<七类>/*.md 的 Lead（含履历 LeadEntry + 特化字段），现成。
 * 停滞预警 = GUI 衍生（进行中 + 最后履历距今 ≥N 章），非账本原生字段（#7.3 口径）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, dirname } from 'node:path'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { readChapterDir } from '../../../format/chapters.js'
import { readLeadDir, LEAD_TYPES } from '../../../format/leads.js'
import { readPieceDir } from '../../../format/pieces.js'
import { readPieceList, emptyPieceList } from '../../../format/manifest.js'
import type { Lead, LeadStatus } from '../../../format/types.js'

interface LeadsCtx {
  workDir: string | null
}

/** 停滞阈值：进行中 + 最后履历章距今 ≥N 章（GUI 衍生，N 可配） */
const STALE_THRESHOLD = 3

export function registerLeadsRoutes(ctx: LeadsCtx): void {
  route('GET', '/api/books/:name/leads', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const name = params['name']
    const entry = readBooks(ctx.workDir).find((b) => b.name === name)
    if (!entry) return reply(res, 404, { error: `没有这本书：${name}` })

    const bookRoot = join(ctx.workDir, entry.path)
    const { config } = readBookConfig(join(bookRoot, 'book.yaml'))
    if (config.kind === 'short') {
      return reply(res, 200, leadsShort(bookRoot))
    }
    reply(res, 200, leadsLong(bookRoot))
  })
}

function leadsLong(bookRoot: string): unknown {
  const allLeads: Lead[] = []
  const overview: { 类型: string; total: number; 进行中: number; 已收尾: number; 已放弃: number }[] = []

  for (const t of LEAD_TYPES) {
    const { leads } = readLeadDir(join(bookRoot, '大纲', t))
    allLeads.push(...leads)
    const dist: Record<LeadStatus, number> = { 进行中: 0, 已收尾: 0, 已放弃: 0 }
    for (const l of leads) dist[l.状态]++
    overview.push({ 类型: t, total: leads.length, ...dist })
  }

  // 推进矩阵：所有履历条目汇总（章 × 线 cell = 动词）
  const matrix: { 章号: number; 编号: string; 类型: string; 标题: string; 动词: string; 证据: string }[] = []
  for (const l of allLeads) {
    for (const e of l.履历) {
      matrix.push({ 章号: e.章号, 编号: l.编号, 类型: l.类型, 标题: l.标题, 动词: e.动词, 证据: e.证据 })
    }
  }
  matrix.sort((a, b) => a.章号 - b.章号 || a.编号.localeCompare(b.编号))

  const { chapters } = readChapterDir(join(bookRoot, '定稿', '正文'))
  const currentChapter = chapters.length

  // 停滞预警：进行中 + 最后履历距今 ≥ N
  const stale: { 编号: string; 类型: string; 标题: string; 开启章: number; 最后履历章: number; 距今: number }[] = []
  for (const l of allLeads) {
    if (l.状态 !== '进行中') continue
    const last = l.履历.length ? Math.max(...l.履历.map((e) => e.章号)) : l.开启章
    const gap = currentChapter - last
    if (gap >= STALE_THRESHOLD) {
      stale.push({ 编号: l.编号, 类型: l.类型, 标题: l.标题, 开启章: l.开启章, 最后履历章: last, 距今: gap })
    }
  }

  return { kind: 'long' as const, overview, leads: allLeads.map(stripInternal), matrix, currentChapter, stale }
}

/**
 * 短篇集子总览（#7.3 短篇分支）：跨篇聚合。
 * 每篇：核心反转 / 目标情绪 / 字数 / 情绪峰值（清单情绪曲线 max）/ 伏笔回收率。
 * 数据源 readPieceDir（篇/）+ readPieceList（篇/N-T/清单.md），现成。
 */
function leadsShort(bookRoot: string): unknown {
  const { pieces } = readPieceDir(join(bookRoot, '篇'))
  const sorted = pieces.slice().sort((a, b) => a.篇号 - b.篇号)
  const rows = sorted.map((p) => {
    // 清单：情绪峰值 + 伏笔回收率（容错：无清单 → 空清单）
    const listPath = p._path ? join(dirname(p._path), '清单.md') : ''
    const listResult = listPath ? readPieceList(listPath) : null
    const list = listResult?.ok ? listResult.list : emptyPieceList()
    const curve = list.情绪曲线 ?? []
    const peak = curve.length ? curve.reduce((m, c) => (c.强度 > m.强度 ? c : m), curve[0]!) : null
    const payoffs = list.伏笔回收
    const unresolved = payoffs.filter((e) => e.未回收).length
    const out: Record<string, unknown> = {
      篇号: p.篇号,
      标题: p.标题,
      字数: p._wordCount ?? 0,
    }
    if (p.目标情绪) out['目标情绪'] = p.目标情绪
    if (p.核心反转) out['核心反转'] = p.核心反转
    if (peak) {
      out['情绪峰值'] = peak.强度
      out['情绪类型'] = peak.情绪
    }
    if (payoffs.length) {
      out['回收率'] = `${payoffs.length - unresolved}/${payoffs.length}`
      if (unresolved > 0) out['未回收数'] = unresolved
    }
    return out
  })
  const totalWords = rows.reduce((s, r) => s + (r['字数'] as number), 0)
  return {
    kind: 'short' as const,
    pieces: rows,
    summary: {
      总篇数: rows.length,
      总字数: totalWords,
      平均篇长: rows.length ? Math.round(totalWords / rows.length) : 0,
    },
  }
}

/** 去掉 readLead 回填的内部字段（_path/_fmOrder/_bodyBeforeHistory 等），只留账本语义 */
function stripInternal(l: Lead): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(l)) {
    if (!k.startsWith('_')) out[k] = v
  }
  return out
}
