/**
 * 测试精简批（2026-09-12，台账 L181/L209 预登记项「makeDriver 单源化」）：
 * test/ai 域 ~20 份近同构 mock StudioDriver 的单一真相源。
 *
 * 形态：startSession 返 {id:'mock',cwd,closed:false}、空 stream、dispose 空实现；
 * emit 视 opts.emitted——传入时把事件推进该数组（事件收集型用例断言用），
 * 不传时为 no-op（纯编排用例，不关心事件面）。
 * 异构变体不收编、留在各文件（如 chat-checkpoint-owner 的 registerCtrl 登记、
 * r39-self-heal-guard 的挂起 stream）。
 */
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'

/** 最小 mock driver；emitted 传入即「事件收集型」，缺省即「静默型」 */
export function makeFakeDriver(opts?: { emitted?: DriverEvent[] }): StudioDriver {
  const emitted = opts?.emitted
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void {
      emitted?.push(ev)
    },
  }
}
