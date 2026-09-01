/**
 * 定稿时账本履历回写（W-P1-3 右端闭环 + 决策 2「一并补齐履历回写，放 finalize 回写」）。
 *
 * 流程：作者/AI 写完章 → AI 生成 工作区/账本推进.md（AI 草拟，作者可在编辑器确认/修改）
 * → 定稿（finalizeRevision）→ 本模块把「已确认」的账本推进逐条回写布线条目 履历 段
 * → 清空 账本推进.md（归档设计 定稿操作-设计方案.md:135「定稿时清理账本推进.md」）。
 *
 * X-P2-6：批量连写下各章草稿按章归档（工作区/.账本推进暂存/第N章.md）——回收时
 * 主文件（章节标签匹配或无标签旧格式）与本章归档一并读取，其余章的待确认内容不动。
 * X-P2-8：resolve/drop 动词落库时同步派生条目 状态（与 checkStatusClosure 口径对齐），
 * 防「履历末条揭晓 + 状态进行中」自产 lead-status-open 红阻断后续章自愈。
 *
 * 幂等：定稿 skipped（指纹未变）时不重复回写；回写后再定稿同一章（内容已改）时
 * 账本推进.md 已被清空 → 无新条目 → 天然不重复追加。
 */
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { atomicWriteFile } from '../fs/atomic.js'
import { join } from 'node:path'
import { readLead, readLeadDir, writeLead, LEAD_TYPES, LEAD_VERBS } from '../format/leads.js'
import { acquireCrossProcessLockWithTimeout, acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'
import { log } from '../log/index.js'
import { isUtf8Bytes } from './service.js'
import {
  readChapterUpdatesForChapter,
  chapterUpdateSources,
  readLeadUpdateChapterTag,
  LEAD_UPDATES_FILE,
  LEAD_UPDATES_ARCHIVE_DIR,
  type ChapterLeadUpdate,
} from '../check/lead-updates.js'

// ff-P1-1 常量归一：路径唯一出处移至 check/lead-updates.ts（闸与回写共用），此处再导出兼容既有导入方
export { LEAD_UPDATES_FILE, LEAD_UPDATES_ARCHIVE_DIR }

/**
 * R26-6（二十六轮）：布线回写临界段跨进程锁等待（毫秒）——单条履历回写的持锁段是
 * 毫秒级文件 IO，5s 与全仓锁基建最长等待档同源（manifest/journal/save 同档）。
 * R30-18（三十轮）：常量化——export let 可被任一 import 方静默改写（同 events/store.ts
 * R26-105 的收口认定），改 const + 内部可变生效值；测试只能经注入钩子改档，生产恒用常量。
 */
export const LEAD_FINALIZE_LOCK_TIMEOUT_MS = 5_000

/** 生效值（模块内可变）：初值 = 常量；仅注入钩子可改。 */
let leadFinalizeLockTimeoutMs = LEAD_FINALIZE_LOCK_TIMEOUT_MS

export function __setLeadFinalizeLockTimeoutForTest(ms: number): void {
  leadFinalizeLockTimeoutMs = ms
}

/**
 * R30-5（三十轮）：本章待回写条目与其目标布线文件的解析结果——定稿布线预取锁与
 * 持锁核心共用的同一份数据（防两处各自解析漂移）。
 */
export interface LeadUpdateTargets {
  /** R34D-3（三十四轮）：书仓库根——持锁核心锁内重读本章推进源（主文件/归档）必需
   *  （targets.updates 只是锁外预解析快照，锁窗内可被作者删改，见核心函数内注释）。 */
  bookRoot: string
  mainPath: string
  archivePath: string
  mainIsThisChapter: boolean
  /** 本章全部待确认条目（消费顺序与旧实现一致）。 */
  updates: ChapterLeadUpdate[]
  /** leadId → 目标布线文件绝对路径（查无此线的条目不在表内）。 */
  files: Map<string, string>
}

/** 布线目录：基础类在 布线/{类}，关系线在 大纲/关系线（与 cache/rebuild.ts 同口径）。 */
function wiringDirs(bookRoot: string): string[] {
  const dirs: string[] = []
  for (const typeName of LEAD_TYPES) {
    const root = typeName === '关系线' ? join(bookRoot, '大纲') : join(bookRoot, '布线')
    dirs.push(join(root, typeName))
  }
  return dirs
}

/**
 * R30-5（三十轮）：解析本章待回写条目与全部目标布线文件（不取锁，纯读）。
 * 定稿路径在进入清单锁**之前**调它来预取布线锁；自取锁包装层也用它确定要取的锁集。
 */
export function resolveLeadUpdateTargets(bookRoot: string, chapterNo: number): LeadUpdateTargets {
  // ff-P1-1：读取走 readChapterUpdatesForChapter 单源（主文件属于本章时 + 本章归档）——
  // 与定稿闸（finalize.ts finalGateBlockers）严格对称，闸看到的=回写要写的；
  // 主文件载有其他章待确认内容（批量连写）时不动它。
  const { mainPath, archivePath, mainIsThisChapter } = chapterUpdateSources(bookRoot, chapterNo)
  const updates = readChapterUpdatesForChapter(bookRoot, chapterNo)
  const files = new Map<string, string>()
  if (updates.length > 0) {
    const dirs = wiringDirs(bookRoot)
    for (const u of updates) {
      const leadFile = findLeadFile(dirs, u.leadId)
      if (leadFile) files.set(u.leadId, leadFile.filePath)
    }
  }
  return { bookRoot, mainPath, archivePath, mainIsThisChapter, updates, files }
}

/**
 * R30-5（三十轮）：对全部目标布线文件预取同名锁（`<布线文件>.lock`）。
 * 文件按路径排序后逐个取——多文件批次内取序确定化，双进程各自成批时不因批次内
 * 取序不同互等（批量内自成环）。任一文件取不到（超时/获取抛出→按超时同通道）→
 * 释放已取得者并返回 null（fail-closed，绝不部分持锁裸写）。
 * 同步版给 finalizeRevision（同步孪生），异步版（R30-6）给 finalizeRevisionAsync /
 * 自取锁包装——异步等待期 setTimeout 轮询，不阻塞事件循环。
 */

/** 同步预取：全部成功 → release 列表；任一失败 → 释放已取得者并返回 null。 */
export function acquireLeadFileLocksSync(files: Iterable<string>): (() => void)[] | null {
  const releases: (() => void)[] = []
  for (const f of [...new Set(files)].sort()) {
    let release: (() => void) | null
    try {
      release = acquireCrossProcessLockWithTimeout(`${f}.lock`, leadFinalizeLockTimeoutMs)
    } catch (e) {
      log.warn('lead-finalize', `布线锁获取失败（${f}.lock）：${e instanceof Error ? e.message : String(e)}`)
      release = null
    }
    if (!release) {
      for (const r of releases) r()
      return null
    }
    releases.push(release)
  }
  return releases
}

/** 异步预取（R30-6）：语义与同步版逐位对齐，等待期 setTimeout 轮询不阻塞事件循环。 */
export async function acquireLeadFileLocksAsync(files: Iterable<string>): Promise<(() => void)[] | null> {
  const releases: (() => void)[] = []
  for (const f of [...new Set(files)].sort()) {
    let release: (() => void) | null
    try {
      release = await acquireCrossProcessLockAsync(`${f}.lock`, leadFinalizeLockTimeoutMs)
    } catch (e) {
      log.warn('lead-finalize', `布线锁获取失败（${f}.lock）：${e instanceof Error ? e.message : String(e)}`)
      release = null
    }
    if (!release) {
      for (const r of releases) r()
      return null
    }
    releases.push(release)
  }
  return releases
}

/**
 * 把已确认的账本推进回写布线履历（找到对应条目按 编号 追加履历行），
 * 成功回写后清空本章 账本推进.md / 本章归档。
 *
 * R30-5（三十轮）拆层：本函数是**自取锁包装**（保留旧 applyLeadUpdates 语义，供
 * 定稿链以外的直接调用方/测试使用）；持锁核心见 applyLeadUpdatesLocked。定稿路径
 * （finalizeRevision/Async）不走本包装——它需在进入清单锁**之前**预取布线锁
 * （统一锁序「布线锁 → 清单锁」，消 save↔finalize 的 ABBA 对），持锁后直接调核心，
 * 不得在同进程内嵌套再取同名锁（本实现同进程嵌套取同名锁会等到超时失败）。
 *
 * 锁语义（原 R26-6/R29-7 注释的 R30-5 版）：对每个目标布线文件取同名跨进程短锁，
 * 与 service.ts 三个写路径（executeSave/updateChapterMeta/updateDocMeta）在 save 锁内
 * 取的同名锁互斥，覆盖（lost update）窗口闭合。批量条目改为**预取全部目标锁后再回写**
 *（旧实现逐条取/放）：任一文件取不到锁 → 整批 fail-closed 拒绝（applied=0，条目全部
 * 留本章源，下次定稿自动重试），不降级裸写——裸写正是本锁要闭合的覆盖形态。
 * R30-6：取锁等待用 acquireCrossProcessLockAsync（setTimeout 轮询），不阻塞事件循环。
 *
 * @param bookRoot 书仓库根
 * @param chapterNo 定稿章号（履历行「第N章」）
 * @returns 回写条数（无账本推进文件 / 全部条目未回写 → 0）
 */
export async function applyLeadUpdates(bookRoot: string, chapterNo: number): Promise<number> {
  const targets = resolveLeadUpdateTargets(bookRoot, chapterNo)
  if (targets.updates.length === 0) return 0
  const releases = await acquireLeadFileLocksAsync(targets.files.values())
  if (releases === null) {
    // 整批 fail-closed：applied=0，按既有 X-P2-6 语义不动本章源（条目本就在盘上，
    // 作者原文原样保留，下次定稿自动重试）；warn 留痕让「锁争用导致本次未回写」可观测。
    log.warn(
      'lead-finalize',
      `布线回写锁等待超时（${leadFinalizeLockTimeoutMs}ms 未全部让出）——本章 ${targets.updates.length} 条账本推进整批留源未回写，下次定稿自动重试`,
    )
    return 0
  }
  try {
    return applyLeadUpdatesLocked(chapterNo, targets)
  } finally {
    for (const r of releases) r()
  }
}

/**
 * R30-5（三十轮）：**持锁核心**——执行履历回写 + 本章源清理，不取任何锁。
 * 前置契约：调用方已持有 targets.files 中全部布线文件的同名布线锁
 *（定稿路径 = finalize 在进清单锁前的预取锁；直接调用方 = applyLeadUpdates 包装层）。
 * 核心内禁止再取同名锁：同进程嵌套取同名锁会等到超时失败。锁内重读语义保留：
 * 每个布线文件的内容在写入前重读（readLead）——预取锁窗口内他进程可能已改写该线，
 * 预解析时的 lead 内容作废，读→改→写全程在锁内，lost update 窗口闭合。
 * R34D-3（三十四轮）：重读面从「布线文件内容」扩到「本章推进源」——核心开头对
 * 主文件/归档重跑 readChapterUpdatesForChapter（targets.bookRoot），履历条目以重读
 * 结果为准（targets.updates 仅剩预取锁集的用途），residue 同源派生。
 *
 * 锁序说明（替代原 lead-finalize.ts:81-90 R26-6/R29-7 注释）：全仓统一锁序为
 * 「save 锁 → 布线锁 → 清单锁」——service 保存链持 save 锁后取布线锁、再进清单锁
 *（maybeUpdateManifest）；定稿链先取布线锁（本文件预取助手）、再进清单锁
 *（finalize.ts）。两侧同名布线锁互斥，且对清单锁的获取序一致，R30-5 之前的
 * 「定稿持清单锁再取布线锁」反向交叉对（与保存链构成 ABBA 等待）已消除。
 */
export function applyLeadUpdatesLocked(
  chapterNo: number,
  targets: LeadUpdateTargets,
): number {
  let applied = 0
  /** M-6 通道扩展（R26-6）：未回写条目带原因——警告文本按原因给准确的处置指引。 */
  const unresolved: { u: ChapterLeadUpdate; why: 'not-found' | 'non-utf8' }[] = []
  // R34D-3（三十四轮）：持锁核心开头**锁内重读**本章推进源（主文件/归档）——
  // targets.updates 是锁外预解析快照（finalize 在布线锁/清单锁外调 resolveLeadUpdateTargets），
  // 账本推进.md 在编辑器白名单内，锁等待窗（布线锁+清单锁最长 ~10s）内作者可删改账目；
  // 按陈旧快照回写会把旧措辞落履历、作者改后的新措辞被无痕清空（R33D-4 的锁内复核只查
  // 章标签不查内容，同章编辑不设防）。以重读结果生成履历条目，三态对齐：
  // - 窗内被改证据 → 以**新措辞**回写（回写=作者最新确认内容）；
  // - 窗内被作者删除 → 不在重读结果 → 既不回写也不进 residue（尊重删除）；
  // - 窗内新增条目 → files map 预解析时查无（布线锁只对预取集持有）→ 走既有 not-found
  //   通道留本章源，下次定稿重解析自动重试——**绝不**对未持锁布线文件落写（写预取集外
  //   文件 = 裸写，违反整批 fail-closed 纪律）。
  // 幂等去重（章号+动词+证据）与 ：263 R33D-4 章标签复核保持不变。
  const liveUpdates = readChapterUpdatesForChapter(targets.bookRoot, chapterNo)
  for (const u of liveUpdates) {
    const filePath = targets.files.get(u.leadId)
    if (!filePath) {
      // M-6（第六轮）：查无此线不再随清空静默丢弃——此前混合场景（一条成功 + 一条查无）
      // 下 applied>0 触发整体清空，被跳过的推进无 issue、无提示永久丢失，违反「不得
      // 静默通过」红线（M5-C 同族）。改为写回本章源并留警告，作者可见可修，下次定稿
      // 本章自动重试（回写按 章号+动词+证据 幂等）。
      unresolved.push({ u, why: 'not-found' })
      continue
    }
    // 锁内重读（锁由调用方在持）：预解析窗口内他进程可能已改写该线——
    // 读→改→写全程在锁内，lost update 窗口闭合
    const reread = readLead(filePath)
    if (!reread.ok) {
      unresolved.push({ u, why: 'not-found' })
      continue
    }
    const lead = reread.lead
    // 去重：同 章号+动词+证据 已在履历中（内容未变重复定稿）→ 跳过
    const dup = lead.履历.some(
      (e) => e.章号 === chapterNo && e.动词 === u.动词 && e.证据 === u.证据,
    )
    if (dup) continue
    // M-9（第八轮）：定稿回写的编码防线——盘上非 UTF-8（如 GBK 布线文件，utf-8 读入
    // 即乱码）时拒绝写回：线索文件不在快照留底范围、writeVersion 只为被定稿章建档，
    // 原子写回即原始字节永久丢失（save/updateChapterMeta/updateDocMeta 三写点之后的
    // 最后一个无留底写点）。与「查无此线」同通道：条目留本章源 + 警告，作者转码后
    // 下次定稿自动重试（回写按 章号+动词+证据 幂等）。
    if (!isUtf8Bytes(readFileSync(filePath))) {
      unresolved.push({ u, why: 'non-utf8' })
      continue
    }
    lead.履历.push({ 章号: chapterNo, 动词: u.动词, 证据: u.证据 })
    // X-P2-8：按动词派生状态（仅 进行中 → 终态；作者显式标注的终态/其他值不覆盖）。
    // 成长线 resolve（突破/跨层/跃迁）是常态化升级，保持 进行中（与 checkStatusClosure 特判一致）。
    const leadType = u.leadId.split('-')[0] as keyof typeof LEAD_VERBS
    const verbs = LEAD_VERBS[leadType]
    if (verbs && lead.状态 === '进行中') {
      if (verbs.drop.includes(u.动词)) lead.状态 = '已放弃'
      else if (verbs.resolve.includes(u.动词) && leadType !== '成长线') lead.状态 = '已收尾'
    }
    writeLead(filePath, lead)
    applied++
  }

  // 回写完成后清空本章源（作者已确认并落库，防重复追加）；其他章待确认内容保持原样。
  // M-6：清空时未回写条目以警告形式写回本章源而非丢弃（residue 为空串 = 旧版清空；
  // applied=0 时不动文件——纯未解析场景条目本就在盘上，作者原文原样保留，X-P2-6 语义不变）。
  if (applied > 0) {
    const residue = unresolved.length > 0 ? unresolvedText(chapterNo, unresolved) : ''
    if (targets.mainIsThisChapter && existsSync(targets.mainPath)) {
      // R33D-4（三十三轮）：锁内复核再清空——targets（含 mainIsThisChapter 判定）在
      // finalize 的布线锁/清单锁**外**解析，锁等待窗口（最长 ~10s）内他请求的
      // generateLeadUpdateDraft(N+1) 可写入新的他章草稿（该文件与定稿锁不互斥，且在
      // 编辑器白名单内可被作者手改）。按锁外快照直接清空会把新草稿无痕抹掉。锁内重读
      // 章标签：仍为本章/无标签（旧格式语义上属本章）才清；已变成他章 → 主文件原样
      // 保留（新草稿完整无损，含未确认内容），本章归档照常清理，warn 留痕。
      const liveTag = readLeadUpdateChapterTag(targets.mainPath)
      if (liveTag !== null && liveTag !== chapterNo) {
        log.warn(
          'lead-finalize',
          `账本推进主文件在定稿锁等待窗口内被改写为第${liveTag}章草稿——跳过清空保护新内容（第${chapterNo}章履历回写不受影响）`,
        )
      } else {
        try {
          // dd-P3：统一原子写（目标虽是清空，也走 tmp+rename 消裸写窗口）
          // ee-P1-6：对齐账本写点 fsync 纪律（掉电回退由履历去重兜底，fsync 消除该窗口）
          atomicWriteFile(targets.mainPath, residue, { fsync: true })
        } catch {
          /* 清空失败不阻断定稿主流程 */
        }
      }
      if (existsSync(targets.archivePath)) {
        try {
          rmSync(targets.archivePath, { force: true })
        } catch {
          /* 归档清理失败不阻断定稿主流程 */
        }
      }
    } else if (existsSync(targets.archivePath)) {
      // 主文件载有其他章待确认内容（X-P2-6）——主文件不动；本章归档全兑现则删，
      // 有查无此线残留则改写为警告文本（不丢条目）
      try {
        if (residue) atomicWriteFile(targets.archivePath, residue, { fsync: true })
        else rmSync(targets.archivePath, { force: true })
      } catch {
        /* 同上：失败不阻断定稿主流程 */
      }
    }
  }
  return applied
}

/** M-6：未回写条目的写回文本——保住章节标签（chapterUpdateSources 仍归本章）+
 *  按原因分组的警告注释（非列表行，不会被 parseLeadUpdateLines 当推进条目）+ 原条目行。
 *  R26-6：原因从单一「查无此线」扩为三档，警告文本按档给准确处置指引（锁超时条目
 *  沿用「查无此线」文案会误导作者去改编号）。注释单行闭合——条目行必须留在注释外，
 *  作者修正后重试回写的解析（readChapterUpdatesForChapter）才看得见。 */
function unresolvedText(
  chapterNo: number,
  unresolved: { u: ChapterLeadUpdate; why: 'not-found' | 'non-utf8' | 'lock-timeout' }[],
): string {
  const hints: Record<(typeof unresolved)[number]['why'], string> = {
    'not-found': '编号在布线/大纲中查无此线（线索可能已被删除，或编号有误）——修正编号或恢复线索文件后，下次定稿本章会自动重试回写',
    'non-utf8': '线索文件不是 UTF-8 编码（如 GBK），回写会损坏原文已拒绝——转码为 UTF-8 后，下次定稿本章会自动重试回写',
    'lock-timeout': '布线文件回写锁等待超时（另一进程正在写入该线索），为防覆盖未回写——下次定稿本章会自动重试回写',
  }
  const blocks = (['not-found', 'non-utf8', 'lock-timeout'] as const).flatMap((why) => {
    const items = unresolved.filter((x) => x.why === why)
    if (items.length === 0) return []
    return [
      `<!-- 以下 ${items.length} 条未回写：${hints[why]} -->`,
      ...items.map((x) => `- ${x.u.leadId} ${x.u.动词}：${x.u.证据}`),
      '',
    ]
  })
  return `# 第${chapterNo}章 账本推进\n\n` + blocks.join('\n')
}

/** 按 编号 在候选目录中找账本条目文件（无则 null）。 */
function findLeadFile(dirs: string[], leadId: string): { filePath: string; lead: import('../format/types.js').Lead } | null {
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const { leads } = readLeadDir(dir)
    const hit = leads.find((l) => l.编号 === leadId)
    if (hit?._path) {
      return { filePath: hit._path, lead: hit }
    }
  }
  return null
}
