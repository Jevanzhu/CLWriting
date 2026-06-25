/**
 * 体检 REST 端点（#12.3 + 7.1）。
 *
 * - GET /api/books/:name/health/metrics  成本/审查（aggregateMetrics → MetricsReport）
 * - GET /api/books/:name/health/style     文风（aggregateStyleTrend → StyleTrend）
 *
 * 复用内核聚合函数，直接返结构化对象（不走人话 format）。后端零新增逻辑。
 * 空书（count=0）照常返对象，前端渲染空态。
 */
import { join } from 'node:path'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { readMetrics } from '../../../metrics/ledger.js'
import { aggregateMetrics } from '../../../metrics/report.js'
import { scanLongChapters, scanShortPieces, aggregateStyleTrend, readBaseline } from '../../../metrics/style.js'

interface HealthCtx {
  workDir: string | null
}

/** 注册体检路由（server 启动时调用一次） */
export function registerHealthRoutes(ctx: HealthCtx): void {
  // 成本/审查
  route('GET', '/api/books/:name/health/metrics', (_req, res, params) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return reply(res, r.status, { error: r.error })
    reply(res, 200, aggregateMetrics(readMetrics(r.bookRoot), {}))
  })

  // 文风
  route('GET', '/api/books/:name/health/style', (_req, res, params) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return reply(res, r.status, { error: r.error })
    const kind = resolveKind(r.bookRoot)
    const samples = kind === 'short' ? scanShortPieces(r.bookRoot) : scanLongChapters(r.bookRoot)
    reply(res, 200, aggregateStyleTrend(samples, kind, readBaseline(r.bookRoot)))
  })
}

/** 解析书：找 entry → bookRoot；workDir 缺 / 书不存在 → error 联合 */
function resolveBook(
  workDir: string | null,
  name: string | undefined,
): { bookRoot: string } | { error: string; status: number } {
  if (!workDir) return { error: '未定位到工作目录', status: 400 }
  if (!name) return { error: '缺少书名', status: 400 }
  const entry = readBooks(workDir).find((b) => b.name === name)
  if (!entry) return { error: `没有这本书：${name}`, status: 404 }
  return { bookRoot: join(workDir, entry.path) }
}

/** 读 book.yaml kind（缺省 long） */
function resolveKind(bookRoot: string): 'long' | 'short' {
  const { config } = readBookConfig(join(bookRoot, 'book.yaml'))
  return config.kind === 'short' ? 'short' : 'long'
}
