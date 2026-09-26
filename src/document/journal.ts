/**
 * 恢复 journal（§7）—— 防丢字资产。
 *
 * 保存协议每步写 pending（opId/baseRevision/ts 元数据），落盘后追加 settled。崩溃后扫
 * 「有 pending 无 settled」的 opId 提示作者恢复。
 *
 * 追加写（appendFileSync + fsync），**不用 atomicWriteFile**——整文件替换会
 * O(n²) 且重写窗口崩了丢全历史；追加一行最多损坏末行，恢复扫描本就逐行容错。
 *
 * 膨胀治理：settle/abort 后超过阈值触发 compact——只保留未结算 pending
 *（崩溃恢复唯一依赖），已结算行整段丢弃；原子替换，压缩窗口崩溃则原文件不动，
 * 无净损失。并发守卫（KN- → ）：锁内基线 stat → 读算 → rename 前重 stat，
 * size/mtime 有变（他进程追加过）即弃本轮，不吞新行。
 *
 * pending 收窄为「opId + baseRevision + ts」元数据，全文快照
 * 及其配套机制（头尾截断降级、惰性构造、256KB 闸、compact 尾段补追、降级写 inode
 * 自校验）整段删除。取舍证据（评审取证）：
 *  · 快照全仓零程序性消费方——两处读取面（state/health.ts reconcileSavePending、
 *    studio/server/api/state.ts acknowledge）只用 opId 与 baseRevision；
 *  · 作者侧唯一出口只是一句「对照 工作区/.journal 下的快照残片补回」，即要小说作者
 *    手读 JSON 转义的隐藏 JSONL，且 >256KB 文档的降级行本就只剩头尾各 32KB；
 *  · 实际承担未保存恢复的是前端 dirty 镜像（web-next shared/dirty-mirror.ts：保存成功
 *    才清，故崩窗内恒在盘、按 baseRev 时效门复活）+ 版本历史（磁盘现状）；
 *  · 故本文件不再自留内容副本，恢复职责明确交前端镜像与版本历史（只减不加）。
 * 兼容口径：**向后兼容读旧、只写新**——旧格式行多出的 content/degraded 字段按未知
 * 字段忽略（scanUnsettled 只校验本形态必需字段），不因格式演进报错。
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { tryAcquireCrossProcessLock, acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'
import { log, errMsg } from '../log/index.js'
import { testableConst } from '../shared/testable.js'
import { dirname } from 'node:path'
import { ulid } from './stable-id.js'
import { atomicWriteFile } from '../fs/atomic.js'
import type { Revision } from './revision.js'

export interface JournalPending {
  opId: string
  docId: string
  baseRevision: Revision
  ts: string
  status: 'pending'
}

/** 移动/重命名 pending（rename 与清单更新之间的非原子窗口兜底）。
 *  内容不变仅路径变——恢复是确定性的（按磁盘现状收口清单），无需作者决断。 */
export interface JournalMovePending {
  opId: string
  docId: string
  ts: string
  status: 'pending'
  kind: 'move'
  oldPath: string
  newPath: string
}

interface JournalSettled {
  opId: string
  ts: string
  status: 'settled'
  newRevision: `sha256:${string}`
}

interface JournalAborted {
  opId: string
  ts: string
  status: 'aborted'
  reason: string
}

/** 未结算 pending（保存类或移动类）——恢复方按 kind 分流处理。 */
export type JournalAnyPending = JournalPending | JournalMovePending

/** 类型守卫：JournalPending（保存类）无 kind 字段，联合上取 kind 须经此收窄。 */
export function isMovePending(p: JournalAnyPending): p is JournalMovePending {
  return (p as JournalMovePending).kind === 'move'
}

type RawLine = { [k: string]: unknown }

