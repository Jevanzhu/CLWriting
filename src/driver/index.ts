/**
 * driver 入口：按 host 选 driver + 管理 bookId → session 映射。
 *
 * mock = 假事件流（e2e / 前端开发）；cc = provider 直连（无 CLI）。
 */
import type { Session, StudioDriver } from './types.js'
import { mockDriver } from './mock.js'
import { ccDriver } from './cc.js'

export type {
  Session,
  SessionOptions,
  ApprovalResponse,
  DriverEvent,
  StudioDriver,
} from './types.js'

/** bookId → 当前 session(一个 book 一个 driver session,方案 9.2) */
const sessions = new Map<string, Session>()

/** 取 driver:env CLWRITING_DRIVER=mock → mock(e2e);host='mock' → mock(开发/debug);其余 → cc(provider 直连) */
export function getDriver(host: string): StudioDriver {
  if (process.env.CLWRITING_DRIVER === 'mock') return mockDriver
  return host === 'mock' ? mockDriver : ccDriver
}

/** 取 / 建某书的 session(已存在且未关则复用) */
export async function ensureSession(bookId: string, cwd: string): Promise<Session> {
  const existing = sessions.get(bookId)
  if (existing && !existing.closed) return existing
  const driver = getDriver('cc')
  const session = await driver.startSession(cwd)
  sessions.set(bookId, session)
  return session
}
