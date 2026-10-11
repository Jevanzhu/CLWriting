/**
 * 书键缓存登记表（登记制单源，零依赖叶子件）。
 *
 * 根因：书键缓存（键含 bookRoot 的 TTL/指纹结果缓存）靠手工清单编排失效时，新增书级缓存漏加
 * 一行即跨书陈旧数据串味（删/改名后同名重建书读到旧书结果），无编译期/运行时兜底。本件把
 * 「创建即登记」制度化：
 * - 各缓存模块在**模块顶层**调用 registerBookKeyedCache(name, forgetFn) 自登记——forgetFn
 *  (bookRoot) 语义（谁被清 / 按什么键清 / 何时清）不变，各缓存 TTL/容量/键口径不动，TTL 仍是
 *   兜底自愈；
 * - 聚合入口 src/studio/server/api/books-lifecycle.ts 以 import 把各缓存模块拉进求值（登记靠
 *   模块被 import 才发生）——「新增书键缓存 = 新建模块顶层自登记 + 聚合入口加一行 import」；
 * - 机器门（test/studio/server/ttl-cache.test.ts「书键缓存登记制对账」）把 src/** 全部 forget*
 *   导出与登记表实际登记项对账：漏登记、登记死项、僵尸豁免均顶红——完整性不靠人记。
 *
 * 执行序：按登记序执行（= 各模块求值序，同一构建内确定）。当前各 forgetFn 只删本模块私有
 * Map/Set（互不读写、无跨缓存耦合），任意排列终态相同，故先后无语义（含 shelf-guard 整表
 * clear——键为 workDir+path 复合键，与 bookRoot 前缀无关）。
 * 红线：若将来某个 forgetFn 需要读另一缓存的中间态，「顺序无语义」不再成立——必须改为显式
 * 排序（本表引入 ordinal 或在聚合入口按序排序登记）并更新本论断。
 *
 * 位置取舍：按「零依赖、避免环」定位在 server 层（server 是失效编排的调用面所在）。ai 侧两条
 * 书键缓存（ai/calls.ts 的 forgetMigratedRoots、ai/rules/setting-rule.ts 的 forgetSettingCache）
 * 因 src/ai/** 零 studio 直连方向锁（test/governance/ai-studio-direction.test.ts）不能自登记，
 * 由聚合入口代登记——登记语义与其余相同，机器门照常对账。
 */

/** 书键缓存失效函数：语义 = 删/改名时按 bookRoot 清理本缓存（逐位对齐历史挂点）。 */
export type BookKeyedCacheForget = (bookRoot: string) => void

/** 登记项（name 供诊断与机器门对账；forgetFn.name 供机器门反查源码导出）。 */
export interface BookKeyedCacheEntry {
  readonly name: string
  readonly forget: BookKeyedCacheForget
}

const entries: BookKeyedCacheEntry[] = []
const names = new Set<string>()

/** 模块顶层自登记（重复即抛：ESM 单次求值下只可能是登记名撞车，属接线缺陷）。 */
export function registerBookKeyedCache(name: string, forget: BookKeyedCacheForget): void {
  if (names.has(name)) {
    throw new Error(`[cache-registry] 书键缓存登记名重复：${name}`)
  }
  names.add(name)
  entries.push({ name, forget })
}

/** 一次广播：按登记序遍历全部已登记项（调用面/语义 = 历史 forgetBookKeyedCaches）。 */
export function forgetBookKeyedCaches(bookRoot: string): void {
  for (const e of entries) e.forget(bookRoot)
}

/** 登记项只读快照（机器门对账/诊断用；生产零调用——纯观测读取不改缓存行为）。 */
export function listBookKeyedCaches(): readonly BookKeyedCacheEntry[] {
  return entries.slice()
}
