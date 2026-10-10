/**
 * 诊断包端点（`POST /api/diagnostics`）：按口径收集并打包 → 回包路径与条目清单。
 *
 * - APP 级（非书级）端点：诊断包描述的是应用与运行环境，与当前打开哪本书无关，
 *   故路径不在 `/api/books/:name/...` 下；`workDir` 只用于「书数」计数与路径脱敏。
 * - 写动作走 POST（写 token 闸覆盖：路由分派层对一切 POST 施加 session token 校验）。
 * - 版本号取 update/check 的版本单源（与 /api/app-info 同源，env 优先回退 package.json）。
 * - 同步 IO（MB 级，设置页显式动作，非热路径）→ 不起 worker。
 * - 失败回 422 错误信封（同导出域 EXE* 家族口径：业务失败不穿 500 兜底）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { buildDiagnosticsBundle } from '../../../diagnostics/index.js'
import { resolveAppVersion } from '../../../update/check.js'

interface DiagCtx {
  workDir: string | null
  userDataPath: string | null
}

export function registerDiagnosticsRoutes(ctx: DiagCtx): void {
  defineRoute('diagnostics.build', {
    method: 'POST',
    path: '/api/diagnostics',
    handler: (_ctx, _req: IncomingMessage, res: ServerResponse) => {
      const r = buildDiagnosticsBundle({
        userDataPath: ctx.userDataPath,
        workDir: ctx.workDir,
        appVersion: resolveAppVersion(),
      })
      if (!r.ok) return replyError(res, 422, 'DIAGNOSTICS_FAILED', r.error ?? '诊断包生成失败')
      reply(res, 200, {
        ok: true,
        file: r.file,
        dir: r.dir,
        entries: r.entries,
        bytes: r.bytes,
        ...(r.warnings && r.warnings.length > 0 ? { warnings: r.warnings } : {}),
      })
    },
  })
}
