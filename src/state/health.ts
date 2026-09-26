/**
 * 进门判定的健康检查族 + 判定辅助族 —— 自 src/state/state.ts 缝 A 拆出。
 *
 * （⑤④产品巨件拆分波2）：state.ts（1175 行）缝 A+B 纯移动拆分。
 * 本文件承载缝 A：态 1 健康检查 healthCheck 及其子族（journal 崩溃恢复
 * healMovePending/reconcileSavePending、孤儿 journal 归档 orphan 快照族与超龄清扫、
 * finalizedLost 逐条探测、网盘副本/布线缺失/清单空哨兵/结构不变量）+ 三组每书
 * TTL 节流缓存（sweep/云盘扫描/finalizedLost——唯一消费方均在 health 族内，顶层
 * 求值常量随族迁此单源）及其复位与失效钩子 + detectState 消费的判定辅助族
 *（detectHandEdits/detectIncompleteWorkdir/isChapterFinalized/chapter* 辅助族/
 * unfinishedPieceNames/maxFileNameChapter/skipFinalizedChapters/volumeSizeOf）。
 * 近况复述族见 recap.ts（缝 B）；状态机残核（detectState/routeState/enter 与状态
 * 类型）留 state.ts，其头注保留原全部历史记载与拆分沿革。
 * 原私有而 state.ts/recap.ts 跨模块消费项就此导出，其余保持私有。
 * 依赖方向单向（无环回引）：document/format/fs/git/process/log 既有出边（只出
 * 不进，不 import ai/studio）；state.ts 与 recap.ts 自此 import，本文件不 import
 * 同批任何模块——顶层求值常量（节流表/HAND_EDIT_PREFIXES/DEFAULT_VOLUME_SIZE 等）
 * 一律单源本文件，绝不经环回引（count 拆分 HANZI 单源先例同款纪律）。
 * 注释全部原样随迁；行为、断言、测试零改动。
 */

import { existsSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { scanCloudCopies } from '../git/exec.js'
import { sweepAbandonedTmpFiles, rmWithRetry, renameWithRetry } from '../fs/atomic.js'
// save 锁在持探针（只读不取锁，judgeStaleLock 陈锁语义复用）
import { queryLockHeld } from '../fs/cross-process-lock.js'
// （修复批）：spill 清扫兜底接线——sweepOldSpills 幂等（按 mtime
// 30 天 TTL），与 tmp 清扫同窗节流执行（见 sweepAbandonedTmpFilesThrottled）
import { sweepOldSpills } from '../process/spill.js'
import { appendAborted, appendSettled, findUnsettled, isMovePending, type JournalAnyPending, type JournalMovePending, type JournalPending } from '../document/journal.js'
import { decodeDocDirName } from '../document/version.js'
import { readTrashManifest } from '../document/trash.js'
import { readBookConfig } from '../format/yaml.js'
import { splitFrontMatter, parseFlat } from '../format/frontmatter.js'
// 0918修复批（B005）：maxFileNameChapter 取号下限切 chapterNoFromName 单源
//（原窄正则 parseChapterFileName 对裸数字名失明）；isMdFileName = 扩展剥离单源
import { chapterNoFromName, isMdFileName } from '../format/filename.js'
import { readManifest, readManifestStrict, writeManifest, withManifestLockAsync, type Manifest } from '../document/manifest.js'
import { computeRevision } from '../document/revision.js'
import { probeCachedRevision } from '../document/tree.js'
import { detectStructureViolations } from '../document/structure.js'
import { safeManifestPath, docJoinKey, normalizeWinSeparators } from '../fs/safe-path.js'
import { walkMdEach } from '../fs/walk-md.js'
import type { BookConfig } from '../format/types.js'
import { log, errMsg } from '../log/index.js'

// sweep 每书 TTL 节流表（内存态，key = bookRoot；书数量级小无上限
// 忧虑）。导出 reset 钩子供测试复位节流窗。
const SWEEP_THROTTLE_MS = 6 * 3600_000
const sweepLastAt = new Map<string, number>()

// 网盘副本扫描每书 TTL 节流表（口径同 sweepLastAt 纪律）——
// scanCloudCopies 是 readdirSync 全树同步递归 + 逐文件 existsSync 验母本，此前
// detectState（/api/state 5s TTL）每轮请求都全扫；SMB/网盘卷上可冻结事件循环数百
// ms~秒级（同族纪律漏网点）。
// （修复批）：窗内回**上次结果**（非空数组）——原实现
// 窗内返回 []，已检出的持续网盘副本冲突仅在每个 60s 边界的扫描瞬间可见（/api/state
// TTL 仅 5s，健康信号 ~92% 时间消失，态 1/态 7 周期闪烁），且降级方向 fail-open
// （把「有问题」降成「无问题」），与本注释「回上次结果」的承诺不符。缓存值口径：
// 窗内新出现的副本最迟 TTL 过后下一次健康检查可见（登记取舍不变）。
const CLOUD_SCAN_THROTTLE_MS = 60_000
const cloudScanCache = new Map<string, { at: number; copies: string[] }>()

// （c 修复批）：finalizedLost 逐条 statSync 每书 TTL 节流表
//（口径同 cloudScanCache 纪律——窗内回**上次结果**：清单在册有 finalizedRevision 的条目
// 数 = 章数级，SMB/网盘卷每条 statSync 5-50ms，每次 detectState（5s 缓存过期后）全量重付
// 可冻结事件循环秒级。回上次结果而非空数组 = fail-closed 方向：持续丢失面在窗内仍可见，
// 窗内新丢失最迟 TTL 过后下一次健康检查可见，登记取舍与 cloudScanCache 注一致）。
const FINALIZED_LOST_THROTTLE_MS = 60_000
const finalizedLostCache = new Map<string, { at: number; issues: HealthIssue[] }>()

function scanCloudCopiesThrottled(bookRoot: string): string[] {
  const now = Date.now()
  const cached = cloudScanCache.get(bookRoot)
  if (cached && now - cached.at < CLOUD_SCAN_THROTTLE_MS) return cached.copies
  const copies = scanCloudCopies(bookRoot)
  cloudScanCache.set(bookRoot, { at: now, copies })
  return copies
}

/** @internal 测试钩子：复位节流表（构造「TTL 窗内第二次 detectState 不再全树扫」臂）。 */
export function __resetSweepThrottleForTest(): void {
  sweepLastAt.clear()
  cloudScanCache.clear()
  finalizedLostCache.clear() // finalizedLost 节流表同窗复位（测试钩子口径一致）
}

/** 删书/改名的生命周期失效挂点（books.ts forgetBookKeyedCaches
 *  接线）——sweepLastAt 键为 bookRoot，删书后条目成死重；改名后旧键永不再命中。
 *  不清无正确性影响（同名重建书最多延迟到下个 6h TTL 窗才首次清扫），纯内存卫生。
 *  ：cloudScanCache 同挂点一并清除。
 *  ：finalizedLostCache 同挂点一并清除——同名重建书的旧书丢失结论不得带入
 *  新书首个 TTL 窗（缓存值含 issue 明细，比 sweepStamp 的「晚扫一轮」更刺眼）。 */
export function forgetStateSweepStamp(bookRoot: string): void {
  sweepLastAt.delete(bookRoot)
  cloudScanCache.delete(bookRoot)
  finalizedLostCache.delete(bookRoot)
}

function sweepAbandonedTmpFilesThrottled(bookRoot: string): number {
  const now = Date.now()
  const last = sweepLastAt.get(bookRoot)
  if (last !== undefined && now - last < SWEEP_THROTTLE_MS) return 0
  const swept = sweepAbandonedTmpFiles(bookRoot)
  // （修复批）：同一节流窗内顺带清扫 30 天前 spill（housekeeping
  // 兜底）——原清扫只在 writeSpillFile 热路径触发，一本书写完再无编辑时旧 spill 永久
  // 残留。sweepOldSpills 幂等、内部失败静默（目录不存在/单文件错误均吞），此处再包
  // try/catch 保 best-effort：其异常绝不影响 tmp 清扫返回与节流窗推进。返回值不计入
  // swept（spill 数量不产 issue，纯卫生，留痕口径与 tmp 清扫一致）。
  try {
    sweepOldSpills(bookRoot)
  } catch {
    /* spill 清扫失败不影响主清扫流程 */
  }
  sweepLastAt.set(bookRoot, now)
  return swept
}

/** 默认每卷章数；book.yaml 可用 book.volume_size 覆盖。 */
// （拆分批）：判定辅助族随缝 A 迁此单源（detectState 与 recap.ts
// 的 readRecapSnapshot/fallbackRecapSnapshot 默认参均消费）——若留 state.ts 残核供
// recap.ts import，则 DEFAULT_VOLUME_SIZE 为「顶层求值常量经环回引」（state↔recap
// 双向运行时边：state re-export buildRecap、recap import 本常量），违 count
// 拆分立的常量不环回纪律，故随族落此；state.ts/recap.ts 自此单向 import。
export const DEFAULT_VOLUME_SIZE = 50

export function volumeSizeOf(config: BookConfig): number {
  const size = config.book.volume_size
  return typeof size === 'number' && Number.isSafeInteger(size) && size > 0 ? size : DEFAULT_VOLUME_SIZE
}

/** 健康检查异常项（去 git：journal 崩溃恢复 + 网盘副本扫描 + 定稿文件丢失 + 布线缺失）。
 *  ：kind 联合新增 'wiringMissing'（长篇书 布线/ 目录缺失，防吃书闸
 *  与账本回写静默失效的观测项）。
 *  ：kind 联合新增 'manifestEmpty'（清单在册可读但零文档条目、而正文区
 *  存在章节 .md 的哨兵——读侧三防线把解析级全损当合法空集 fail-open 的可见化；只加可见
 *  哨兵，不新增写阻断路径）。
 *  阶段 24 （章节结构操作三批）：kind 联合新增 'structurePending'（结构操作
 *  ①②间崩溃半成态哨兵——「并入」所指章仍存活于正文；detectStructureViolations 只读判定，
 *  收敛 = apply 重跑幂等续跑 / undo 整体回退，盘面收敛报文自消，不进 acknowledge 闭环）。 */
export interface HealthIssue {
  kind: 'crashedWrite' | 'cloudCopy' | 'finalizedLost' | 'wiringMissing' | 'manifestEmpty' | 'structurePending'
  humanMsg: string
  fix: string
  files?: string[]
}

/** 态 1：journal 崩溃恢复 + 网盘副本扫描（不再依赖 git 半提交/冲突/锁——无 git 即无此类异常）。
 *  ：异步化（healMovePending 自愈链的清单/journal 锁等待改异步孪生）。 */
export async function healthCheck(bookRoot: string, manifest: Manifest): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = []

  // ① journal 崩溃恢复：扫 工作区/.journal/*.jsonl，找 pending 未 settled 的写操作。
  // move 类 pending（rename 与清单更新之间的崩溃窗口）确定性自愈——内容不变
  // 仅路径变，按磁盘现状收口清单，不惊动作者；save 类才可能丢字，仍走作者提示。
  const journalDir = join(bookRoot, '工作区', '.journal')
  if (existsSync(journalDir)) {
    // 孤儿判定三重证实的「盘上清单/回收站」快照上提循环头——此前
    // isOrphanJournal 对每个 journal 文件各整读+整解析一次清单与回收站清单（500 章书
    // = 500 次全清单解析，/state 与 /overview 均 5s TTL 后重算反复支付，SMB/网盘卷放大）。
    // 循环体毫秒级完成，循环头读一次即保「以盘上为准」同等时效（他进程注册后崩溃的
    // 复核窗口不放大）；快照读失败沿用原「不确定 → 不归档」保守口径（整轮跳过归档）。
    const orphanSnapshot = readOrphanSnapshot(bookRoot)
    try {
      for (const name of readdirSync(journalDir)) {
        if (name.startsWith('._') || !name.endsWith('.jsonl')) continue
        // journal 文件名反解回真实 docId——写侧恒编码（win legacy 冒号
        // 防线），`legacy:xxx` 盘上名为 `legacy_xxx.jsonl`，不反解则 healMovePending 对
        // 清单真实键全 miss、自愈静默失效（settled 照标、清单残留旧路径）。
        const journalFile = join(journalDir, name)
        const docId = decodeDocDirName(name.slice(0, -'.jsonl'.length))
        // （c 修复批）：journal 单次整读——此前 isOrphanJournal
        //（下方）与主循环 findUnsettled 对同一文件各整读+解析一次（双读翻倍）；循环体
        // 到 isOrphanJournal 判定之间全同步（无 await），两次读之间不存在并发写窗口，
        // 上提为单读共享后行为逐位等价（清单快照单读纪律同款）。
        const pending = findUnsettled(journalFile)
        // 孤儿 journal 归档——docId 不在清单且不在回收站、且 move 类
        // pending 两端路径都不在盘（purge/外部删除后的残骸），对其报 crashedWrite 是
        // 永久幽灵红且留下永不消解的残留行；改判 .orphaned 保留数据可手工恢复。
        // pending 不再含全文快照（只记 opId/baseRevision），归档保留的
        // 只是「这次保存没结算」的账目痕迹。
        // save 类 pending 无路径字段无法证实无主，保守维持原报红（ genuine 崩溃不静默）。
        if (isOrphanJournal(bookRoot, docId, orphanSnapshot, pending)) {
          const dst = `${journalFile}.orphaned-${Date.now()}`
          try {
            // （退避族）：归档改名收编 renameWithRetry——win 杀软/索引器
            // 瞬时锁（EPERM/EBUSY）下裸 renameSync 直败会维持 crashedWrite 假红（锁
            // 释放后下次进门自愈）；同函数 healMovePending 删旧已用 rmWithRetry（口径
            // 对齐）。退避后仍失败照走既有 catch「维持原报红」路径，语义不变。
            renameWithRetry(journalFile, dst)
            log.info('state', `孤儿 journal 已归档（文档已删除且无盘上路径）：${name} → ${dst}，如需恢复可手工改名回 .jsonl`)
            continue
          } catch {
            // 归档失败（占用等）：维持原报红路径
          }
        }
        const unresolved: JournalAnyPending[] = []
        for (const p of pending) {
          if (isMovePending(p)) {
            if (!(await healMovePending(bookRoot, docId, p, manifest, journalFile))) unresolved.push(p)
            continue
          }
          // （c 修复批）：save 类 pending 确定性自动消解——
          // 盘上指纹已非 pending.baseRevision ⇒ 该次保存实际已落盘（atomicWrite 后 settled
          // 写失败 / 崩溃窗内的幸存态），补 settled 消解不再报红；相等 ⇒ 真未落盘，维持
          // 报红。返回 'crashed'（含各保守边界）时照旧进下方 crashedWrite 报文。
          // 'inflight'（save 锁在持=保存进行中）与 'settled' 同样不进
          // 报文——在途非崩溃，本轮跳过（settled 已自消解，inflight 等下一轮复核收敛）。
          if ((await reconcileSavePending(bookRoot, docId, p, manifest, journalFile)) === 'crashed') unresolved.push(p)
        }
        if (unresolved.length > 0) {
          // （二十四轮 C 域）：报文补文档路径——此前只报 docId（doc_…/legacy:…
          // 机器标识），作者无法定位是哪篇没保存完；清单在册以路径为首要标识，不在册
          // 回落 docId（孤儿 journal 已在上方分支归档，走到此处的多在册）。
          const where = manifest.entries.get(docId)?.path ?? docId
          issues.push({
            kind: 'crashedWrite',
            humanMsg: `上次写作时「${where}」的保存没完成，可能丢字。`,
            // 恢复指引如实化——原「可从版本历史恢复」误导：版本
            // 历史只含已保存部分，崩溃窗内未保存的新键入不在其中（这正是本提示要防
            // 的丢失面）。
            // 原文案叫作者「对照 工作区/.journal 下的快照
            // 残片补回」——journal 已不再存全文快照（只记 opId/baseRevision 元数据，
            // 见 document/journal.ts 头注取证），该指引已无物可指。改指真实的未保存
            // 恢复通道：编辑器本地镜像（web-next shared/dirty-mirror.ts，重开该文档时
            // 按 baseRev 时效门自动复活为脏内容）；版本历史与磁盘只保留已保存的内容。
            fix: '版本历史与磁盘只保留已保存的内容；若崩溃前编辑器里有未保存的键入，重新打开该文档会自动恢复上次未保存的正文（编辑器本地镜像）。确认现状无误后忽略继续写作。',
            files: unresolved.map((p) => p.opId),
          })
        }
      }
    } catch (e) {
      // 降级不阻断进门，但必须留痕——原空体 catch 使循环内任一
      // 意外异常（readdirSync EACCES 等）把整轮崩溃恢复检查静默归零，作者对上次崩溃
      // 丢字零感知且无诊断线索；对齐同函数其他降级分支的 warn 口径（恢复
      // 报文如实化的观测侧孪生缝）。
      log.warn('state', `journal 扫描异常，本轮崩溃恢复检查降级跳过：${errMsg(e)}`)
    }
  }

  // ③ ：已定稿文件丢失——清单在册有 finalizedRevision 的文档文件不在盘
  //（被外部删除/移走），detectHandEdits 的 rev===null 分支原先静默跳过，无任何健康出口
  //（静默丢章：章号推算只看盘上文件，缺章无感知）。归入态 1 issues 交作者裁决（恢复
  // 来源：版本档案/回收站/同步盘备份）。
  // /：核对范围从固定四前缀（HAND_EDIT_PREFIXES，态 3 手改检测的
  // 口径）放宽为「清单在册有 finalizedRevision 的全部 document 条目」——finalizedRevision
  // 是清单侧唯一定稿标记（finalizeRevision 落盘），定稿在四前缀之外的登记文档此前丢失
  // 零出口。同时区分「确实不存在（ENOENT）」与「stat 出错（EACCES 等不可探测）」：
  // 后者同样计入 lost（保守报红），但 warn 留痕——不可读 ≠ 不在盘，处置动作不同。
  // 逐条 statSync 探测改每书 TTL 节流（原内联循环抽出为 detectFinalizedLost，
  // 判定逐位不变；窗内回上次结果，登记取舍见 FINALIZED_LOST_THROTTLE_MS 注）。
  issues.push(...finalizedLostCheckThrottled(bookRoot, manifest))

  // ④ 长篇书 布线/ 目录缺失——finalize 的防吃书闸（ee-，含
  // finalGateBlockers 的 fail-open 降级）与账本履历回写都以 existsSync(布线)
  // 为生效条件，目录缺失时两者整体静默失效（作者零感知地失去防吃书保护）。短篇书
  // 不建布线是正常形态（scaffold 短篇分支），只对长篇（kind 缺省 long，与 isPieceBody
  // 读 book.yaml 的判定方式同口径）报 warning 健康项交作者裁决；healthCheck 无配置
  // 入参，就地读 book.yaml（解析失败按长篇处理，宁报不漏）。
  if (!existsSync(join(bookRoot, '布线'))) {
    const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
    const kind = cfg.ok ? (cfg.config.kind ?? 'long') : 'long'
    if (kind !== 'short') {
      issues.push({
        kind: 'wiringMissing',
        humanMsg: '布线目录缺失，防吃书闸与账本回写未生效。',
        fix: '从备份恢复 布线/ 目录；确认本书不需要布线（长程线索账本）可忽略此提示，写作将按无布线模式进行。',
      })
    }
  }

  // ② 网盘副本扫描（纯 fs，不依赖 git）；：60s TTL 节流（全树同步扫退到
  // 每书每分钟至多一次，SMB/网盘卷请求路径成本有界）
  const cloudCopies = scanCloudCopiesThrottled(bookRoot)
  // 顺手清扫 atomicWriteFile 崩溃残留 tmp（`.name.pid.uuid.tmp`，
  // 5 分钟年龄门槛防误删他进程在途写）——不产 issue，纯卫生，留痕即可
  // 清扫改每书 TTL 节流——sweep 全树同步扫（readdirSync+statSync
  // 逐文件，.版本 快照目录成百上千文件），此前每次 detectState（5s 缓存过期后）都在
  // 请求路径重扫，SMB/坚果云卷上每文件 statSync 5-50ms，事件循环冻结数百 ms-秒级
  //（/同族纪律漏网点）。节流后清扫仍会发生（每书每 6h 至少一次），请求
  // 路径成本有界；.trash 不入跳过表（trash-manifest 本身是 atomicWriteFile 目标，
  // 其崩溃 tmp 落在 .trash/ 内，须在清扫面）。
  const sweptTmp = sweepAbandonedTmpFilesThrottled(bookRoot)
  if (sweptTmp > 0) {
    log.info('state', `已清扫 ${sweptTmp} 个崩溃残留的临时文件（atomicWrite 半途崩溃遗留）`)
  }
  // 孤儿 journal 归档（`.orphaned-<ts>`，改名产物）超龄清扫
  // ——sweep 只管 .tmp/.lock，归档改名后无清理机制长期堆积。30 天 mtime 判定（远宽于
  // tmp 的 5 分钟：归档是「可手工恢复」的保留数据面），不产 issue，纯卫生，留痕即可。
  const sweptOrphaned = sweepOrphanedJournalArchives(bookRoot)
  if (sweptOrphaned > 0) {
    log.info('state', `已清扫 ${sweptOrphaned} 个超龄孤儿 journal 归档（.orphaned-*，30 天无人认领）`)
  }
  if (cloudCopies.length > 0) {
    issues.push({
      kind: 'cloudCopy',
      humanMsg: '检测到同步盘副本残留，可能有双写冲突。',
      fix: '对比副本和原文件，确认哪份是真内容后删掉多余的；警示同步盘风险（建议关掉书仓库的同步盘）。',
      files: cloudCopies,
    })
  }

  // ⑤ ：清单「在册可读但零条可解析」哨兵——readManifest 对坏行静默
  // 跳过、finalizedPathSet/finalizedChapterSetOfBook 把解析级全损当合法空集（定稿防覆盖
  // 闸 ensureChapterNotFinalized 由此 fail-open，可静默覆盖已定稿章），且坏清单的下次写
  // 会把空表物理落盘永久化。清单文件存在且可读、解析后 0 条文档条目、而 写作/正文 树扫描
  // 存在章节 .md → 报红健康项交作者裁决。**只加可见哨兵，不新增写阻断路径**（避免行为面
  // 扩大；数据恢复面由 manifest.ts 写前 .bak 影子承接）。
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  if (existsSync(manifestPath)) {
    let readable = true
    try {
      readFileSync(manifestPath)
    } catch {
      readable = false // 读失败（EACCES/EBUSY 瞬态）：与口径一致不误报
    }
    // 空判改按**当次实际读到的清单**重解析——原先沿用 enter
    // 传入的镜像，本函数先行的自愈写（healMovePending 补清单等）与锁内他方写入
    // 均不可见，镜像零条 → 已补录的书误报 manifestEmpty 红项
    const docEntries = readable
      ? [...readManifest(manifestPath).entries.values()].filter((e) => e.nodeType === 'document').length
      : 0
    if (readable && docEntries === 0 && maxFileNameChapter(join(bookRoot, '写作', '正文')) > 0) {
      issues.push({
        kind: 'manifestEmpty',
        humanMsg: '文档清单在册可读却没有任何文档记录，而正文区存在章节文件——清单可能被外部清空或损坏，定稿防覆盖闸已失效。',
        fix: '从 项目/文档清单.jsonl.bak（上一份好内容的影子副本）恢复清单；恢复后重进本书，再核对定稿章是否齐全。',
        files: ['项目/文档清单.jsonl'],
      })
    }
  }

  // ⑥ 阶段 24 ：结构崩溃不变量（设计方案 §5.5 v3 修订）——`并入` 所指章存活于
  // 正文 = 合并半成态（① 后崩溃：fm 已写、源章软删未起，内容暂重复可见）。挂点 =
  // detectState 书内检查（不挂 startup-notices——server 生命周期一次性通告通道）；
  // 态 1 报文指引两条既有收敛路径（重跑「并入上一章」幂等续跑 / 「撤销并入」整体
  // 回退，见 structure.ts 崩溃形态分支），盘面收敛后报文自然消失。不进
  // crashedPendingOpIds 提取（结构半成态无 journal pending 可 abort——「忽略」按钮
  // 对无持久登记的报红是假消解，指引作者收敛才是真闭环）。
  try {
    for (const v of detectStructureViolations(bookRoot)) {
      issues.push({
        kind: 'structurePending',
        humanMsg: `合并中断：第${v.targetChapterNo}章「${v.targetTitle}」已登记并入第 ${v.sourceChapterNo} 章，但源章仍在正文（内容暂重复）。`,
        fix: '在章节树对目标章重新执行「并入上一章」即可幂等完成；或执行「撤销并入」整体回退。',
        // 0918修复批（B007）：targetDocId 死字段已删（恒 null、真臂永不走）——
        // 报文定位统一 targetPath，原三目死臂回归
        files: [v.targetPath],
      })
    }
  } catch (e) {
    // 降级纪律：检查异常不阻断进门，warn 留痕
    log.warn('state', `结构不变量检查异常，本轮降级跳过：${errMsg(e)}`)
  }

  return issues
}

