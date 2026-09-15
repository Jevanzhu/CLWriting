/**
 * chat 编排测试共享事件助手（R0916-5b 拆分件，2026-09-16）。
 *
 * 拆分来源：test/ai/chat.test.ts 原顶部三个事件提取纯函数原样抽出（export 前缀外
 * 逐字节原样），供 chat.test.ts 残核与各 chat-* 拆分件共用。
 *
 * fake provider 生命周期 / workdir 记账 / hooks 装置不在此收编——各拆分件保留
 * 原单体文件的 beforeAll·afterAll·beforeEach·afterEach + setup() 同构块（与既有
 * chat-abort/chat-settle 等域件同惯例）；FakeProvider 的 setScript 即重置
 * requestCount/lastBody（见 fake-provider.ts），逐件独立 provider 与原单件共享
 * server 语义等价（各用例均先 setScript 再断言计数）。
 */
import type { DriverEvent } from '../../src/driver/types.js'

/** 从事件中提取 chat_* 类型的文本内容 */
export function chatTexts(events: DriverEvent[]): string[] {
  return events.filter((e) => e.type === 'chat_text').map((e) => (e as { text: string }).text)
}

/** chat_done 事件存在 */
export function hasChatDone(events: DriverEvent[]): boolean {
  return events.some((e) => e.type === 'chat_done')
}

/** chat_error 事件 */
export function chatError(events: DriverEvent[]): string | null {
  const ev = events.find((e) => e.type === 'chat_error')
  return ev ? (ev as { error: string }).error : null
}
