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
  DriverEvent,
  StudioDriver,
} from './types.js'

/** bookId → 当前 session(一个 book 一个 driver session,方案 9.2) */
const sessions = new Map<string, Session>()

/** 取 driver：env CLWRITING_DRIVER=mock → mock（e2e / 前端开发调试）；其余 → cc（provider 直连）。
 *  R-10（十五轮登记销账）：删 host 形参——全仓唯一实参 'cc'，host==='mock' 分支零调用面
 *  （死参数假扩展）；选择只走 env（e2e global-setup 依赖此口径）。真多 host 时再加显式
 *  参数并落配置 resolve，不预留空壳。 */
export function getDriver(): StudioDriver {
  return process.env.CLWRITING_DRIVER === 'mock' ? mockDriver : ccDriver
}

/** 取 / 建某书的 session(已存在且未关则复用) */
export async function ensureSession(bookId: string, cwd: string): Promise<Session> {
  const existing = sessions.get(bookId)
  if (existing && !existing.closed) return existing
  const driver = getDriver()
  const session = await driver.startSession(cwd)
  // Q-2（第十五轮）：await 返回后重查——并发首建时两个调用方都在对方 set 之前 miss，
  // 各自 startSession 后 set 互相覆盖：被覆盖 session 的 channel/ctrl 表永久无人
  // dispose（泄漏），且 spawn 登记在旧 session 上的 ctrl 让后续调用方拿到的 session
  // 查不到（/interrupt 失效、SSE 快照假空闲）。先到者入表胜出，晚到者 dispose 自己
  // 新建的再复用既有条目。
  const winner = sessions.get(bookId)
  if (winner && !winner.closed && winner !== session) {
    driver.dispose(session)
    return winner
  }
  sessions.set(bookId, session)
  return session
}

/** 只读查某书现存 session（不建不 dispose）——S5（五十九轮）：/interrupt 等入口判
 *  「会话是否存在」用；无会话时不得经 ensureSession 隐式新建（新 channel 无人 dispose）。 */
export function getSession(bookId: string): Session | null {
  const s = sessions.get(bookId)
  return s && !s.closed ? s : null
}

/** 清除某书的 session（删书时调用，释放 channel + ctrl 等资源） */
export function forgetSession(bookId: string): void {
  const session = sessions.get(bookId)
  if (session) {
    getDriver().dispose(session)
    sessions.delete(bookId)
  }
}