/**
 * move 类 pending 确定性收口。返回 true = 已处理（不报 issue）。
 * - 新路径在、旧路径不在 → rename 已发生、清单未跟上 → 补清单 + settled（幂等：清单已对齐时只补 settled）
 * - 旧路径在、新路径不在 → rename 未发生 → 悬置 pending 标 aborted（无实际效果待恢复）
 * - 两端都在 / 都不在 / 路径越出书仓库 → 不可自动判定，返回 false 交作者
 * 异步化——清单 RMW 锁等待改 withManifestLockAsync、journal 回写改 appendSettled/
 * appendAborted 异步孪生（原同步版 Atomics.wait 在服务进程 HTTP 路径可冻结事件循环
 * 最坏 ≈12s）；锁内/锁外临界段保持同步 FS，自愈语义逐位不变。
 */
async function healMovePending(
  bookRoot: string,
  docId: string,
  p: JournalMovePending,
  // -源码 -①：唯一调用方（恢复扫描）恒传两参——必选化后 journalFile 空值
  // 兜底分支与 encodeOrLiteralNames 死码即删（docId 冒号手写替换与 encodeDocDirName 双源）
  manifestMirror: Manifest,
  journalFile: string,
): Promise<boolean> {
  const oldAbs = safeManifestPath(bookRoot, p.oldPath)
  const newAbs = safeManifestPath(bookRoot, p.newPath)
  if (!oldAbs || !newAbs) return false
  const oldExists = existsSync(oldAbs)
  const newExists = existsSync(newAbs)
  try {
    // doMoveOrRename 的落盘改 link+rm 两步后，「link 成功、删源前崩溃」
    // 会留下两端**同 inode** 并存（硬链接）的中间态——内容已完整在新位，删旧即得
    // 纯 newExists 形态，走下方 settle 分支确定性收口。不同 inode（外部并发在目标位
    // 写入了别的内容）无法确定性裁决，保守维持报红交作者。
    let oldLive = oldExists
    if (oldExists && newExists) {
      const so = statSync(oldAbs)
      const sn = statSync(newAbs)
      if (so.ino !== sn.ino || so.dev !== sn.dev) return false
      // （评审）：删旧硬链收编 rmWithRetry（「确实要删」原语）——
      // 同 inode 中间态的删旧恰是 win 杀软/索引器瞬时锁高发点（文件刚被落位），裸
      // rmSync 直败走下方 catch 报 crashedWrite 误报；退避后仍失败仍上抛走同一 catch
      //（自愈失败语义不变，仅消瞬时锁误报）。
      rmWithRetry(oldAbs)
      oldLive = false
    }
    if (newExists && !oldLive) {
      const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
      if (existsSync(manifestPath)) {
        // RMW 持清单锁（单源漏网点）——悬置 pending 自愈与
        // 他进程清单写（CLI batch-finalize / GUI 保存）并发时，裸 read→write 会用
        // 陈旧镜像整文件重写吞掉刚落的 finalizedRevision（定稿防线失守）
        // 锁等待异步化（withManifestLockAsync）
        await withManifestLockAsync(manifestPath, () => {
          const m = readManifestStrict(manifestPath) // RMW strict 读——读失败上抛走外层 best-effort，保旧清单
          const entry = m.entries.get(docId)
          if (entry && entry.path !== p.newPath) {
            entry.path = p.newPath
            writeManifest(manifestPath, m)
          }
        })
      }
      // 盘上清单已对齐新路径，但同次 healthCheck 的
      // finalizedLost 检查（③）与后续态 3 判定仍用入参旧镜像查旧路径 → 误报
      // 「已定稿文件不在盘上」；同步改写外层 manifest 内存镜像的 entry.path。
      if (manifestMirror) {
        const mirrorEntry = manifestMirror.entries.get(docId)
        if (mirrorEntry && mirrorEntry.path !== p.newPath) mirrorEntry.path = p.newPath
      }
      // settled/aborted 回写沿用被扫 journal 文件（传入路径）——
      // 不再用 docId 重拼（mac 存量字面名文件会写到编码新文件、pending 永不消）。
      await appendSettled(journalFile, p.opId, computeRevision(newAbs))
      return true
    }
    if (oldExists && !newExists) {
      await appendAborted(journalFile, p.opId, '恢复扫描判定：rename 未发生，清除悬置 pending')
      return true
    }
  } catch {
    return false // 自愈写盘失败 → 仍报 issue 交作者
  }
  return false
}

