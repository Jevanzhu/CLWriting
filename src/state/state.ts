/**
 * 状态机单入口 —— 依据 #15 状态机单入口 spec（M3 子 spec·#15）+ 母本第 6.4 节。
 *
 * 每次进书按序判定、命中即路由（#15 第 2 节）：
 * 1 健康检查 → 2 源文件解析失败 → 3 未入账手改 → 4 工作区未完成
 * → 5 卷末 → 7 起草新章
 * （态位收窄：体检周期态 6、批量审稿态 8 已从 BookState 移除——现为 1|2|3|4|5|7，不再拦写章。）
 *
 * 去 git 自管版本系统（Dev/Main/Plans/gitless-version-system.md）：
 * - 态 1 健康检查：journal 崩溃恢复 + 网盘副本扫描（不再依赖 git 半提交/冲突/锁）
 * - 态 3 未入账手改：manifest.finalizedRevision vs 文件实时指纹比对（不再依赖 git modified）
 * - 态 4 工作区未完成：工作区信号 + manifest 定稿检测（不再依赖 git log 反查 commit）
 *
 * 设计（#15 第 1 节原则）：
 * - 单入口、按序判定：前一个命中就路由，不再判后面的（体检优先于续跑、续跑优先于周期）。
 * - 进门先体检、自愈不门禁：态 1-3 异常先提议修复，不报错拒绝、不崩整个系统。
 * - 脚本面为主、AI 介入点用桩：判定/路由全确定性脚本；语义判断（顺势圆/修复确认）M3 桩、M4 真。
 * - 文件即真相：判定读 md 真源 + manifest 账本，不维护额外状态机状态文件。
 *
 * 回滚「回到第 N 章」是横切命令（#16 第 5 节），不在顺序判定里——由 version 恢复单独触发。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { scanCloudCopies } from '../git/exec.js'
import { sweepAbandonedTmpFiles } from '../fs/atomic.js'
import { appendAborted, appendSettled, findUnsettled, isMovePending, type JournalAnyPending, type JournalMovePending } from '../document/journal.js'
import { rebuild } from '../cache/rebuild.js'
import { readBookConfig } from '../format/yaml.js'
import { splitFrontMatter, parseFlat } from '../format/frontmatter.js'
import { assembleStatus } from '../process/assemble.js'
import { readChapterDir } from '../format/chapters.js'
import { parseChapterFileName } from '../format/words.js'
import { readManifest, writeManifest, finalizedChapterNumbers, finalizedChapterSetOfBook, withManifestLock, type Manifest } from '../document/manifest.js'
import { computeRevision } from '../document/revision.js'
import { probeCachedRevision } from '../document/tree.js'
import { safeManifestPath } from '../fs/safe-path.js'
import { walkMdEach } from '../fs/walk-md.js'
import { readBatchPause } from './batch-pause.js'
import type { BookConfig, ParseError } from '../format/types.js'
import { log } from '../log/index.js'

/** 默认每卷章数；book.yaml 可用 book.volume_size 覆盖。 */
const DEFAULT_VOLUME_SIZE = 50

function volumeSizeOf(config: BookConfig): number {
  const size = config.book.volume_size
  return typeof size === 'number' && Number.isSafeInteger(size) && size > 0 ? size : DEFAULT_VOLUME_SIZE
}

/** 状态枚举（#15 第 2 节顺序）+ 态 5 卷末；CLI 退场无态 6/8（M6 #34 未接入主流程） */
export type BookState = 1 | 2 | 3 | 4 | 5 | 7

/** 态名（人话，#15 第 2 节表） */
export const STATE_NAMES: Record<BookState, string> = {
  1: '健康检查',
  2: '源文件解析失败',
  3: '未入账手改',
  4: '工作区未完成',
  5: '卷末',
  7: '起草新章',
}

/**
 * 判定结果（判别联合，自带 state 字段供 switch 收窄）。
 * 各态细节人话 + 结构化，路由据此决定动作。
 */
