/**
 * studio 跨包契约底座：SSE 事件名清单 + 跨包数值常量 + dev-api 端口。
 *
 * 为什么落在 shared/contract：这些名字与数值在两端各被消费（服务端 SSE 写出器/dev 端口解析，
 * 前端 SSE 消费面/正文闸/Vite 代理目标），而 web-next 跨包只许 import src/shared/**——单一
 * 事实源必须在此，消费端一律 import，不得再写第二份字面量或名单。
 *
 * 本文件零 import（纯常量与字面量清单）：同时被根 tsc（NodeNext）与 web-next 构建/类型程序
 * 加载，一旦引入跨包导入就把后端整图拖进前端（同目录 documents.ts 头注同款红线）。
 *
 * 机器门：test/governance/studio-token-exempt-sync.test.ts 逐端断言「按名 import 本模块 +
 * 本文件外无同值字面量副本」；SSE 事件名清单与 src/driver/types.ts 的 DriverEvent 联合逐名
 * 等价（编译期钉子 studio.conformance.ts，运行期对账同门）。
 */

// ── 跨包数值常量：一次生成输出的封顶 ─────────────────────────────────────────
// 名字与值的关系（谁是谁的别名）：SSE_BACKPRESSURE_LIMIT 是权威值，其余两个名字都是它的
// 显式别名（`= SSE_BACKPRESSURE_LIMIT`，不得写成第二处字面量）。计量单位随消费端口径不同
// ——服务端按 UTF-8 滞留字节、workbench 按 UTF-16 码元（JS string.length）、对话正文闸按
// 码点——故不并名；同值同锚的是「一次生成输出封顶」这条契约本身。

/** SSE 写背压判死阈值（服务端权威值）：res.write() 返回 false 起累计的滞留字节超此值即
 *  destroy 断连（1MB ≈ 数十条章节级事件；受 MAX_SSE_PER_BOOK 与事件量约束，正常客户端远
 *  达不到）。单位 = UTF-8 字节（Buffer.byteLength）。 */
export const SSE_BACKPRESSURE_LIMIT = 1_000_000

/** 前端工作台正文聚合（textOut）内存封顶——SSE_BACKPRESSURE_LIMIT 的显式别名。
 *  为何同值：两处封的是同一物（一次生成的 AI 正文输出）与同一服务端常量，值必须同源，
 *  否则同一条正文在生成面板可显示、在服务端被断流阈值提前判死。单位与权威值不同：
 *  此处按 UTF-16 码元（与 JS string.length 同口径）。 */
export const MAX_TEXT_OUT = SSE_BACKPRESSURE_LIMIT

/** 前端对话气泡正文闸额度（单条消息上限与列表正文总量上限同额）——同上别名。
 *  单位 = 码点（前端按码点计数与截断）。 */
export const MAX_TEXT_POINTS = SSE_BACKPRESSURE_LIMIT

/** dev-api 缺省端口。消费端：服务端 resolveDevApiPort 缺省值、web-next 的 Vite dev 代理
 *  目标、SSE dev 直连基址回落（dev 下 Vite proxy 会 buffer SSE 断流，故 SSE 直连同一实例）。 */
export const DEV_API_DEFAULT_PORT = 7878

// ── SSE 事件名运行期清单 ────────────────────────────────────────────────────
// 正本是 src/driver/types.ts 的 DriverEvent 联合（服务端 emit 面由该联合编译期约束）；
// 本清单是它的运行期镜像，供前端消费面与治理门读取。代码生成在本仓不引入，故以
// `as const` 数组 + 类型收窄双面表达，并由 studio.conformance.ts 双向钉住逐名等价：
// 联合增删/改名事件而本清单未随动 → `npm run typecheck` 红；治理门同向再对账一次。

/** DriverEvent 联合全部 type 字面量（顺序同联合声明序，无语义）。 */
export const SSE_DRIVER_EVENT_TYPES = [
  'init',
  'text',
  'text_reset',
  'warning',
  'notice',
  'role_spawn',
  'usage',
  'error',
  'interrupted',
  'review-progress',
  'self_heal_phase',
  'self_heal_reset',
  'self_heal_progress',
  'self_heal_batch',
  'self_heal_batch_progress',
  'self_heal_result',
  'done',
  'chat_start',
  'chat_turn',
  'chat_text',
  'chat_tool_pending',
  'chat_tool',
  'chat_tool_result',
  'chat_reset',
  'chat_done',
  'chat_error',
  'chat_replay_begin',
] as const

/** 清单的类型面：SSE 事件名的合法取值集（= DriverEvent['type']，见 conformance 钉子）。 */
export type SseDriverEventType = (typeof SSE_DRIVER_EVENT_TYPES)[number]
