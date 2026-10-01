/**
 * 事件库首开壳（建目录 + 开库 + 打开期 PRAGMA/WAL + 首开 DDL + 迁移墓碑判定
 * + 打开期错误收口）—— 自 src/events/store.ts 首开段拆出。
 *
 * 依赖单向（无环回引）：只 import node:fs/node:sqlite、../log 与 ./store-open-markers
 * （迁移墓碑后缀 + 开口标记登记/续期），不 import events/store.ts。残核（store.ts）
 * 自本文件取 firstOpenStoreCore 作生产调用，并把三个开库单元
 * （clearStaleMigrationTombstone/applyOpenPragmas/createEventsSchema）经残核逐名再导出
 * 供回归直测，全库消费方 import 面零改动。
 *
 * 残核以 FirstOpenHooks 注入三件本文件不可自持的连接服务（见该类型注）：孤儿修复
 * （本进程活跃会话登记集在残核）、打开期失败的关库出口（残核 closeEventsDb 是
 * prepared 缓存断链序单点）、开口标记续期周期（残核持有可变生效值）。
 *
 * 同步残留说明：WAL 切换的 SQLITE_BUSY 退避在 Atomics.wait 微睡（≤1.8s）有界保留
 * ——首开段已被 session 迁移锁跨进程串行化，退避仅在他进程已开库连接持写锁的窗口
 * 触发；node:sqlite 无异步 API，且 busy_timeout 本身使 db.exec 在 SQLite 内部同步
 * 等待，退避异步化不消除真阻塞源，只增 DDL 双轨漂移面。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { log, errMsg } from '../log/index.js'
import { MIGRATED_EXT, registerOpenMarker, touchOpenMarker } from './store-open-markers.js'

/** SQLite 库文件损坏类错误判据——node:sqlite 对
 *  SQLITE_NOTADB/CORRUPT 抛英文裸 message 且各版本措辞有差，按已知短语集匹配；
 *  宁可漏判走原样上抛，不误判把 BUSY/IOERR 包装成「损坏」。 */
function isDbCorruptionError(e: unknown): boolean {
  const msg = errMsg(e)
  return /file is not a database|database disk image is malformed|malformed database image|unsupported file format/i.test(
    msg,
  )
}

/** 旧路径库文件缺失 + 墓碑在位 = 该库曾随书改名迁走——分两态：
 *  旧书根目录已不存在（书确实改名迁走，stale 书目录视图的进程迟来首开）且墓碑
 *  指向的新库还活着 → fail-closed 抛错拒建空库（建空库会让事件流分裂成两半，走
 *  调用方既有 catch 降级 null）；旧根目录又在（同路径重新建书）或新库也已不存在
 *  （再迁移/已删书）→ 墓碑过期，清除后放行正常新建。
 * 导出供回归直测（生产唯一调用点在本文件首开核心首开端）。 */
export function clearStaleMigrationTombstone(bookRoot: string, dbPath: string): void {
  if (existsSync(dbPath) || !existsSync(dbPath + MIGRATED_EXT)) return
  let to: unknown = null
  try {
    to = (JSON.parse(readFileSync(dbPath + MIGRATED_EXT, 'utf-8')) as { to?: unknown }).to
  } catch {
    // 墓碑不可解析（写中途进程死留下的半截 JSON——写侧走 atomicWriteFile 原子写，
    // 此为存量/外因形态）不当作「无墓碑」清除放行：清除后本处按正常缺库重建空库，
    // 事件流在新旧两路径分裂（要防的正是这个）。保留墓碑 + fail-closed 拒建，走
    // 调用方既有 catch 降级 null；作者按告警人工核对迁移目标（修复墓碑 JSON 或
    // 确认旧库确已废弃后手删）。
    log.error(
      'events',
      `事件库迁移墓碑不可解析（${dbPath + MIGRATED_EXT}）——保留墓碑并拒绝在旧路径重建空库，请人工核对迁移目标（合法形：${'{ to: <新库绝对路径>, at: <毫秒> }'}）`,
    )
    throw new Error(
      `事件库迁移墓碑不可解析（${dbPath + MIGRATED_EXT}）——拒绝在旧路径重建空库，请人工核对/修复墓碑后重试`,
    )
  }
  if (!existsSync(bookRoot) && typeof to === 'string' && to !== '' && existsSync(to)) {
    throw new Error(`事件库已随书改名迁移（${dbPath} → ${to}）——拒绝在旧路径重建空库，请以改名后的书访问`)
  }
  try {
    rmSync(dbPath + MIGRATED_EXT, { force: true })
  } catch {
    /* 清除失败维持原样：下次首开再试 */
  }
}