export type DetectedState =
  | { state: 1; issues: HealthIssue[] }
  | { state: 2; parseErrors: import('../format/types.js').ParseError[] }
  | { state: 3; handEdits: string[] } // 定稿基线后有改动但未重新定稿的文件
  | { state: 4; chapterNum: number; resumePoint: 'pre-finalize' | 'post-finalize-residue' } // 中断点
  | { state: 5; volume: number } // 第几卷写完了
  | { state: 7; nextChapter: number }

/** 路由动作（#15 第 2 节，各态路由去向；AI 执行处出桩标记） */
export interface RouterAction {
  state: BookState
  /** 人话（对作者：现在该干什么，零机器味） */
  humanMsg: string
  /** 动作类型（机器侧：状态机/#16#17#18/M2 流程谁来接） */
  action?: RouterActionKind
  /** 是否需要 AI 介入（M3 桩、M4 真） */
  needsAI: boolean
}

export type RouterActionKind =
  | 'repair' // 态 2 → #18 修复确认
  | 'resume' // 态 4 → 中断恢复续跑
  | 'volume-review' // 态 5 → 卷复盘（M3 概要）
  | 'write-new-chapter' // 态 7 → M2 AI 写章流程

/**
 * 进门状态判定（#15 第 2 节，按序命中即返回）。
 * 全程零 AI：健康检查 / 全量重建收错 / 指纹比对 / 工作区文件 / 章号推算，全是确定性脚本。
 */