function journalDir(bookRoot: string): string {
  return join(bookRoot, '工作区', '.journal')
}

/** （c 修复批）：finalizedLost 每书 TTL 节流入口（口径同
 *  scanCloudCopiesThrottled）——窗内回上次结果（fail-closed：持续丢失面不消失），
 *  窗外重付逐条 statSync 并刷新缓存。 */
function finalizedLostCheckThrottled(bookRoot: string, manifest: Manifest): HealthIssue[] {
  const now = Date.now()
  const cached = finalizedLostCache.get(bookRoot)
  if (cached && now - cached.at < FINALIZED_LOST_THROTTLE_MS) return cached.issues
  const issues = detectFinalizedLost(bookRoot, manifest)
  finalizedLostCache.set(bookRoot, { at: now, issues })
  return issues
}

/** finalizedLost 逐条探测（原 healthCheck ③ 内联循环原样抽出，判定逐位不变）。
 *  ：已定稿文件丢失——清单在册有 finalizedRevision 的文档文件不在盘
 *（被外部删除/移走），detectHandEdits 的 rev===null 分支原先静默跳过，无任何健康出口
 *（静默丢章：章号推算只看盘上文件，缺章无感知）。归入态 1 issues 交作者裁决（恢复
 * 来源：版本档案/回收站/同步盘备份）。
 * /：核对范围从固定四前缀（HAND_EDIT_PREFIXES，态 3 手改检测的
 * 口径）放宽为「清单在册有 finalizedRevision 的全部 document 条目」。同时区分
 * 「确实不存在（ENOENT）」与「stat 出错（EACCES 等不可探测）」：后者同样计入 lost
 *（保守报红），但 warn 留痕——不可读 ≠ 不在盘，处置动作不同。 */
