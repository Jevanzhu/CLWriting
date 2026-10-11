/**
 * SSE 事件名清单 ↔ DriverEvent 联合的编译期对齐探针。
 *
 * 为什么单独一个文件：探针必须 import driver 的 DriverEvent 联合做逐名断言，而 driver 类型
 * 图不应进 web-next 的构建/类型程序（前端只经 shared 契约底座消费清单）。故本文件不被任何
 * 运行时/前端代码 import，只被根 tsc 编译（同目录 documents.conformance.ts 同款范式）。
 *
 * 纪律：只放类型断言，不写运行时语句；消费端与本文件之外不得再落第二份事件名清单。
 *
 * 被抓的漂移：DriverEvent 联合新增/改名事件而清单未随动，或清单里多出联合已无的名字
 * ——下方两行即编译期报错（`npm run typecheck`），报错信息点名漂移的字面量。
 */
import type { DriverEvent } from '../../driver/types.js'
import type { SseDriverEventType } from './studio.js'

/** 约束为 never：实参不是 never（= 存在漂移名）即编译期报错。 */
type Exhaustive<Drift extends never> = Drift

/** 联合有而清单缺（新事件漏登运行期清单——前端与治理门照旧看不到它）。 */
export type _NoEventMissingFromList = Exhaustive<Exclude<DriverEvent['type'], SseDriverEventType>>

/** 清单有而联合无（事件已删/改名，清单成了僵尸名——前端消费面据此误判）。 */
export type _NoUnknownEventInList = Exhaustive<Exclude<SseDriverEventType, DriverEvent['type']>>