export function detectState(bookRoot: string, config: BookConfig, manifest?: Manifest): DetectedState {
  // 入口读一次 manifest，传入各子函数（单次 detectState 调用链原先读盘 4 次；enter() 传入复用避免双读，P2-BE-4）
  const m = manifest ?? readManifest(join(bookRoot, '项目', '文档清单.jsonl'))

  // #1 健康检查（journal 崩溃恢复 + 网盘副本扫描）
  const issues = healthCheck(bookRoot, m)
  if (issues.length > 0) {
    return { state: 1, issues }
  }

  // 全量重建一次（#2#3 都要用它的结果；幂等，删了能建回）
  // 无布线（短篇）跳过 rebuild：无布线书不依赖 index.db 长程账本（态7 分支直接扫 写作/正文/ 目录），
  // rebuild 扫的是长篇结构（布线/账本 + 写作/正文），对无布线书是纯浪费；态2 解析错误检测对此类书无意义（真相源是 写作/正文/）。
  const cachePath = join(bookRoot, '.cache', 'index.db')
  let rebuildResult: { leadCount: number; chapterCount: number; summaryCount: number; errors: ParseError[] }
  if (!existsSync(join(bookRoot, '布线'))) {
    rebuildResult = { leadCount: 0, chapterCount: 0, summaryCount: 0, errors: [] }
  } else {
    // rebuild 仅在 db 层故障(磁盘满/权限/损坏)抛异常;catch 后降级态2,不崩整个 enter
    try {
      rebuildResult = rebuild(bookRoot, cachePath)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        state: 2,
        parseErrors: [{ file: cachePath, line: 0, message: `缓存重建失败：${msg}（可删 .cache/index.db 重试）` }],
      }
    }
  }

  // #2 源文件解析失败（#18 第 2 节）
  if (rebuildResult.errors.length > 0) {
    return { state: 2, parseErrors: rebuildResult.errors }
  }

  // #3 未入账手改：定稿基线存在但当前指纹不同（manifest 指纹比对，不依赖 git）
  const handEdits = detectHandEdits(bookRoot, m)
  if (handEdits.length > 0) {
    return { state: 3, handEdits }
  }

  // #4 工作区未完成（中断恢复）：有细纲/未定稿草稿 但对应章节已定稿 → post-finalize-residue
  const incomplete = detectIncompleteWorkdir(bookRoot, m)
  if (incomplete) {
    const alreadyFinalized = isChapterFinalized(bookRoot, incomplete, m)
    return {
      state: 4,
      chapterNum: incomplete,
      resumePoint: alreadyFinalized ? 'post-finalize-residue' : 'pre-finalize',
    }
  }

  // ── 态 4 之后按布线存在性分叉（无布线的短篇书：无态 5（无卷）/6（无体检）；直接落态 7 写作主态）──
  if (!existsSync(join(bookRoot, '布线'))) {
    const excludeNames = unfinishedPieceNames(bookRoot, m)
    const bodyDir = join(bookRoot, '写作', '正文')
    // V-P1-3：fm 解析失败的草稿不进 readChapterDir 的 chapters，但其文件名章号仍占位——
    // nextChapter 必须以正文区最大文件名章号为下限。否则「3 章已定稿 + 坏 fm 的 004 草稿」
    // 会算出 nextChapter=3，resolveDraftPath 覆盖写已定稿第 3 章。
    const formula = readChapterDir(bodyDir).chapters.length - excludeNames.size + 1
    // CC-P1-6：跳过已定稿篇号——短篇集删除/回收造成编号断档（定稿剩 1、2、5）时
    // max(formula, maxFileName)=5 会回指已定稿第 5 篇，resolveDraftPath 的防覆盖闸
    // （V-P2-2/W-P2-2）fail-loud 抛错卡死写作流。跳过 5 → 6，篇号永不复用。
    return {
      state: 7,
      nextChapter: skipFinalizedChapters(Math.max(formula, maxFileNameChapter(bodyDir)), finalizedChapterNumbers(m)),
    }
  }

  // 读缓存算 currentChapter（5/6/7 都要）
  const volumeSize = volumeSizeOf(config)
  // RB-KN-P2-1：db 打开/统计与 rebuild 同层故障面（磁盘满/权限/损坏）——原先此处无兜底，
  // db 层异常直接从 detectState 抛出崩掉整个 enter（同文件 readRecapSnapshot 有 catch 降级，行为不一致）
  let snapshot
  try {
    const db = new DatabaseSync(cachePath)
    try {
      // 低级项（第六轮）：currentChapter 只数定稿章（缓存 chapters 表含写作中的草稿）；
      // PL-2（第七轮）：无清单 → undefined（全量口径），清单在册零定稿 → 空集（=0）
      snapshot = assembleStatus(db, config, volumeSize, finalizedChapterSetOfBook(bookRoot))
    } finally {
      db.close()
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      state: 2,
      parseErrors: [{ file: cachePath, line: 0, message: `缓存读取失败：${msg}（可删 .cache/index.db 重试）` }],
    }
  }
  const currentChapter = snapshot.currentChapter

  // #5 卷末（currentChapter > 0 且整除卷大小）
  if (currentChapter > 0 && currentChapter % volumeSize === 0) {
    return { state: 5, volume: currentChapter / volumeSize }
  }

  // #6 体检周期：CLI 退场后移除（态 6 不再拦截写章），直接落态 7。

  // #7 起草新章（兜底）。CC-P1-6：长轨同样跳过已定稿章号（外部删章/断档场景防回指定稿）。
  return { state: 7, nextChapter: skipFinalizedChapters(currentChapter + 1, finalizedChapterNumbers(m)) }
}

/** 健康检查异常项（去 git：journal 崩溃恢复 + 网盘副本扫描 + 定稿文件丢失）。 */
export interface HealthIssue {
  kind: 'crashedWrite' | 'cloudCopy' | 'finalizedLost'
  humanMsg: string
  fix: string
  files?: string[]
}

