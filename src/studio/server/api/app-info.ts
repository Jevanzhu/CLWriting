/**
 * 阶段 53：应用信息端点（`GET /api/app-info`）。
 *
 * 只读、无入参、无凭据落地：回 `{ version, update }`——`version` 走 update/check 的
 * 版本单源（env `CLW_APP_VERSION` 优先，缺省回退 package.json），`update` 为进程内
 * 检查结果（`null` = 未完成或已查无新版；设计 §3.1/§六 端点形状）。
 *
 * 端点不持任何检查状态：检查由起服链延迟触发（`src/studio/server/index.ts`），
 * 本端点只是读口——故无需 ctx（与 registerStartupNoticeRoutes 需 sink 的区别）。
 * token 闸由路由分派层统一施加（GET /api/* 走 x-studio-token，同全局口径）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply } from '../http.js'
import { resolveAppVersion, getUpdateCheckResult } from '../../../update/check.js'

export function registerAppInfoRoutes(): void {
  defineRoute('app-info', {
    method: 'GET',
    path: '/api/app-info',
    handler: (_ctx, _req: IncomingMessage, res: ServerResponse) => {
      reply(res, 200, { version: resolveAppVersion(), update: getUpdateCheckResult() })
    },
  })
}