function detectFinalizedLost(bookRoot: string, manifest: Manifest): HealthIssue[] {
  const out: HealthIssue[] = []
  for (const entry of manifest.entries.values()) {
    if (entry.nodeType !== 'document' || !entry.finalizedRevision) continue
    const abs = safeManifestPath(bookRoot, entry.path)
    let statErr: NodeJS.ErrnoException | null = null
    if (abs !== null) {
      try {
        statSync(abs)
      } catch (e) {
        statErr = e as NodeJS.ErrnoException
      }
    }
    if (abs === null || statErr !== null) {
      if (statErr !== null && statErr.code !== 'ENOENT') {
        log.warn(
          'state',
          `已定稿文件「${entry.path}」状态探测失败（${statErr.code ?? '未知错误'}）：按丢失计入健康项——可能只是无读取权限，请人工核对后处置`,
        )
      }
      out.push({
        kind: 'finalizedLost',
        humanMsg: `已定稿文件「${entry.path}」不在盘上（可能被外部删除或移走）。`,
        fix: '从版本历史（工作区/.版本）或备份找回该文件；确认不需要可重新定稿覆盖基线。',
        files: [entry.path],
      })
    }
  }
  return out
}

/** 孤儿 journal 归档超龄清理门槛——30 天（毫秒）。
 *  归档（`<名>.jsonl.orphaned-<ts>`，改名产物）是「可手工恢复」的保留数据面，
 *  门槛远宽于 tmp 的 5 分钟：超 30 天 mtime 无变化即视为作者已放弃恢复，不再永久堆积。 */