/** 态 1：journal 崩溃恢复 + 网盘副本扫描（不再依赖 git 半提交/冲突/锁——无 git 即无此类异常）。 */
function healthCheck(bookRoot: string, manifest: Manifest): HealthIssue[] {
  const issues: HealthIssue[] = []

  // ① journal 崩溃恢复：扫 工作区/.journal/*.jsonl，找 pending 未 settled 的写操作。
  // P3-10：move 类 pending（rename 与清单更新之间的崩溃窗口）确定性自愈——内容不变
  // 仅路径变，按磁盘现状收口清单，不惊动作者；save 类才可能丢字，仍走作者提示。
  const journalDir = join(bookRoot, '工作区', '.journal')
  if (existsSync(journalDir)) {
    try {
      for (const name of readdirSync(journalDir)) {
        if (name.startsWith('._') || !name.endsWith('.jsonl')) continue
        const docId = name.slice(0, -'.jsonl'.length)
        const pending = findUnsettled(join(journalDir, name))
        const unresolved: JournalAnyPending[] = []
        for (const p of pending) {
          if (!isMovePending(p) || !healMovePending(bookRoot, docId, p)) unresolved.push(p)
        }
        if (unresolved.length > 0) {
          issues.push({
            kind: 'crashedWrite',
            humanMsg: `上次写作时「${docId}」的保存没完成，可能丢字。`,
            fix: '确认内容是否完整，可从版本历史恢复，或忽略继续写作。',
            files: unresolved.map((p) => p.opId),
          })
        }
      }
    } catch {
      // journal 扫描异常不阻断进门（降级为无 journal 检查）
    }
  }

  // ③ N5（五十九轮）：已定稿文件丢失——清单在册有 finalizedRevision 的正文/设定/
  // 大纲/布线文档文件不在盘（被外部删除/移走），detectHandEdits 的 rev===null 分支
  // 原先静默跳过，无任何健康出口（静默丢章：章号推算只看盘上文件，缺章无感知）。
  // 归入态 1 issues 交作者裁决（恢复来源：版本档案/回收站/同步盘备份）。
  for (const entry of manifest.entries.values()) {
    if (entry.nodeType !== 'document' || !entry.finalizedRevision) continue
    if (!HAND_EDIT_PREFIXES.some((p) => entry.path.startsWith(p))) continue
    const abs = safeManifestPath(bookRoot, entry.path)
    if (abs === null || !existsSync(abs)) {
      issues.push({
        kind: 'finalizedLost',
        humanMsg: `已定稿文件「${entry.path}」不在盘上（可能被外部删除或移走）。`,
        fix: '从版本历史（工作区/.版本）或备份找回该文件；确认不需要可重新定稿覆盖基线。',
        files: [entry.path],
      })
    }
  }

  // ② 网盘副本扫描（纯 fs，不依赖 git）
  const cloudCopies = scanCloudCopies(bookRoot)
  // Y-24（第五十七轮）：顺手清扫 atomicWriteFile 崩溃残留 tmp（`.name.pid.uuid.tmp`，
  // 5 分钟年龄门槛防误删他进程在途写）——不产 issue，纯卫生，留痕即可
  const sweptTmp = sweepAbandonedTmpFiles(bookRoot)
  if (sweptTmp > 0) {
    log.info('state', `已清扫 ${sweptTmp} 个崩溃残留的临时文件（atomicWrite 半途崩溃遗留）`)
  }
  if (cloudCopies.length > 0) {
    issues.push({
      kind: 'cloudCopy',
      humanMsg: '检测到同步盘副本残留，可能有双写冲突。',
      fix: '对比副本和原文件，确认哪份是真内容后删掉多余的；警示同步盘风险（建议关掉书仓库的同步盘）。',
      files: cloudCopies,
    })
  }

  return issues
}

/**
 * P3-10：move 类 pending 确定性收口。返回 true = 已处理（不报 issue）。
 * - 新路径在、旧路径不在 → rename 已发生、清单未跟上 → 补清单 + settled（幂等：清单已对齐时只补 settled）
 * - 旧路径在、新路径不在 → rename 未发生 → 悬置 pending 标 aborted（无实际效果待恢复）
 * - 两端都在 / 都不在 / 路径越出书仓库 → 不可自动判定，返回 false 交作者
 */