/** 追加 pending 行（元数据）。返回 opId 供后续 appendSettled 配对。
 * 收窄时第 4 形参 content 已无消费，本轮连形参一并删除
 *  ——三个调用方（document/service.ts、document/service-meta.ts、process/draft-pipeline.ts）
 *  的全文实参同步删净，其中 service.ts 的 `byteRestore ? '' : content` 转义随之消失
 *  （原转义只是「字节档不落失真文本视图」的历史残留，收窄后无对象可指）。 */
export async function appendPending(journalPath: string, docId: string, baseRevision: Revision): Promise<string> {
  const entry: JournalPending = {
    opId: ulid(),
    docId,
    baseRevision,
    ts: new Date().toISOString(),
    status: 'pending',
  }
  await appendLineAsync(journalPath, JSON.stringify(entry))
  return entry.opId
}

/** 追加移动/重命名 pending 行。返回 opId 供配对 settle/abort。 */
export async function appendMovePending(
  journalPath: string,
  docId: string,
  oldPath: string,
  newPath: string,
): Promise<string> {
  const entry: JournalMovePending = {
    opId: ulid(),
    docId,
    ts: new Date().toISOString(),
    status: 'pending',
    kind: 'move',
    oldPath,
    newPath,
  }
  await appendLineAsync(journalPath, JSON.stringify(entry))
  return entry.opId
}

/** 追加 settled 行，标记某 opId 已成功落盘。 */
export async function appendSettled(journalPath: string, opId: string, newRevision: `sha256:${string}`): Promise<void> {
  const entry: JournalSettled = {
    opId,
    ts: new Date().toISOString(),
    status: 'settled',
    newRevision,
  }
  await appendLineAsync(journalPath, JSON.stringify(entry))
  maybeCompactJournal(journalPath)
}

/** 追加 aborted 行，标记某 opId 保存失败（不落盘）。 */
export async function appendAborted(journalPath: string, opId: string, reason: string): Promise<void> {
  const entry: JournalAborted = {
    opId,
    ts: new Date().toISOString(),
    status: 'aborted',
    reason,
  }
  await appendLineAsync(journalPath, JSON.stringify(entry))
  maybeCompactJournal(journalPath)
}

/**
 * 内部核（修复1）：读 + 解析 journal 未结算条目，读失败返回**可辨信号**
 * 而非降级空集——两个消费方语义分岔：崩溃恢复扫描（findUnsettled）按降级 []
 * （跳过一轮检查，无害）；compact（maybeCompactJournal）拿到的是「保留集」，空集 =
 * 清空 journal，见读失败必须整轮放弃（POSIX rename 只需目录写权，可独立于文件读权
 * 存在）。非法行跳过。
 */
function scanUnsettled(journalPath: string): { ok: true; items: JournalAnyPending[] } | { ok: false; cause: string } {
  if (!existsSync(journalPath)) return { ok: true, items: [] }
  let text: string
  try {
    text = readFileSync(journalPath, 'utf-8')
  } catch (e) {
    return { ok: false, cause: errMsg(e) }
  }
  const pending = new Map<string, JournalAnyPending>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let obj: RawLine
    try {
      obj = JSON.parse(line) as RawLine
    } catch {
      continue // 非法行跳过
    }
    if (obj.status === 'pending' && typeof obj.opId === 'string') {
      // 字段校验：损坏 journal 缺字段的 pending 行不救（形态不完整，恢复扫描
      // 无法据此定位/复核）。baseRevision 允许 null（无基线场景合法），docId/ts 必须为
      // string；move 类按 kind 分流——oldPath/newPath 必须为 string。
      // save 类不再校验 content——本形态不写该字段，且**旧格式行**（含
      // 全文快照 content / degraded）多出的字段在此按未消费字段忽略（向后兼容读旧）；
      // 收窄后按下述白名单**逐字段重建**，故 compact 重写时旧格式行自动落成新形态
      //（写新——旧快照内容不再被原样搬进压缩后的文件）。
      if (obj.kind === 'move') {
        if (
          typeof obj.docId === 'string' &&
          typeof obj.ts === 'string' &&
          typeof obj.oldPath === 'string' &&
          typeof obj.newPath === 'string'
        ) {
          pending.set(obj.opId, {
            opId: obj.opId,
            docId: obj.docId,
            ts: obj.ts,
            status: 'pending',
            kind: 'move',
            oldPath: obj.oldPath,
            newPath: obj.newPath,
          })
        }
      } else if (
        typeof obj.docId === 'string' &&
        (obj.baseRevision == null || typeof obj.baseRevision === 'string') &&
        typeof obj.ts === 'string'
      ) {
        pending.set(obj.opId, {
          opId: obj.opId,
          docId: obj.docId,
          baseRevision: (obj.baseRevision ?? null) as Revision,
          ts: obj.ts,
          status: 'pending',
        })
      }
    } else if ((obj.status === 'settled' || obj.status === 'aborted') && typeof obj.opId === 'string') {
      pending.delete(obj.opId)
    }
  }
  return { ok: true, items: [...pending.values()] }
}

