/**
 * 启动通告端点（迭代方向 A4 / 批 0）。
 *
 * 启动链迁移失败（migrate-prompts / repair-books / layout-v2/v3 / migrate-defaults …）
 * 此前只有 console.error 一个出口——Electron 打包态 console 输出到无人看见的地方，
 * 用户对「迁移失败、旧数据保留在哪」完全失明。本端点把启动期收集的通告透给前端
 * App 级横幅（一次性，关闭后不再弹；新通告再出现会再弹）。
 *
 * 通告是进程内存态（随 server 生命周期）：不落库、不重试自动化——数据保全前提下
 * 人工介入优先（方向方案 A4 边界）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply } from '../http.js'

export interface StartupNotice {
  /** ISO 时间戳 */
  ts: string
  /** 机器可判别来源（'migrate-prompts' / 'events-migration' / …） */
  kind: string
  /** 人话（含旧库路径等可操作信息——本端点仅本机回环 + 同源可读，不外泄） */
  message: string
}

export interface StartupNoticeSink {
  notices: StartupNotice[]
  add: (kind: string, message: string) => void
}

/** 每个 server 实例独立的通告收集器（startServer 闭包持有，随实例生命周期）。 */
export function createStartupNoticeSink(): StartupNoticeSink {
  const notices: StartupNotice[] = []
  return {
    notices,
    add(kind: string, message: string): void {
      notices.push({ ts: new Date().toISOString(), kind, message })
    },
  }
}

export function registerStartupNoticeRoutes(ctx: { sink: StartupNoticeSink }): void {
  defineRoute('startup-notices', {
    method: 'GET',
    path: '/api/startup-notices',
    handler: (_, _req: IncomingMessage, res: ServerResponse) => {
    reply(res, 200, { notices: ctx.sink.notices })
  },
  })
}