const ORPHANED_JOURNAL_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** 清扫超龄孤儿 journal 归档（sweep 既有 best-effort 风格：
 *  目录不可读整体放弃、单项 stat/unlink 失败逐项跳过；mtime 判定，返回清除数）。 */
function sweepOrphanedJournalArchives(bookRoot: string, now: number = Date.now()): number {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(journalDir(bookRoot), { withFileTypes: true })
  } catch {
    return 0
  }
  let removed = 0
  for (const ent of entries) {
    // 改名形态唯一：`<原名>.orphaned-<毫秒时间戳>`；手放的 `._` AppleDouble 不匹配
    if (!ent.isFile() || !/\.orphaned-\d+$/.test(ent.name)) continue
    try {
      const full = join(journalDir(bookRoot), ent.name)
      if (now - Math.floor(statSync(full).mtimeMs) < ORPHANED_JOURNAL_MIN_AGE_MS) continue
      rmSync(full, { force: true })
      removed++
    } catch {
      /* 单项失败跳过（并发消失/权限） */
    }
  }
  return removed
}

/** 孤儿判定用的盘上快照——healthCheck 循环头读一次循环内共享。
 *  读失败标记沿用原「不确定 → 不归档」保守口径（对全部 journal 生效，整轮跳过归档）。 */
interface OrphanSnapshot {
  manifestFailed: boolean
  manifestIds: Set<string>
  trashFailed: boolean
  trashIds: Set<string>
}

function readOrphanSnapshot(bookRoot: string): OrphanSnapshot {
  const snap: OrphanSnapshot = { manifestFailed: false, manifestIds: new Set(), trashFailed: false, trashIds: new Set() }
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  try {
    if (existsSync(manifestPath)) snap.manifestIds = new Set(readManifest(manifestPath).entries.keys())
  } catch {
    snap.manifestFailed = true // 清单读失败：不确定 → 不归档
  }
  try {
    snap.trashIds = new Set(readTrashManifest(bookRoot).map((e) => e.id))
  } catch {
    snap.trashFailed = true // 回收站清单读失败：不确定 → 不归档
  }
  return snap
}

/** 判定 journal 是否孤儿（对其报红 = 永久幽灵）。保守三重证实：
 *  docId 不在清单 && 不在回收站 && move pending 两端路径均不在盘（save 类无路径
 *  字段，无法证实 → 永远返回 false 维持报红，防 genuine 崩溃被静默）。
 *  ：清单/回收站改用循环头快照——此前每个 journal 文件各整读一次，
 *  O(journal 数 × 清单条目数) 全同步；快照语义 = 原「以盘上为准」的循环头时点。
 *  ：pending 改由调用方传入（journal 单次整读共享），本函数不再自读。 */
function isOrphanJournal(bookRoot: string, docId: string, snapshot: OrphanSnapshot, pending: JournalAnyPending[]): boolean {
  if (snapshot.manifestFailed) return false // 清单读失败：不确定 → 不归档
  if (snapshot.manifestIds.has(docId)) return false
  if (snapshot.trashFailed) return false // 回收站清单读失败：不确定 → 不归档
  if (snapshot.trashIds.has(docId)) return false
  if (pending.length === 0) return false // 无未结算项：不在报红路径上，无需归档
  return pending.every((p) => {
    if (!isMovePending(p)) return false
    const oldAbs = safeManifestPath(bookRoot, p.oldPath)
    const newAbs = safeManifestPath(bookRoot, p.newPath)
    return oldAbs !== null && newAbs !== null && !existsSync(oldAbs) && !existsSync(newAbs)
  })
}

/**
 * （c 修复批）：save 类 pending 的确定性自动消解。
 * 返回 'settled' = 已处理（appendSettled 落账，本轮不再报 crashedWrite）。
 *
 * 背景：executeSave 的 settled 写失败（best-effort）或「atomicWrite 落盘后、
 * settled 前崩溃」留下悬置 save pending——healthCheck 原一律报 crashedWrite「可能丢
 * 字」，journal compact 恒保留未结算行，无任何复核/确认通道 → 幽灵红每次进门重复
 * 报且永久化。本函数给 save 类补上与 healMovePending（move 类）对位的确定性复核：
 * 读盘上文件 computeRevision 与 pending.baseRevision 比对——
 * - 不一致 ⇒ 该次保存实际已落盘（盘上内容已演进）：自动 appendSettled 消解，不报红；
 * - 相等 ⇒ 真未落盘（内容仍停在保存前基线）：维持报红交作者；
 * 保守边界（一律维持报红，'crashed'）：
 * - docId 不在清单（无主面归 isOrphanJournal 保守口径）或路径越出书仓库；
 * - baseRevision 为 null（journal.ts :226-239 注明合法——新建场景）：无从比对；
 * - 盘上文件不存在（ENOENT，含 exists 与 read 间竞态被删）：定稿丢失面另有
 *   finalizedLost 检查，此处不消解不误消；
 * - 比对失败（读盘异常非 ENOENT）：保守报红并 warn 留痕；
 * - 消解 settled 自身写失败：报红兜底（下次进门重试消解）。
 * 返回 'inflight' = （修复批）：比对相等且该 doc 的
 * 保存锁（`<journal>.save.lock`，executeSave / saveDraft 同键）在持——
 * 慢盘/杀软全盘扫描下大章保存进行中（journal pending 已写、atomicWriteFile 未落定、
 * revision 未推进）正是「相等」形态，但这是**在途非崩溃**：本轮跳过不报红不消解（不
 * appendSettled——保存自身收尾会写），锁释放后的下一轮复核按盘上结果自然收敛到
 * settled/crashed 两态。queryLockHeld 只读不取锁（「查询判 held ⟺ acquire 会拿到
 * null」口径对齐），陈锁判定复用 judgeStaleLock（死 pid/超龄不算在持，不会把真崩溃
 * 误判成在途）。
 */