/** 扫 journal，找 pending 但无 settled/aborted 的条目（崩溃恢复用）。非法行跳过。
 * 读失败降级不阻断（返回 [] ——文件级读失败视同本轮恢复检查
 *  跳过），但必须留痕——原空体 catch 使 journal 在盘却不可读（EACCES/EBUSY 等）时
 *  崩溃恢复扫描静默归零，作者对丢字风险零感知且无诊断线索；对齐同链路 state.ts
 * 循环级 warn 口径。
 * 降级 [] 语义**仅限本消费方**——compact 侧走 scanUnsettled
 *  可辨信号（读失败弃压缩，不得拿空集当保留集清空 journal）。 */
export function findUnsettled(journalPath: string): JournalAnyPending[] {
  const scan = scanUnsettled(journalPath)
  if (!scan.ok) {
    log.warn('journal', `journal 读取失败，本轮崩溃恢复扫描降级跳过（${journalPath}）：${scan.cause}`)
    return []
  }
  return scan.items
}

/**
 * appendLine 的异步孪生——executeSave/saveDraft 服务进程保存链
 * 每笔 2-3 次 journal 追加，此前走同步 Atomics.wait 锁等待（双进程争用冻结事件循环
 * 最长 2s）。降级语义原样平移（锁超时 → 精简降级行裸写）；后服务进程全部
 * journal 写路径（含 healMovePending 自愈回写）均走本异步版。原同步 appendLine 随
 * appendSettledSync/appendAbortedSync 一并删除（生产零调用死码，自
 * 起无任何调用方）。
 * 与刀 2 的 degradedLine thunk /
 * 降级写 inode 自校验随快照机制删除一并撤除——两条都只为「行长」与
 * 「快照内容不丢」服务：pending 行现为 ~200 字节元数据（远在文件系统原子窗内），降级写
 * 退化为原「裸 appendFileSync」形态，仅留锁超时 warn 与「尽力而为」语义。
 * 残余窗口（如实记档）：拿锁两轮失败的降级裸写不持锁，若此刻 compact 完成
 * atomicWriteFile（tmp+rename 换 inode），本行可能落在被换下的旧 inode 上——
 * findUnsettled 永不报，即丢一条**崩溃检测**行。前丢的是快照内容（故当时以
 * dev+ino 自校验 + 尾段补追堵）；现丢的只是「这次保存没结算」的账目行，其后果是
 * 少一次进门提示（无内容可丢——内容副本已不在 journal），且下一笔保存即新写 pending，
 * 故接受为小概率残余，不再为此保留自校验机制。
 */
