/**
 * 分析端点（M12 B0.2/B4，editor 组）——路由声明面。
 *
 * GET  /api/books/:name/documents/:docId/analysis/:kind
 *   → 读 项目/分析/<docId>.json 中该 kind 的信封 + stale 标志（无 AI 依赖）。
 *
 * POST /api/books/:name/documents/:docId/analyze  body {kind}
 *   → docId → 正文（strip fm）→ 组 prompt → generateTool(submit_<kind>) → 信封落盘
 *   → 信封落盘；kind ∈ {score/emotion/hooks/style}（review 走独立三审端点）。
 *
 * 信封落盘与展示解耦：AI 不可达时存量照常展示，仅「重新分析」置灰（无开关、置灰不隐藏）。
 *
 * 编排体（信封读写/stale、四站 runGatedGeneration 回调、overview 与 style 聚合）下沉
 * analysis-ops.ts；缓存族与聚合计算下沉 analysis-cache.ts。本文件只留 ctx 注入面、
 * method/path 声明与一行转调；两档对本文件只有 type 面回引 AnalysisCtx（编译期擦除），
 * 模块图无环。既有外部消费名（getAnalysisOverviewCached / analysisOverviewCache /
 * forgetStyleCorpusCache / forgetAnalysisOverviewCache）经下方桥逐名再导出，消费方
 * import 面零改动。
 *
 * 四站 runGatedGeneration 的闸调用点保持在本文件原位（book/workDir/action/busyText 与
 * 回调接线都在站点处）：known-actions-audit 按真实调用点对账 action 字面量，
 * 闸口径（编排互斥 + 任务闸 + 中断通道）单源在 task-gate.ts。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { resolveBookOrReply } from '../book-context.js'
import type { ProviderRuntime } from '../../../ai/provider/store.js' // provider 运行时端口（组装根注入）
import type { DriverHost } from '../driver-port.js' // driver 经组装根注入
import type { TaskGateInjected } from './task-gate.js'
import {
  handleAnalysisGet,
  handleAnalysisOverview,
  runAnalyzeGated,
  runAnalyzeStyleGated,
  runAutotagGated,
  runInferMetaGated,
} from './analysis-ops.js'

export interface AnalysisCtx extends TaskGateInjected {
  /** driver 宿主（mock 选择结果 / 会话面）——组装根注入 */
  driver: DriverHost
  /** provider 运行时端口——组装根注入（档位解析） */
  providers: ProviderRuntime
  workDir: string | null
  userDataPath: string | null
  /** 收尾：styleCorpus / analysisOverview 两缓存 TTL 覆盖档——组装根
   * RouteOverrides 注入（undefined = 生产口径 5s 逐位不变） */
  styleCorpusTtlMs?: number | null
  analysisOverviewTtlMs?: number | null
}

// 缓存族（style-corpus / analysis-overview 实例与失效挂点）与迁移自本文件的消费名——
// 缓存求值只发生在本模块被求值时一次（analysis-cache.ts 顶层单源），本桥不改语义
export {
  getAnalysisOverviewCached,
  analysisOverviewCache,
  forgetStyleCorpusCache,
  forgetAnalysisOverviewCache,
} from './analysis-cache.js'