type SavePendingVerdict = 'settled' | 'inflight' | 'crashed'

async function reconcileSavePending(
  bookRoot: string,
  docId: string,
  p: JournalPending,
  manifest: Manifest,
  journalFile: string,
): Promise<SavePendingVerdict> {
  const rel = manifest.entries.get(docId)?.path
  if (!rel) return 'crashed' // 不在册：无法定位盘上文件，保守报红
  const abs = safeManifestPath(bookRoot, rel)
  if (abs === null) return 'crashed' // 路径越出书仓库：无法安全读盘，保守报红
  if (p.baseRevision === null) return 'crashed' // 无基线（新建场景合法）：无法比对，保守报红
  let rev: `sha256:${string}`
  try {
    if (!existsSync(abs)) return 'crashed' // 文件不在盘（ENOENT 面）：维持报红，不消解
    rev = computeRevision(abs)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'crashed' // exists 与 read 间被删：同「不在盘」口径
    log.warn('state', `save 类 pending 复核读盘失败（${rel}，保守维持报红）：${errMsg(e)}`)
    return 'crashed'
  }
  if (rev === p.baseRevision) {
    // 锁在持 = 保存进行中（journal 锁名与写侧 executeSave/saveDraft
    // 的 `${journalPath}.save.lock` 同键；扫描到的 journalFile 即该 doc 的 journal 文件）
    if (queryLockHeld(`${journalFile}.save.lock`)) return 'inflight'
    return 'crashed' // 盘上仍是保存前基线且无在途保存：真未落盘，维持报红
  }
  try {
    await appendSettled(journalFile, p.opId, rev)
  } catch (e) {
    log.warn('state', `save 类 pending 自动消解 settled 写失败（${rel}，维持报红待下次进门重试）：${errMsg(e)}`)
    return 'crashed'
  }
  log.info('state', `save 类 pending 已确定性消解（${rel}）：盘上指纹已非 pending 基线，判定该次保存实际已落盘，补 settled 不再报红`)
  return 'settled'
}

/** 态 3：已定稿文件有未重新定稿的改动（manifest.finalizedRevision vs 当前指纹）。 */
/** 态 1 与态 3 共用的「参与指纹比对」前缀——正文/设定/大纲/布线。 */
const HAND_EDIT_PREFIXES = ['写作/正文/', '设定/', '大纲/', '布线/']

export function detectHandEdits(bookRoot: string, manifest: Manifest): string[] {
  const handEditPrefixes = HAND_EDIT_PREFIXES
  const out: string[] = []
  for (const entry of manifest.entries.values()) {
    if (entry.nodeType !== 'document') continue
    if (!entry.finalizedRevision) continue // 从未定稿 → 不是手改（是正常草稿流程）
    if (!handEditPrefixes.some((p) => entry.path.startsWith(p))) continue
    // ff ：走 probeCachedRevision（mtime+size 命中免整读+哈希）——enter 每次进门
    // 对全部定稿文档全量读盘是大书同步阻塞点；null 兼「文件不存在」跳过语义，
    // 与 check/run.ts 树红点聚合同缓存同口径，随 invalidateTreeIndex 失效。
    const rev = probeCachedRevision(bookRoot, entry.path)
    // 文件不在盘的 rev===null 不在此处吞——healthCheck 的
    // finalizedLost issue 已把「已定稿文件丢失」归入态 1（先于态 3 判定）
    if (rev === null) continue
    if (rev !== entry.finalizedRevision) out.push(entry.path)
  }
  return out
}

/** 态 4：工作区/正文区是否有未完成章节（中断判定）。
 *  信号：工作区细纲.md / .confirm.json，或正文区存在未定稿（无 finalizedRevision）的草稿文件。 */
export function detectIncompleteWorkdir(bookRoot: string, manifest: Manifest): number | null {
  const workDir = join(bookRoot, '工作区')
  const hasOutline = existsSync(join(workDir, '细纲.md'))
  const hasConfirm = existsSync(join(workDir, '.confirm.json'))
  const unfinishedChapter = findUnfinishedChapter(bookRoot, manifest)
  if (!hasOutline && !hasConfirm && !unfinishedChapter) return null

  let chapterNum = 0
  // 章号源优先：.confirm.json.chapter（写作中断时确认过细纲）> 正文区未定稿草稿
  if (hasConfirm) {
    try {
      const rec = JSON.parse(readFileSync(join(workDir, '.confirm.json'), 'utf-8')) as { chapter?: unknown }
      // chapter 三连守卫（typeof + isSafeInteger + >0）——此前裸 as
      // 强转，手改 `"chapter": "12"` 让字符串穿透（566 宽松比较放行、严格等判定恒
      // false），`3.5` 非整数照收；对齐全库章号入口口径（format/chapters.ts:58）
      chapterNum =
        typeof rec.chapter === 'number' && Number.isSafeInteger(rec.chapter) && rec.chapter > 0
          ? rec.chapter
          : 0
    } catch {
      // 坏的 .confirm.json 不影响判定（当无章号）
    }
  }
  if (chapterNum === 0 && unfinishedChapter) {
    chapterNum = unfinishedChapter
  }
  return chapterNum > 0 ? chapterNum : null
}