async function appendLineAsync(filePath: string, line: string): Promise<void> {
  mkdirSync(dirname(filePath), { recursive: true })
  // 锁超时先重试一档再降级——超时多为对端 append 突发 / compact 尾窗
  // 的瞬时争用（50ms 退避后常已让出），而降级裸写 = 与 compact 的互斥失守窗（两条
  // 降级行交错可损行，findUnsettled 容错跳过即丢挂账），能压回小概率就压。
  let release = await acquireCrossProcessLockAsync(`${filePath}.lock`, getJournalLockTimeoutMs())
  if (!release) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    release = await acquireCrossProcessLockAsync(`${filePath}.lock`, getJournalLockTimeoutMs())
  }
  if (release) {
    try {
      appendFileSync(filePath, line + '\n', 'utf-8')
      fsyncFile(filePath)
    } finally {
      release()
    }
    return
  }
  log.warn('journal', `跨进程锁超时，降级裸写（${filePath}）——与 compact 的互斥窗口回到守卫口径`)
  appendFileSync(filePath, line + '\n', 'utf-8')
  fsyncFile(filePath)
}

/** fsync 已存在文件（追加后同步数据落盘）。best-effort。
 * 导出供 words-diary 同族 append-only jsonl 追加后
 *  复用（耐久纪律单源，勿在他处复制实现）。 */
export function fsyncFile(filePath: string): void {
  let fd: number | undefined
  try {
    // 'r' → 'r+'——win FlushFileBuffers 要求句柄具写访问权，只读
    // fd 调 fsyncSync 恒抛 EPERM 被下方 catch 吞掉：fsync 纪律（模块头注「确保崩溃前
    // 已落盘」）在主力平台从未生效（实测 win32：'r'→EPERM、'r+'→OK）。'r+' 不截断，
    // 追加后刷盘语义不变。
    fd = openSync(filePath, 'r+')
    fsyncSync(fd)
  } catch {
    // 平台/权限问题——best-effort
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 平台/权限问题——best-effort
      }
    }
  }
}

// ── 膨胀治理────────────────────────────

/** compact 阈值：journal 字节数超过此值时在 settle/abort 后压缩（只留未结算 pending）。
 * 口径：export const + 模块内可变生效值 + 注入钩子——测试经钩子改档（批起
 *  compact 用例以低阈值+小内容建仓），生产恒用常量。
 * pending 只记元数据（每行 ~200 字节），2MB 阈值对应约 5000 笔保存的
 *  累积量——阈值与触发时机（settle/abort 之后）均不变。 */
export const JOURNAL_COMPACT_BYTES = 2 * 1024 * 1024

/** 三件套换装 testableConst——生效值 getter（消费点显式调用）+ 测试注入 setter 元组第二位（原名原签名）。 */
export const [getJournalCompactBytes, __setJournalCompactBytesForTest] = testableConst(JOURNAL_COMPACT_BYTES)

// 原 JOURNAL_PENDING_SNAPSHOT_MAX_BYTES（256KB 快照闸）、
// JOURNAL_PENDING_DEGRADED_KEEP_BYTES（降级行头尾保留预算）与两个注入钩子已随快照机制
// 整段删除——pending 行不再含内容，无尺寸闸可言。

