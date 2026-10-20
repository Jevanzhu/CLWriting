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
 * 位置取舍：住 `src/shared/`——本件零依赖（只碰 node:fs / node:path），而调用面横跨底座层
 * （format/fs/document/cache/state）与组合根（studio/server），没有任何一层能「拥有」它。
 * 放在 server 层会让底座反向依赖组合根（该边现由 test/governance/dependency-direction.test.ts
 * 禁止）；`src/shared/` 是底座之间横向共享的合法位置，两侧都能引而不构成上下反转。
 * ai 侧两条书键缓存（ai/calls.ts 的 forgetMigratedRoots、ai/rules/setting-rule.ts 的
 * forgetSettingCache）因 src/ai/** 零 studio 直连方向锁（test/governance/
 * ai-studio-direction.test.ts）不能自登记，由聚合入口代登记——登记语义与其余相同，
 * 机器门照常对账。
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

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

/**
 * bookRoot 拼写别名：同一本书可能以词法路径与 realpath 两种拼写进入缓存键——
 * 读路径（书架扫描经 resolveWithinRoot）落 realpath 键，写出口（resolveBook）拿词法键；
 * macOS `/var`→`/private/var` 等根链路 symlink 下二者不同，只清一种拼写会漏另一份。
 * 返回「原样 / resolve 后 / 存在则 realpath」去重集合。
 *
 * 调用时机约束：realpath 解析要求路径仍存在。删/改名要在文件系统操作**前**取别名，
 * 操作成功后用 forgetBookKeyedCachesForRoots 广播（删除后旧路径已解析不出 realpath）。
 */
export function bookRootAliases(bookRoot: string): readonly string[] {
  const aliases = new Set<string>([bookRoot, resolve(bookRoot)])
  try {
    aliases.add(realpathSync(bookRoot))
  } catch {
    /* 路径不存在/不可解析：保留词法别名（调用方对账口径） */
  }
  return [...aliases]
}

/** 按一组 bookRoot 别名广播（删/改名在 FS 操作前取好别名，操作成功后调用）。 */
export function forgetBookKeyedCachesForRoots(roots: readonly string[]): void {
  for (const root of roots) {
    for (const e of entries) e.forget(root)
  }
}

/** 一次广播：按登记序遍历全部已登记项（调用面/语义 = 历史 forgetBookKeyedCaches）。 */
export function forgetBookKeyedCaches(bookRoot: string): void {
  forgetBookKeyedCachesForRoots(bookRootAliases(bookRoot))
}

/** 登记项只读快照（机器门对账/诊断用；生产零调用——纯观测读取不改缓存行为）。 */
export function listBookKeyedCaches(): readonly BookKeyedCacheEntry[] {
  return entries.slice()
}