export function registerAnalysisRoutes(ctx: AnalysisCtx): void {
  // 读信封 + stale（无 AI 依赖；打开文档时读存量展示）
  defineRoute('books.documents.analysis', {
    method: 'GET',
    path: '/api/books/:name/documents/:docId/analysis/:kind',
    handler: (routeCtx, _req, res) => handleAnalysisGet(ctx, routeCtx, res),
  })

  // 重新分析（B4.0）：kind → generateTool(submit_<kind>) → 落信封
  defineRoute('books.documents.analyze', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/analyze',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookGuard(ctx, params, res)
      if (!r) return
      // 编排互斥预检 +任务闸（409 文案逐位保留）+
      // 中断通道接线——十段复制收编
      // runGatedGeneration 单源（ctrl 注册名
      // 'analyze:<书名>' 逐位保留，owner 分槽语义见 task-gate.ts 包装头注）。
      return ctx.gate.runGatedGeneration(
        res,
        {
          book: params['name']!,
          workDir: ctx.workDir!,
          action: 'analyze',
          busyText: '本书已有分析任务在跑，请等待完成后再试',
        },
        (ctrl) => runAnalyzeGated(ctx, { params, bookRoot: r.bookRoot }, req, res, ctrl),
      )
    },
  })

  // AI 章节标签识别：generateTool(submit_tags) → 结构化返回（不落信封；前端拿结果写 fm）。
  defineRoute('books.documents.autotag', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/autotag',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookGuard(ctx, params, res)
      if (!r) return
      // （409 文案逐位保留）+ 中断通道（register/unregister 形态
      // 与 analyze 子端点同款；owner 按 action 分槽='autotag:<书名>'）——十段复制收编
      // runGatedGeneration 单源（接法头注见 analyze 处）。
      return ctx.gate.runGatedGeneration(
        res,
        {
          book: params['name']!,
          workDir: ctx.workDir!,
          action: 'autotag',
          busyText: '本书已在识别章节标签，请等待完成后再试',
        },
        (ctrl) => runAutotagGated(ctx, { params, bookRoot: r.bookRoot }, res, ctrl),
      )
    },
  })

  // AI 推断目标情绪/核心反转：generateTool(submit_infer_meta) → 结构化返回（不落信封；前端写 fm）。
  // 与 autotag 同构——读正文 → AI 反推 → 返回；长短篇通用（正文 fm 均有这两字段）。
  defineRoute('books.documents.infer-meta', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/infer-meta',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookGuard(ctx, params, res)
      if (!r) return
      // （409 文案逐位保留）+ 中断通道（owner='infer-meta:<书名>'）——
      // 十段复制收编 runGatedGeneration 单源（接法头注见 analyze 处）。
      return ctx.gate.runGatedGeneration(
        res,
        {
          book: params['name']!,
          workDir: ctx.workDir!,
          action: 'infer-meta',
          busyText: '本书已在推断目标情绪，请等待完成后再试',
        },
        (ctrl) => runInferMetaGated(ctx, { params, bookRoot: r.bookRoot }, res, ctrl),
      )
    },
  })

  // ── 全书聚合趋势：遍历 分析/<docId>.json 拼趋势序列（无 AI 依赖）──
  defineRoute('books.analysis-overview', {
    method: 'GET',
    path: '/api/books/:name/analysis-overview',
    handler: (routeCtx, _req, res) => handleAnalysisOverview(ctx, routeCtx, res),
  })

  // ── 全书文风分析：全文 stats + 最近 10 章采样 → AI → __book__.json ──
  defineRoute('books.analyze-style', {
    method: 'POST',
    path: '/api/books/:name/analyze-style',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookGuard(ctx, params, res)
      if (!r) return
      // （409 文案逐位保留）+ 中断通道（owner='analyze-style:<书名>'）——
      // 十段复制收编 runGatedGeneration 单源（接法头注见 analyze 处）。
      return ctx.gate.runGatedGeneration(
        res,
        {
          book: params['name']!,
          workDir: ctx.workDir!,
          action: 'analyze-style',
          busyText: '本书正在做文风分析，请等待完成后再试',
        },
        (ctrl) => runAnalyzeStyleGated(ctx, { params, bookRoot: r.bookRoot }, res, ctrl),
      )
    },
  })
}

/** 四站门控端点共用的找书前置门（未找书即回写错误响应并返回 null）。 */
function resolveBookGuard(
  ctx: AnalysisCtx,
  params: Record<string, string>,
  res: ServerResponse,
): { bookRoot: string } | null {
  return resolveBookOrReply(ctx.workDir, params['name'], res)
}