/**
 * 超阈值时压缩 journal：已结算（settled/aborted 配对完成）的行全部丢弃，
 * 只保留未结算 pending（崩溃检测的唯一依赖）。
 *
 * 安全条件：settled 行的使命仅是配对消除 pending（findUnsettled 语义），其
 * pending 已不在保留集内，丢弃无损失。原子替换（tmp+rename）：压缩窗口崩溃
 * 则原 journal 完好，tmp 残留下次覆盖。best-effort——失败不影响保存主流程。
 * 调用时机在 appendSettled/appendAborted 之后（本进程内 per-docId 串行）。
 *
 * KN-（bb 轮挂起销账·轻量守卫）：原「无并发写」假设仅限单进程——
 * CLI/脚本与 GUI 双进程操作同一书时，compact 的「读→算→整文件替换」窗口可吞掉
 * 对方刚 append 的 pending 行（崩溃检测唯一依据，丢了检测链失据）。守卫：读前后
 * 各 stat 一次，size/mtime 任变（= 有他进程追加过）→ 放弃本轮压缩（compact 本就
 * best-effort，下次再试）。跨进程文件锁已落地
 * （fs/cross-process-lock.ts，含 win 语义评估）——compact 与 append 共享 journal
 * 锁文件，「末次 stat → rename」理论窗口彻底闭合；stat 守卫保留作双保险。
 * 基线 stat 移入锁内——原「锁外 before stat → 等锁 → 锁内 after
 * stat」对比，等锁期间他进程的合法 append 也会误判为「压缩窗口内有变」白白弃压。
 * RC的「保留集 + 尾段补追」随快照机制一并撤除
 * （补追整套机制——readByteRange/readCompactTail/稳定性重读——价值全在「把基线之后
 * 新增的**内容行原文**带进新文件」；pending 行现为 ~200 字节元数据、journal 增长速率
 * 降两个数量级，弃轮一次的代价远小于保留这套拼接逻辑），复核口径回到：锁内基线
 * stat → 读算 → rename 前重 stat 对比（size/mtime 有变 = 有新行）→ 变则整轮放弃
 * （原文件不动、无净损失，下次 settle 再试）。残余窗口如实记档：复核 stat 与 rename
 * 之间仍有 µs 级窗口（与同级，不宣称归零）；降级写侧不再有 inode 自校验兜底，
 * 丢的也只是一条检测行（见 appendLineAsync 注释）。
 */
function maybeCompactJournal(journalPath: string): void {
  try {
    if (!existsSync(journalPath)) return
    if (statSync(journalPath).size < getJournalCompactBytes()) return
    // 跨进程锁（append 侧同锁）——持锁期间他进程 append 被阻塞。非阻塞占锁
    // （best-effort：拿不到直接弃本轮）。
    const release = tryAcquireCrossProcessLock(`${journalPath}.lock`)
    if (!release) return
    try {
      // 锁内基线 stat（行数以 size 折算——任何 append 必改 size，等价且免二次全读）
      const before = statSync(journalPath)
      if (before.size < getJournalCompactBytes()) return
      // 读失败弃本轮压缩——原复用 findUnsettled 的 [] 降级，
      // 读失败（EACCES/EBUSY 等，rename 只需目录写权）时 before/after stat 全等、
      // 复核不触发，atomicWriteFile('') 把在档全部未结算 pending（崩溃检测唯一依据）
      // 清空、半截正文损坏自此静默存活。现走 scanUnsettled 可辨信号，与
      // 「有变即弃」同款 best-effort（下次 settle 再试）。
      const scan = scanUnsettled(journalPath)
      if (!scan.ok) {
        log.warn('journal', `journal 读取失败，本轮压缩放弃（保留原文件不动，${journalPath}）：${scan.cause}`)
        return
      }
      // 复核（起即 rename 前唯一复核）：读算期间若有他进程追加（含锁超时降级
      // 裸写），size/mtime 必变——整轮放弃，绝不拿旧读结果覆盖新行。
      const after = statSync(journalPath)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return
      const unsettled = scan.items
      const text = unsettled.map((p) => JSON.stringify(p)).join('\n')
      atomicWriteFile(journalPath, unsettled.length > 0 ? text + '\n' : '', { fsync: true })
    } finally {
      release()
    }
  } catch {
    // best-effort：压缩失败不影响保存结果，下次再试
  }
}

/** 锁等待超时（毫秒）——争用为文件 IO 级毫秒。
 * 常量化——export let 可被任一 import 方静默改写（同 events/store.ts
 * 的收口认定），改 const + 内部可变生效值；测试只能经注入钩子改档，生产恒用常量。 */
export const JOURNAL_LOCK_TIMEOUT_MS = 2_000

/** 三件套换装 testableConst——生效值 getter（消费点显式调用）+ 测试注入 setter 元组第二位（原名原签名）。 */
export const [getJournalLockTimeoutMs, __setJournalLockTimeoutForTest] = testableConst(JOURNAL_LOCK_TIMEOUT_MS)
