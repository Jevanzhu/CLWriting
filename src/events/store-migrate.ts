/**
 * 事件库定位与迁移锁族（bookHash/trueCasePath + session 迁移锁三件套）—— 自
 * src/events/store.ts 缝 C 拆出。
 *
 * （⑤④产品巨件拆分波3）：store.ts（1355 行）三缝纯移动拆分。
 * 本文件承载缝 C 的可移部分：书 hash 定位族（bookHash + trueCasePath win32 大小写
 * 归一与 memo 缓存，/）+ 迁移锁族（getSessionMigrateLockTimeoutMs
 * testableConst、sessionMigrateLockPath 按书分锁、acquireMigrateLockPairAsync 排序
 * 双锁，//）原样随迁（零行为变化，历史注释原样随代码迁移）。
 * 实读偏差记档：侦察口径的 migrate 缝（约 275 行）以 migrateBookSession 为主——
 * 其一被 test/events/store-migrate-tombstone.test.ts 写侧静态扫描钉在 store.ts 源文本
 * （断言 store.ts 内含 atomicWriteFile 拼接 MIGRATED_EXT 的墓碑预写调用点），其二
 * 消费 openStores 单例与 closeEventsDb（后者被结构契约钉在 store.ts），
 * 移出必造残核与本文件环回引（违本批 TDZ 纪律），故 migrateBookSession 留残核、
 * 定位族与锁族迁此、本缝收窄为 121 行。
 * 依赖方向单向（无环回引）：只 import node:crypto/node:fs/node:path 与
 * ../fs/cross-process-lock.js、../shared/testable.js，不 import events/store.ts；
 * 残核开库壳（openSessionStore/Async）与迁移段自本文件 import，四个公开名
 * （bookHash/sessionMigrateLockPath/getSessionMigrateLockTimeoutMs/
 * __setSessionMigrateLockTimeoutForTest）经残核桥再导出，全库消费方 import 面
 * 零改动；acquireMigrateLockPairAsync 原模块私有、残核跨文件消费就此导出，
 * trueCasePath/trueCaseCache/TRUE_CASE_CACHE_MAX 保持私有。
 * firstOpenStore（残核巨型对象字面量，重设计立案件）本批零触碰。
 */
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'
import { testableConst } from '../shared/testable.js'

/** 书 hash：sha256(bookRoot) 前 16 hex——稳定，不落原文路径。
 *  （补修）：哈希前 resolve 归一化——尾分隔符 / '.'/'..' 段变体不再
 *  同书分裂两库（原先 sha256 原样入参，路径形态敏感）。存量安全：调用点路径源于
 *  books.json 单源的绝对无尾斜杠形态，resolve 对其恒等 → 存量库键不变、无孤儿化。
 *  ：win32 上大小写漂移收口——书路径大小写漂移（盘符大小写/手工改名
 *  残留/注册时序不同）此前可开出第二个事件库文件（对话史/审计视图「丢史」假象）。
 *  归一手段是**逐段 readdirSync 大小写不敏感匹配盘上真名**（trueCasePath，memo 化）：
 *  初版用 fs.realpathSync，但 Node 在 win32 的 realpath 实测**不改写大小写**
 *  （返回入参形态，四十轮修复批当机复验），对漂移变体是无效修复——readdir 逐段匹配
 *  才拿得到盘上真实形态。正确大小写的存量路径逐段命中自身 → 键不变（不迁移）；
 *  漂移变体归一到真名后与正库同键合流。仅 win32 生效——mac/Linux 维持既有
 *  口径（Linux 大小写变体是不同路径；mac 折叠语义与卷敏感性脱钩属登记，
 *  且 blanket 启用会重键存量库）。段消失/不可读（规划中的新建书等）→ 回落 resolve
 *  词法形态，语义同旧；UNC（\\\\server\\share）首层无盘符可依，同样回落。 */
export function bookHash(bookRoot: string): string {
  let root = resolve(bookRoot)
  if (process.platform === 'win32') {
    root = trueCasePath(root)
  }
  return createHash('sha256').update(root).digest('hex').slice(0, 16)
}

/** win32 盘上真实大小写归一（逐段 readdir 匹配 + memo）。
 *  （备注级维持， win 适配修复批）：书库在
 *  失联网络卷时逐段 readdirSync 会同步冻结 server 子进程——同步 IO 无超时手段可挡，
 *  彻底闭合需 bookHash 全链异步化（牵动全部调用面，超出维持项范畴）。现实防线 =
 *  memo 512 条（每路径仅首次真探）+ 主进程 probeDirReachable 预探覆盖 GUI 全部入口；
 *  且失联卷上同链路的其他同步读（books.jsonl 等）会先于本函数暴露同一冻结面，
 *  边际风险不构成单点。 */
const trueCaseCache = new Map<string, string>()
const TRUE_CASE_CACHE_MAX = 512