/** 打开期 PRAGMA + WAL 切换（须在 DDL 之前）：busy_timeout 必须先于 journal_mode=WAL
 *  设置——WAL 切换在 journal_mode 处需拿写锁，若另一进程正持锁而 busy_timeout 未设，
 * 会立即抛 SQLITE_BUSY。
 * 导出供回归直测（生产唯一调用点在本文件首开全流程）。 */
export function applyOpenPragmas(db: DatabaseSync): void {
  // busy_timeout 先设（见上）
  db.exec('PRAGMA busy_timeout = 5000')
  // 退避维持不加深：8 次退避耗尽仍可抛 SQLITE_BUSY，但耗尽即抛是 fail-closed 正确
  // 出口，不是缺陷——每轮失败前 busy_timeout 已在 SQLite 内部等待 5s，8 轮 × 5s +
  // 退避 1.8s ≈ 42s 仍抢不到，说明对手是僵死写方（SIGSTOP 挂起/磁盘级卡死），再等
  // 只会把「打开失败可重试」拖成分钟级假死；抛错走调用方既有 catch 降级 null，无数据
  // 损伤。维持 8 次 + 线性退避现状。
  // WAL 切换需短暂独占——并发首开下其他进程持锁（DDL/首写）时，即使 busy_timeout
  // 也可能立即 SQLITE_BUSY 且库仍处 delete 态（幂等 no-op 兜底不够）。带退避重试：
  // 对方事务必然短（建表/一次 INSERT），数百 ms 内可得手。
  let lastErr: unknown
  for (let i = 0; i < 8; i++) {
    try {
      db.exec('PRAGMA journal_mode = WAL')
      lastErr = null
      break
    } catch (err) {
      // 库损坏是确定性错误，退避重试只会空转 8×（busy_timeout 5s 内部等待 + 微睡）
      // ——立即上抛走外层分类包装（含可行动指引）
      if (isDbCorruptionError(err)) throw err
      lastErr = err
      const mode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined)?.journal_mode
      if (mode === 'wal') {
        lastErr = null
        break
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1))
    }
  }
  if (lastErr !== null) throw lastErr
}

/** 首开 DDL：events / sessions 建表 + 检索索引 + 分支元数据生成列。
 * 导出供回归直测（生产唯一调用点在本文件首开全流程）。 */
