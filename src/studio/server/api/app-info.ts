/**
 * 阶段 53：应用信息端点（`GET /api/app-info`）；阶段 55 扩更新链两字段。
 *
 * 无入参、无凭据落地：回 `{ version, update, updateAttempt }`——`version` 走 update/check
 * 的版本单源（env `CLW_APP_VERSION` 优先，缺省回退 package.json），`update` 为进程内
 * 检查结果（含便携资产面；`null` = 未完成或已查无新版），`updateAttempt` 为上次更新
 * 尝试的结果条（见下）。
 *
 * 端点不持任何检查状态：检查由起服链延迟触发（`src/studio/server/index.ts`），
 * 本端点只是读口——故无需 ctx（与 registerStartupNoticeRoutes 需 sink 的区别）。
 * token 闸由路由分派层统一施加（GET /api/* 走 x-studio-token，同全局口径）。
 *
 * 结果条（阶段 55）：更新助手进程写在共享根 `<home>/更新缓存/更新结果.json`，本端点
 * **取一次即删**（`takeUpdateAttemptNote`）——它是跨进程的一次性信箱，唯一作用是把
 * 「上次更新没成」送进新起进程的界面。这是本端点唯一的写副作用：`applied`（成功换新）
 * 静默消费（用户看不到多余提示），`aborted`/`rolled-back` 原样回给提示面展示原因。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply } from '../http.js'
import { resolveAppVersion, getUpdateCheckResult } from '../../../update/check.js'
import { takeUpdateAttemptNote } from '../../../update/cache.js'

export function registerAppInfoRoutes(opts: { userDataPath: string | null }): void {
  defineRoute('app-info', {
    method: 'GET',
    path: '/api/app-info',
    handler: (_ctx, _req: IncomingMessage, res: ServerResponse) => {
      const note = opts.userDataPath ? takeUpdateAttemptNote(opts.userDataPath) : null
      reply(res, 200, {
        version: resolveAppVersion(),
        update: getUpdateCheckResult(),
        updateAttempt: note && note.outcome !== 'applied' ? note : null,
      })
    },
  })
}