function healMovePending(bookRoot: string, docId: string, p: JournalMovePending): boolean {
  const oldAbs = safeManifestPath(bookRoot, p.oldPath)
  const newAbs = safeManifestPath(bookRoot, p.newPath)
  if (!oldAbs || !newAbs) return false
  const oldExists = existsSync(oldAbs)
  const newExists = existsSync(newAbs)
  try {
    if (newExists && !oldExists) {
      const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
      if (existsSync(manifestPath)) {
        // Y-4（第五十七轮）：RMW 持清单锁（X-5 单源漏网点）——悬置 pending 自愈与
        // 他进程清单写（CLI batch-finalize / GUI 保存）并发时，裸 read→write 会用
        // 陈旧镜像整文件重写吞掉刚落的 finalizedRevision（定稿防线失守）
        withManifestLock(manifestPath, () => {
          const m = readManifest(manifestPath)
          const entry = m.entries.get(docId)
          if (entry && entry.path !== p.newPath) {
            entry.path = p.newPath
            writeManifest(manifestPath, m)
          }
        })
      }
      appendSettled(join(journalDir(bookRoot), `${docId}.jsonl`), p.opId, computeRevision(newAbs))
      return true
    }
    if (oldExists && !newExists) {
      appendAborted(join(journalDir(bookRoot), `${docId}.jsonl`), p.opId, '恢复扫描判定：rename 未发生，清除悬置 pending')
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

/** 态 3：已定稿文件有未重新定稿的改动（manifest.finalizedRevision vs 当前指纹）。 */
/** 态 1（N5）与态 3 共用的「参与指纹比对」前缀——正文/设定/大纲/布线。 */
const HAND_EDIT_PREFIXES = ['写作/正文/', '设定/', '大纲/', '布线/']

function detectHandEdits(bookRoot: string, manifest: Manifest): string[] {
  const handEditPrefixes = HAND_EDIT_PREFIXES
  const out: string[] = []
  for (const entry of manifest.entries.values()) {
    if (entry.nodeType !== 'document') continue
    if (!entry.finalizedRevision) continue // 从未定稿 → 不是手改（是正常草稿流程）
    if (!handEditPrefixes.some((p) => entry.path.startsWith(p))) continue
    // ff P2-3：走 probeCachedRevision（mtime+size 命中免整读+哈希）——enter() 每次进门
    // 对全部定稿文档全量读盘是大书同步阻塞点；null 兼「文件不存在」跳过语义，
    // 与 check/run.ts 树红点聚合（CC-P1-3）同缓存同口径，随 invalidateTreeIndex 失效。
    const rev = probeCachedRevision(bookRoot, entry.path)
    // N5（五十九轮）：文件不在盘的 rev===null 不在此处吞——healthCheck 的
    // finalizedLost issue 已把「已定稿文件丢失」归入态 1（先于态 3 判定）
    if (rev === null) continue
    if (rev !== entry.finalizedRevision) out.push(entry.path)
  }
  return out
}

/** 态 4：工作区/正文区是否有未完成章节（中断判定）。
 *  信号：工作区细纲.md / .confirm.json，或正文区存在未定稿（无 finalizedRevision）的草稿文件。 */
function detectIncompleteWorkdir(bookRoot: string, manifest: Manifest): number | null {
  const workDir = join(bookRoot, '工作区')
  const hasOutline = existsSync(join(workDir, '细纲.md'))
  const hasConfirm = existsSync(join(workDir, '.confirm.json'))
  const unfinishedChapter = findUnfinishedChapter(bookRoot, manifest)
  if (!hasOutline && !hasConfirm && !unfinishedChapter) return null

  let chapterNum = 0
  // 章号源优先：.confirm.json.chapter（写作中断时确认过细纲）> 正文区未定稿草稿
  if (hasConfirm) {
    try {
      const rec = JSON.parse(readFileSync(join(workDir, '.confirm.json'), 'utf-8')) as { chapter?: number }
      chapterNum = rec.chapter ?? 0
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
    finalizedStems.add(e.path)
  }
  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) return null
  // N2（五十九轮）：裸 statSync（跟随 symlink）+ 无 visited 递归改走 walk-md 共享
  // 口径（Dirent 不跟随 symlink + realpath 剪枝 + 根界）——循环 symlink 不再进门崩。
  let found: number | null = null
  walkMdEach(bodyDir, (fp, name) => {
    if (found !== null) return
    const rel = relativePath(bookRoot, fp)
    if (finalizedStems.has(rel)) return // 已定稿，不算未完成
    const no = chapterFromFile(fp, name)
    if (no > 0) found = no
  })
  return found
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
  // 标题中段的数字（如「第2卷-001-雨夜.md」取 2），章号错位（X-P3a）
  const m = name.match(/^0*(\d+)/)
  return m ? Number(m[1]) : 0
}

function relativePath(bookRoot: string, absPath: string): string {
  return relative(bookRoot, absPath).replace(/\\/g, '/')
}

/** 章节是否已定稿：manifest 中该章 entry 有 finalizedRevision。 */
function isChapterFinalized(_bookRoot: string, chapterNum: number, manifest: Manifest): boolean {
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
  // R64-20（十二轮）：与 parseChapterFileName 同款 isSafeInteger 守卫——超精度
  // 数字章号按 0（无章号）处理，不入状态机
  const no = Number(m[1])
  return Number.isSafeInteger(no) ? no : 0
}

/** 正文区未定稿文件名集合（用于排除草稿——未定稿不计入"已写"）。 */
function unfinishedPieceNames(bookRoot: string, manifest: Manifest): Set<string> {
  const finalized = new Set<string>()
  for (const e of manifest.entries.values()) {
    if (e.nodeType === 'document' && e.finalizedRevision) finalized.add(e.path)
  }
  const out = new Set<string>()
  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) return out
  // N2（五十九轮）：同 findUnfinishedChapter——改走 walk-md 共享口径
  walkMdEach(bodyDir, (fp, name) => {
    if (!/^\d+-/.test(name)) return
    const rel = relativePath(bookRoot, fp)
    if (!finalized.has(rel)) out.add(rel.slice('写作/正文/'.length))
  })
  return out
}

// 已定稿章数 = readChapterDir 章数 − 未定稿文件数（排除草稿后再计"已写"，见态 7 分支与 readRecapSnapshot）

/** 正文区文件名里的最大章号（含 fm 解析失败的文件；无匹配 → 0）。V-P1-3：nextChapter 下限。 */
function maxFileNameChapter(bodyDir: string): number {
  if (!existsSync(bodyDir)) return 0
  let max = 0
  // N2（五十九轮）：同 findUnfinishedChapter——改走 walk-md 共享口径
  walkMdEach(bodyDir, (_fp, name) => {
    const parsed = parseChapterFileName(name)
    if (parsed && parsed.章号 > max) max = parsed.章号
  })
  return max
}

/** CC-P1-6：n 起步跳过一切已定稿章号（「篇号永不复用」语义；连续定稿时 n+1 即空闲，零开销）。 */
function skipFinalizedChapters(n: number, finalized: Set<number>): number {
  let next = n
  while (finalized.has(next)) next++
  return next
}

/** 读 .auto-batch.json 的 paused 字段（M6 #34 暂停元状态）——实现移 batch-pause.ts（写侧 self-heal 共用）。 */

/**
 * 路由（#15 第 2 节，各态路由去向 + 人话）。
 * AI 介入处（修复确认语义、顺势圆）标 needsAI=true，M3 出人话不真执行。
 */
export function routeState(detected: DetectedState): RouterAction {
  switch (detected.state) {
    case 1: {
      const list = detected.issues.map((i) => `· ${i.humanMsg}（${i.fix}）`).join('\n')
      return {
        state: 1,
        humanMsg: `进门体检发现问题，先处理再开写：\n${list}`,
        needsAI: false,
      }
    }
    case 2: {
      const list = detected.parseErrors
        .map((e) => `· ${e.file}${e.line > 0 ? ` 第${e.line}行` : ''}：${e.message}`)
        .join('\n')
      return {
        state: 2,
        humanMsg: `有源文件坏了，需要修复确认：\n${list}`,
        action: 'repair',
        needsAI: true, // 语义修复 M4
      }
    }
    case 3: {
      const list = detected.handEdits.map((f) => `· ${f}`).join('\n')
      return {
        state: 3,
        humanMsg: `你直接改了下面这些文件，需要同步一下：\n${list}`,
        needsAI: true, // 补登内容判断 M4
      }
    }
    case 4: {
      // 中断点：pre-finalize = 续写（草稿还在没定稿）；post-finalize-residue = 定稿了但工作区没收尾（幂等清理）
      // 短篇/长篇统一用「章」作为正文单位
      const msg =
        detected.resumePoint === 'pre-finalize'
          ? `第 ${detected.chapterNum} 章写到一半（工作区有草稿/细纲没定稿），接着干——从断点续写到定稿。`
          : `第 ${detected.chapterNum} 章其实已定稿，但草稿区没收尾（草稿/细纲残留），清理一下就好。`
      return {
        state: 4,
        humanMsg: msg,
        action: 'resume',
        needsAI: false, // 续跑判定脚本，真编排 M4
      }
    }
    case 5:
      return {
        state: 5,
        humanMsg: `第 ${detected.volume} 卷写完了，建议做卷复盘（节奏/线收束/伏笔回收）再开下一卷。`,
        action: 'volume-review',
        needsAI: true, // 卷复盘深度 M4
      }
    case 7: {
      // CLI 退场后写章收敛为单一入口（全自动/编辑器），不再分「手写起草」动作
      return {
        state: 7,
        humanMsg: `一切就绪，开始写第 ${detected.nextChapter} 章。`,
        action: 'write-new-chapter',
        needsAI: false, // M2 AI 写稿由 M4 壳调
      }
    }
  }
  throw new Error(`未知状态：${JSON.stringify(detected)}`)
}

// ── 近况复述（#15 第 4 节）──────────────────────────────

/** 近况复述结果（#15 第 4 节） */
export interface StatusRecap {
  /** 已定稿到第几章 */
  currentChapter: number
  /** 当前卷 */
  currentVolume: number
  /** 下一章号 */
  nextChapter: number
  /** 健康是否干净（态 1 为 false） */
  gitClean: boolean
  /** 有无解析错误 */
  parseErrors: boolean
  /** 有无未入账手改 */
  handEdits: boolean
  /** 当前态 */
  state: BookState
  /** 连写暂停元状态（M6 #34，叠加在态 4/8 之上的批次暂停提示） */
  batchPause?: { atChapter: number; reason: string; detail: string }
}

/**
 * 组装近况复述（#15 第 4 节）。
 * 去 git：确认复述（lastConfirm）原依赖 commit trailer，已随 git 移除——定稿留痕改由版本档案（.版本）承载。
 */
export function buildRecap(bookRoot: string, config: BookConfig, detected: DetectedState, manifest?: Manifest): StatusRecap {
  // enter() 已读的 manifest 复用，避免与 detectState 双读（P2-BE-4）
  const m = manifest ?? readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  const snapshot = readRecapSnapshot(bookRoot, config, detected, m)

  // 连写暂停元状态（M6 #34）：读 .auto-batch.json paused（叠加在态 4/8 之上）
  const batchPause = readBatchPause(bookRoot)

  return {
    currentChapter: snapshot.currentChapter,
    currentVolume: snapshot.currentVolume,
    // CC-P1-6：与 detectState 同口径跳过已定稿章号（断档场景 currentChapter+1 可回指定稿，
    // 状态卡「开始写第 X 章」的提示号与 detectState 的执行号必须一致）
    nextChapter: skipFinalizedChapters(snapshot.currentChapter + 1, finalizedChapterNumbers(m)),
    gitClean: detected.state !== 1,
    parseErrors: detected.state === 2,
    handEdits: detected.state === 3,
    state: detected.state,
    ...(batchPause ? { batchPause } : {}),
  }
}

function readRecapSnapshot(
  bookRoot: string,
  config: BookConfig,
  detected: DetectedState,
  manifest: Manifest,
): Pick<StatusRecap, 'currentChapter' | 'currentVolume'> {
  // 无布线书不读缓存章统计（无长程账本缓存）；直接扫 写作/正文/ 作为已定稿章数。
  // 排除未定稿草稿（未定稿不计入"已写"章数）
  if (!existsSync(join(bookRoot, '布线'))) {
    const bodyDir = join(bookRoot, '写作', '正文')
    const { chapters } = readChapterDir(bodyDir)
    const formula = chapters.length - unfinishedPieceNames(bookRoot, manifest).size
    // RB-KN-P1-3：坏 fm 草稿占位兜底（与态 7 分支 V-P1-3 同口径）——「3 篇已定稿 +
    // 坏 fm 的 004 草稿」只按公式算出 currentChapter=2、nextChapter=3，回指已定稿第 3 篇；
    // 以文件名最大章号-1 为下限，保证 nextChapter 不低于正文区已有占位。
    return { currentChapter: Math.max(formula, maxFileNameChapter(bodyDir) - 1), currentVolume: 1 }
  }
  const cachePath = join(bookRoot, '.cache', 'index.db')
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(cachePath)
    // 低级项（第六轮）：currentChapter 只数定稿章（缓存 chapters 表含写作中的草稿）；
    // PL-2（第七轮）：无清单 → undefined（全量口径），清单在册零定稿 → 空集（=0）
    return assembleStatus(db, config, volumeSizeOf(config), finalizedChapterSetOfBook(bookRoot))
  } catch {
    return fallbackRecapSnapshot(detected, volumeSizeOf(config))
  } finally {
    db?.close()
  }
}

function fallbackRecapSnapshot(
  detected: DetectedState,
  volumeSize = DEFAULT_VOLUME_SIZE,
): Pick<StatusRecap, 'currentChapter' | 'currentVolume'> {
  if (detected.state === 5) {
    return { currentChapter: detected.volume * volumeSize, currentVolume: detected.volume }
  }
  const nextChapter = detected.state === 7 ? detected.nextChapter : 1
  return { currentChapter: Math.max(0, nextChapter - 1), currentVolume: 1 }
}

// ── 单入口：enter（#15 第 3 节，CLI + 库双形态）────────

/** enter 结果（库形态：结构化数据，前端自行渲染） */
export interface EnterResult {
  recap: StatusRecap
  detected: DetectedState
  route: RouterAction
  /** 长短篇（M8，正文单位统一为「章」） */
  kind: 'long' | 'short'
}

/**
 * 进门入口（#15 第 3 节）。
 * 串：判态 → 路由 → 近况复述。无 hook 等价入口（SessionStart 真 hook M4 接同一结构化结果）。
 */
export function enter(bookRoot: string): EnterResult {
  const cfgPath = join(bookRoot, 'book.yaml')
  const cfgResult = readBookConfig(cfgPath)
  // P3-2：book.yaml 损坏时静默降级到默认配置——至少留下诊断痕迹
  if (!cfgResult.ok) {
    log.warn('state', `book.yaml 解析降级: ${cfgResult.error.message}`)
  }
  const { config } = cfgResult
  // manifest 只读一次，detectState + buildRecap 复用（P2-BE-4：原先同一调用链读两次）
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  const detected = detectState(bookRoot, config, manifest)
  const route = routeState(detected)
  const recap = buildRecap(bookRoot, config, detected, manifest)
  return { recap, detected, route, kind: config.kind ?? 'long' }
}