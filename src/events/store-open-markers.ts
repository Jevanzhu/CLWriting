/**
 * 跨进程开口标记 + 迁移墓碑族 —— 自 src/events/store.ts 缝 A 拆出。
 *
 * R0916-5g（2026-09-16，⑤④产品巨件拆分波3）：store.ts（1355 行）三缝纯移动拆分。
 * 本文件承载缝 A：R67-2 跨进程「已持有句柄」标记与迁移墓碑的常量
 * （OPEN_MARKER_SUFFIX/MIGRATED_EXT/OPEN_MARKER_STALE_MS）与 openMarkerPath/
 * sweepOpenMarkers/registerOpenMarker/touchOpenMarker/releaseOpenMarker 原样随迁
 * （零行为变化，历史注释原样随代码迁移）。
 * 实读偏差记档：侦察口径的 open-markers 缝（约 105 行）另含续期周期可变 let 与
 * configureOpenMarkerRenewMs——R26-105 家规禁 export let（跨模块共享可变绑定须
 * testableConst 化，非纯移动不做），且唯一读点在残核 firstOpenStore（不动区），
 * 故二者留残核、本缝收窄为 98 行。
 * 依赖方向单向（无环回引）：只 import node:fs/node:path 与
 * ../fs/cross-process-lock.js（isProcessAlive/processBootTime），不 import
 * events/store.ts；残核（firstOpenStore 首开段与 migrateBookSession 迁移段）自本
 * 文件 import 常量与函数——原模块私有而残核跨文件消费项就此导出
 * （MIGRATED_EXT/sweepOpenMarkers/registerOpenMarker/touchOpenMarker/
 * releaseOpenMarker），其余保持私有。
 * firstOpenStore（残核巨型对象字面量，重设计立案件）本批零触碰。
 */
import { readdirSync, statSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isProcessAlive, processBootTime } from '../fs/cross-process-lock.js'

// ── R67-2（十五轮）：跨进程「已持有句柄」标记 + 迁移墓碑 ──
// R66-12 的目录级锁只挡他进程**首开段**；迁移开始前就已打开的句柄（空闲态不持任何
// SQLite 锁，checkpoint busy=0 照样放行）成了残余窗口：rename 后他进程句柄的后续写入
// 打到已搬走的 inode，或下次重开旧路径时 DatabaseSync 重建空库——事件流就此分裂。
// 两个互补守卫：
// 1) 开口标记 <db>.open-<pid>：openSessionStore 首开登记（在目录锁内）、close() 归零
//    注销、进程崩溃残留由 pid 探测在扫描时 GC；migrateBookSession 持目录锁扫描——
//    有活标记即放弃迁移（false，源库原地完整可重试），把「先收口再迁」契约扩到跨进程。
// 2) 迁移墓碑 <db>.migrated：迁移成功后在旧位落指路标（内容 = 新库绝对路径）；
//    迁移完成后他进程才首开旧路径时，openSessionStore 据此 fail-closed 拒建空库
//    （走调用方既有 catch 降级 null），而不是开出第二只空库。墓碑指向的新库也已
//    不存在（再迁移/已删除）→ 墓碑过期，清掉放行新建（同路径重新建书场景）。

/** 句柄标记文件后缀（<dbPath>.open-<pid>）。 */
const OPEN_MARKER_SUFFIX = '.open-'
/** 迁移墓碑文件后缀（<dbPath>.migrated）。 */
export const MIGRATED_EXT = '.migrated'

function openMarkerPath(dbPath: string): string {
  return dbPath + OPEN_MARKER_SUFFIX + process.pid
}

/** R71-24（十九轮）：活 pid 但标记超龄的判死门槛（毫秒）——对齐 Z-19 锁超龄口径。
 *  正常活进程由续期定时器保持 mtime 恒新；超龄只可能是持有进程已死、pid 被系统复用
 *  给长命进程（跨进程 bootTime 无查询 API，年龄是可用判据）。残余风险如实记档：
 *  被长时间 SIGSTOP/深度 App Nap 挂起超门槛的活进程会被误判死——与 Z-19 对锁的
 *  同款取舍，门槛取保守的 10 分钟。 */
const OPEN_MARKER_STALE_MS = 10 * 60_000

/** 扫描某库的全部开口标记：死 pid 残留与超龄残留顺手 GC（best-effort），返回活标记
 *  路径列表。只在持 session 目录锁的段内调用（登记/迁移互斥由锁保证）。
 *  R71-24：pid 存活但标记 mtime 超龄 → 视同死残留 GC——持有进程死后 pid 被复用时，
 *  单纯 pid 探测会永远误判活，该书迁移（改名）被无限期误拒。 */
export function sweepOpenMarkers(dir: string, dbPath: string): string[] {
  const prefix = basename(dbPath) + OPEN_MARKER_SUFFIX
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return [] // 目录不存在：无任何标记
  }
  const live: string[] = []
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const pid = Number.parseInt(name.slice(prefix.length), 10)
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      // R71-24：活 pid + 超龄 mtime（续期早已停止）→ pid 复用残留，按死处理
      try {
        const age = Date.now() - Math.floor(statSync(join(dir, name)).mtimeMs)
        if (age <= OPEN_MARKER_STALE_MS) {
          live.push(join(dir, name))
          continue
        }
      } catch {
        // R72-6（二十轮 B-4）：stat 失败不再落删除路径——活 pid 的在位标记被 EACCES/
        // 竞态误 GC 会造成「迁移看不见我」的隐形句柄（registerOpenMarker fail-closed
        // 正是防它）。保守视为活：误判活的代价只是迁移被拒（安全方向），下次扫描再判
        live.push(join(dir, name))
        continue
      }
    }
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      /* GC 失败不阻断：下次扫描再试 */
    }
  }
  return live
}

/** 首开登记：GC 死残留 + 落本进程标记（fail-closed——登记失败时句柄不可信，抛错走
 *  调用方降级，不能带着「迁移看不见我」的隐形句柄继续写库）。
 *  R71-24：内容补 bootTime（诊断字段；同款语义见 cross-process-lock 锁文件）。 */
export function registerOpenMarker(dir: string, dbPath: string): void {
  sweepOpenMarkers(dir, dbPath)
  writeFileSync(openMarkerPath(dbPath), JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
}

/** R71-24：开口标记续期定时器的 tick——刷 mtime；标记文件被误 GC（他进程按超龄误判）
 *  时重写自愈（内容不变，重写即重新声明在位）。失败静默：下一 tick 再试。 */
export function touchOpenMarker(dbPath: string): void {
  const p = openMarkerPath(dbPath)
  try {
    utimesSync(p, new Date(), new Date())
  } catch {
    try {
      writeFileSync(p, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
    } catch {
      /* best-effort：磁盘异常时静默，句柄仍由 pid 探测兜底 */
    }
  }
}

/** 归零注销（best-effort：文件系统异常时残留由下次扫描的 pid 探测 GC 收口）。 */
export function releaseOpenMarker(dbPath: string): void {
  try {
    rmSync(openMarkerPath(dbPath), { force: true })
  } catch {
    /* best-effort */
  }
}