export function createEventsSchema(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS events (
      seq         INTEGER PRIMARY KEY,
      session_id  TEXT NOT NULL,
      turn        INTEGER,
      step        INTEGER,
      type        TEXT NOT NULL,
      data        TEXT NOT NULL,
      surface_op  TEXT,
      shadow_start INTEGER,
      shadow_end   INTEGER,
      source_seqs  TEXT,
      replace_generation INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    )`,
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq)')
  // ── 分支元数据检索列 + 部分索引 ──
  // firstBranchMetaSeq 原 `data LIKE '%"branchId"%' OR LIKE '%"parentSeq"%'` 谓词无
  // 可用索引，chat-history 真尾窗每次请求全表扫描（node:sqlite 同步 API 直接停在
  // 事件循环上，翻倍前扩循环里最坏反复全扫）。改 VIRTUAL 生成列（instr 确定性函数，
  // 读时零存储按行求值）+ 部分索引（只收录携带分支元数据的行，体量 = 分支事件数级，
  // 与全表行数解耦）。存量库惰性迁移：PRAGMA table_xinfo 判列后 ALTER 补列（幂等，
  // 首开一次 ALTER O(1) 元操作 + 建索引一次全行扫描），新库建表（上方，无此列）同样
  // 走到本处补齐——单点单路径防新旧两态 schema 漂移。ALTER 生成列须 SQLite ≥3.31
  // （node:sqlite 内建版远高于此，见分支 meta 索引回归用例的实证断言）；若未来
  // node:sqlite 拒绝 ALTER 加生成列，回退方案 = 独立 branch_meta 影子表（未采用）。
  {
    // 判列必须走 table_xinfo——生成列是 hidden 列（hidden=2），table_info 不列出
    //（误判缺列会让每次重开库都重跑 ALTER 撞 duplicate column）
    const cols = db.prepare('PRAGMA table_xinfo(events)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'has_branch_meta')) {
      db.exec(
        `ALTER TABLE events ADD COLUMN has_branch_meta INTEGER GENERATED ALWAYS AS
         (instr(data, '"branchId"') > 0 OR instr(data, '"parentSeq"') > 0) VIRTUAL`,
      )
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_branch_meta ON events(session_id, seq) WHERE has_branch_meta = 1')
  db.exec(
    `CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      format_version INTEGER NOT NULL DEFAULT 1,
      book        TEXT NOT NULL,
      header      TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    )`,
  )
}

/** 首开核心所需的连接服务（残核注入，本文件不反向取用）：
 * - repairOrphans：DDL 之后、开口标记登记之前的启动修复（孤儿会话补 end；活跃会话
 *   登记集由残核持有，本文件不感知）；
 * - closeDb：打开期失败时的关库出口（残核 closeEventsDb——prepared 缓存断链序单点，
 *   勿改直连 close）；
 * - markerRenewMs：开口标记续期周期（残核持有可变生效值，取调用时快照）。 */
export interface FirstOpenHooks {
  repairOrphans(db: DatabaseSync): void
  closeDb(db: DatabaseSync): void
  markerRenewMs: number
}

/** 打开全流程（建目录 + 开库 + PRAGMA/WAL + DDL + 孤儿修复 +
 *  开口标记登记）：打开期（PRAGMA/DDL/孤儿修复/标记登记）抛错时句柄不滞留——此刻
 *  尚未登记调用方的引用计数缓存（openStores），引用计数的 close 回收路径接不到它；
 *  调用方 catch 后降级 null 继续跑，句柄滞留进程积累（「损坏库重试」类测试反复触发
 *  尤甚）。 */
function openEventsDbWithDdl(
  dir: string,
  dbPath: string,
  hooks: FirstOpenHooks,
): { db: DatabaseSync; markerTimer: ReturnType<typeof setInterval> } {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    applyOpenPragmas(db)
    createEventsSchema(db)
    hooks.repairOrphans(db)
    // 首开成功（DDL/修复全过）→ 落开口标记（仍在目录锁内，与迁移扫描互斥）。
    // 放在 repair 之后：打开期抛错则不登记（句柄已在 catch 关闭）。
    registerOpenMarker(dir, dbPath)
    // 起续期定时器——活句柄定期刷标记 mtime；进程挂死/崩溃后停止续期，
    // 超龄标记在扫描时按 pid 复用残留 GC（见 sweepOpenMarkers）。unref 不阻退出。
    // 打开期抛错则不启动（标记登记在 repair 之后，异常路径无续期定时器可留）。
    const markerTimer = setInterval(() => touchOpenMarker(dbPath), hooks.markerRenewMs)
    markerTimer.unref()
    return { db, markerTimer }
  } catch (e) {
    try {
      hooks.closeDb(db)
    } catch {
      /* best-effort：close 自身失败不再遮蔽原始错误 */
    }
    // 库文件损坏原样上抛裸 SQLite 码（「file is not
    // a database」），调用方降级 null 后用户只看到「事件库不可用」无任何可行动
    // 线索。事件是对话史/审计产品数据，不做静默删库自愈——换含路径与恢复指引的
    // 人话错误（原始错误挂 cause 保诊断链），经 chat-history 族结构化 500 透传。
    if (isDbCorruptionError(e)) {
      throw new Error(
        `事件库文件损坏（${dbPath}），对话史/审计/链路事件暂不可读。` +
          `请先备份并移走该文件后重试——应用将重建空库（旧事件记录不会自动恢复）`,
        { cause: e },
      )
    }
    throw e
  }
}

/** 首开核心：迁移墓碑判定（旧路径拒建空库 / 过期清除）先于建库，随后走打开全流程
 *  （建目录 + 开库 + PRAGMA/WAL + DDL + 孤儿修复 + 开口标记登记）。
 *  调用方须已持 session 迁移锁，锁释放归开库壳（openSessionStore/Async 各自的
 *  finally releaseOpenLock）——首开核心自身无锁可放。 */
export function firstOpenStoreCore(
  bookRoot: string,
  dir: string,
  dbPath: string,
  hooks: FirstOpenHooks,
): { db: DatabaseSync; markerTimer: ReturnType<typeof setInterval> } {
  clearStaleMigrationTombstone(bookRoot, dbPath)
  return openEventsDbWithDdl(dir, dbPath, hooks)
}