function trueCasePath(abs: string): string {
  const lower = abs.toLowerCase()
  const hit = trueCaseCache.get(lower)
  if (hit !== undefined) return hit
  const segs = abs.split(/[\\/]/).filter((s) => s !== '')
  let cur = ''
  let ok = true
  for (let i = 0; i < segs.length && ok; i++) {
    const seg = segs[i]!
    if (cur === '') {
      // 首段：盘符统一大写并带根（'c:' → 'C:\'，readdirSync('C:') 是驱动器相对路径
      // 不可用）；UNC 首段为主机名（'\\server\share\…' → '\\\\server'，可 readdir 列共享）
      cur = seg.endsWith(':') ? seg.toUpperCase() + '\\' : '\\\\' + seg
      continue
    }
    let next: string | null = null
    try {
      for (const entry of readdirSync(cur)) {
        if (entry.toLowerCase() === seg.toLowerCase()) {
          next = entry
          break
        }
      }
    } catch {
      ok = false
      break
    }
    if (next === null) {
      ok = false
      break
    }
    cur = cur.endsWith('\\') ? cur + next : `${cur}\\${next}`
  }
  if (!ok || cur === '') cur = abs // 段消失/不可读/空路径：回落词法形态（语义同旧）
  // FIFO 淘汰（书数量级小，上限为防御性口径，对齐库内缓存族惯例）
  if (trueCaseCache.size >= TRUE_CASE_CACHE_MAX) {
    const oldest = trueCaseCache.keys().next().value
    if (oldest !== undefined) trueCaseCache.delete(oldest)
  }
  trueCaseCache.set(lower, cur)
  return cur
}

/** session 目录级跨进程锁超时（毫秒）——迁移段与首开段互斥用，
 *  对齐 books.lock 的 5s（争用为文件 IO 级毫秒，极保守）。
 *  ：停止裸导出——`export let` 使模块态可被任何导入方静默改写，
 *  且「读侧直读 + 写侧 setter」两条通道并存。全仓 grep 生产与测试均无外部直读直写
 *  （仅本模块四处消费 + ForTest setter），收口为模块内可变生效值 + 仅供测试的
 *  ForTest setter（同款惯例见 summary.ts / lead-update-draft.ts ）。
 *  ：三件套换装 testableConst——生效值 getter 逐消费点
 *  显式调用，测试注入走元组第二位（原名 __setSessionMigrateLockTimeoutForTest
 *  签名不变）。 */
export const [getSessionMigrateLockTimeoutMs, __setSessionMigrateLockTimeoutForTest] = testableConst(5_000)

/** 首开/迁移段跨进程锁（导出供回归测试模拟「另一进程持锁」；同进程嵌套获取
 *  同一锁会自锁——本模块持锁段对同一 bookHash 的锁互不嵌套）。
 *  ：锁名掺 bookHash——原先全局单把 migrate.lock 把所有书的首开段
 *  串成全局队头（多书库场景下开书 B 被无关书 A 的迁移/首开阻塞 5s 即失败）。改按书
 *  一把 `migrate-<bookHash>.lock`：开书/迁移只与**同一本书**（新旧路径两个 hash）互斥。
 *  迁移段须同持新旧两把（bookHash 排序获取防 ABBA 死锁）——openSessionStore(newRoot)
 *  与迁移 rename 窗口的互斥由此保持（Global 锁的唯一实质保护面），跨书并发不再互拽。 */
export function sessionMigrateLockPath(userDataPath: string, bookRoot: string): string {
  return join(userDataPath, 'clwriting', 'session', `migrate-${bookHash(bookRoot)}.lock`)
}

/** 迁移段按 bookHash 排序拿新旧两把锁；第二把拿不到 → 释放第一把返回 null（调用方按
 *  超时语义放弃迁移，源库原地完整）。排序获取保证任意迁移对之间无环路死锁。
 *  ：锁等待异步化（acquireCrossProcessLockAsync，setTimeout 轮询）——
 *  改名端点（books.ts）在服务进程事件循环上调用 migrateBookSession，同步 Atomics.wait
 *  会在双进程争用窗内把事件循环停 2×5s；同步对版随之退役（唯一调用方已随迁）。 */
export async function acquireMigrateLockPairAsync(
  userDataPath: string,
  oldRoot: string,
  newRoot: string,
): Promise<(() => void) | null> {
  const [first, second] =
    bookHash(oldRoot) <= bookHash(newRoot)
      ? [sessionMigrateLockPath(userDataPath, oldRoot), sessionMigrateLockPath(userDataPath, newRoot)]
      : [sessionMigrateLockPath(userDataPath, newRoot), sessionMigrateLockPath(userDataPath, oldRoot)]
  const releaseFirst = await acquireCrossProcessLockAsync(first, getSessionMigrateLockTimeoutMs())
  if (!releaseFirst) return null
  const releaseSecond = await acquireCrossProcessLockAsync(second, getSessionMigrateLockTimeoutMs())
  if (!releaseSecond) {
    releaseFirst()
    return null
  }
  return () => {
    releaseSecond()
    releaseFirst()
  }
}