/** 正文区未定稿（无 finalizedRevision）的草稿文件章号；从 frontmatter 或文件名提取。 */
function findUnfinishedChapter(bookRoot: string, manifest: Manifest): number | null {
  const finalizedStems = new Set<string>()
  for (const e of manifest.entries.values()) {
    if (e.nodeType !== 'document' || !e.finalizedRevision) continue
    // 定稿集改 docJoinKey 键（win32 折叠 + NFC）——外部 case-only
    // 改名 / NFD 文件名后精确匹配失配，定稿章被误判「未完成」→ 进门恒报中断
    finalizedStems.add(docJoinKey(e.path))
  }
  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) return null
  // 裸 statSync（跟随 symlink）+ 无 visited 递归改走 walk-md 共享
  // 口径（Dirent 不跟随 symlink + realpath 剪枝 + 根界）——循环 symlink 不再进门崩。
  // 未定稿草稿取最小章号——原遍历序首个（readdir 序平台漂移，
  // 多草稿并存时态 4 报告与 resumePoint 判定随平台漂移）；收集全部取最小确定性收敛。
  const draftChapters: number[] = []
  walkMdEach(bodyDir, (fp, name) => {
    const rel = relativePath(bookRoot, fp)
    if (finalizedStems.has(docJoinKey(rel))) return // 已定稿，不算未完成（同口径键）
    const no = chapterFromFile(fp, name)
    if (no > 0) draftChapters.push(no)
  })
  return draftChapters.length > 0 ? Math.min(...draftChapters) : null
}

/** 从文件 frontmatter 章号 或 文件名数字提取章号。
 *  ii 批：全文正则 → splitFrontMatter + parseFlat——正则扫整个文件，正文里出现
 *  「章号: N」字样（作者手记/引用）会抢先命中，章号错位；现只在 fm 块内查键。 */
function chapterFromFile(absPath: string, name: string): number {
  try {
    const raw = readFileSync(absPath, 'utf-8')
    const fm = splitFrontMatter(raw)
    if (fm) {
      const no = parseFlat(fm.fmRaw).get('章号')
      if (typeof no === 'number' && Number.isSafeInteger(no)) return no
    }
  } catch {
    // 读失败忽略
  }
  // 文件名兜底：只认文件名开头的数字（NNN-标题.md 约定）；未锚定会抓到
  // 标题中段的数字（如「第2卷-001-雨夜.md」取 2），章号错位
  const m = name.match(/^0*(\d+)/)
  return m ? Number(m[1]) : 0
}

function relativePath(bookRoot: string, absPath: string): string {
  // win 上 relative 产反斜杠而 manifest 键是正斜杠——归一后对齐。
  // -mac适配：归一收窄 win32-only（normalizeWinSeparators 单源）——
  // posix 上字面 `\` 是合法文件名字符，保持原样与 manifest 侧（resolveWithinRoot.rel /
  // relPathKey）同口径，不再把 `a\b.md` 扭曲为 `a/b.md` 致 docJoinKey 双侧失配
  return normalizeWinSeparators(relative(bookRoot, absPath))
}

/** 章节是否已定稿：manifest 中该章 entry 有 finalizedRevision。
 *  ：原签名首位 bookRoot 参数从引入起未被函数体消费
 *  （判定只依赖 manifest 路径前缀），随批删除——唯一调用点同步收窄。 */
export function isChapterFinalized(chapterNum: number, manifest: Manifest): boolean {
  for (const e of manifest.entries.values()) {
    if (e.nodeType !== 'document' || !e.finalizedRevision) continue
    if (!e.path.startsWith('写作/正文/')) continue
    const no = chapterFromRelPath(e.path)
    if (no === chapterNum) return true
  }
  return false
}

/** 从正文区相对路径提取章号（0001-标题.md → 1；嵌套卷同）。 */
function chapterFromRelPath(relPath: string): number {
  const base = relPath.split('/').pop() ?? ''
  const m = base.match(/^(\d+)-/)
  if (!m) return 0
  // 与 parseChapterFileName 同款 isSafeInteger 守卫——超精度
  // 数字章号按 0（无章号）处理，不入状态机
  const no = Number(m[1])
  return Number.isSafeInteger(no) ? no : 0
}

/** 正文区未定稿文件名集合（用于排除草稿——未定稿不计入"已写"）。 */
export function unfinishedPieceNames(bookRoot: string, manifest: Manifest): Set<string> {
  const finalized = new Set<string>()
  for (const e of manifest.entries.values()) {
    // 定稿集改 docJoinKey 键（同文件 findUnfinishedChapter
    // 先例）——外部 case-only 改名 / NFD 文件名后精确匹配失配，定稿章被误列「未定稿」
    // → 已写章数被低估（态 7 分支/recap 口径漂移）
    if (e.nodeType === 'document' && e.finalizedRevision) finalized.add(docJoinKey(e.path))
  }
  const out = new Set<string>()
  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) return out
  // 同 findUnfinishedChapter——改走 walk-md 共享口径
  walkMdEach(bodyDir, (fp, name) => {
    if (!/^\d+-/.test(name)) return
    const rel = relativePath(bookRoot, fp)
    if (!finalized.has(docJoinKey(rel))) out.add(rel.slice('写作/正文/'.length)) // 双侧同键（扫描路径侧折叠）
  })
  return out
}

// 已定稿章数 = readChapterDir 章数 − 未定稿文件数（排除草稿后再计"已写"，见态 7 分支与 readRecapSnapshot）

/** 正文区文件名里的最大章号（含 fm 解析失败的文件；无匹配 → 0）。：nextChapter 下限。
 *  0918修复批（B005）：取号下限面（state.ts nextChapter / recap currentChapter /
 *  本文件 manifestEmpty 哨兵三类消费点全是「已用章号下限/章文件存在性」语义）从窄正则
 *  parseChapterFileName（须 `数字-标题`）切到 chapterNoFromName 单源（tree 宽容集：
 *  `5—标题.md`/`5 标题.md` 兼收）+ 剥 .md 扩展——裸数字名（0012.md）此前失明，
 *  nextChapter 回指已用号（章号复用）。命名违规检测类消费面不经本函数（各持窄口径），
 *  无两类共用面、不拆函数。 */
export function maxFileNameChapter(bodyDir: string): number {
  if (!existsSync(bodyDir)) return 0
  let max = 0
  // 同 findUnfinishedChapter——改走 walk-md 共享口径
  walkMdEach(bodyDir, (_fp, name) => {
    // 剥 .md 扩展（大小写不敏感，isMdFileName 单源）后再判——chapterNoFromName 的
    // 宽容集以分隔符/串尾收口，「0012.md」带扩展直判会因尾点失配
    const stem = isMdFileName(name) ? name.slice(0, -3) : name
    const n = chapterNoFromName(stem)
    if (n !== null && n > max) max = n
  })
  return max
}

/** n 起步跳过一切已定稿章号（「篇号永不复用」语义；连续定稿时 n+1 即空闲，零开销）。 */
export function skipFinalizedChapters(n: number, finalized: Set<number>): number {
  let next = n
  while (finalized.has(next)) next++
  return next
}
