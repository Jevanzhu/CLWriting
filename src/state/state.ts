/**
 * 状态机单入口 —— 依据 #15 状态机单入口 spec（子 spec·#15）+ 母本第 6.4 节。
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
 * - 脚本面为主、AI 介入点用桩：判定/路由全确定性脚本；语义判断（顺势圆/修复确认）桩真。
 * - 文件即真相：判定读 md 真源 + manifest 账本，不维护额外状态机状态文件。
 *
 * 回滚「回到第 N 章」是横切命令（#16 第 5 节），不在顺序判定里——由 version 恢复单独触发。
 *
 * 拆分沿革（⑤④产品巨件拆分波2）：本单件（1175 行）缝 A+B
 * 纯移动拆分——态 1 健康检查族 + 三组每书 TTL 节流缓存（sweep/云盘扫描/finalizedLost）
 * 及其复位与失效钩子 + 判定辅助族（detectHandEdits/detectIncompleteWorkdir/
 * isChapterFinalized/chapter* 辅助族/unfinishedPieceNames/maxFileNameChapter/
 * skipFinalizedChapters/volumeSizeOf）→ state/health.ts（缝 A）；近况复述族（#15
 * 第 4 节 StatusRecap/buildRecap/readRecapSnapshot/fallbackRecapSnapshot）→
 * state/recap.ts（缝 B）。本残核保留状态机主干：detectState/routeState/enter 与
 * 状态类型（BookState/STATE_NAMES/DetectedState）；迁出公开导出
 * __resetSweepThrottleForTest/forgetStateSweepStamp（缝 A）与 StatusRecap/buildRecap
 * （缝 B）经下方逐名 re-export 桥接，全库消费方 import 面零改动。运行时依赖单向：
 * state→health、state→recap、recap→health，无环回引——顶层求值常量（节流表/
 * HAND_EDIT_PREFIXES/DEFAULT_VOLUME_SIZE 等）一律单源 health.ts，绝不经环回引
 * （count 拆分 HANZI 单源先例同款纪律）。本头注上方原文全部历史记载原样保留。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { rebuild } from '../cache/rebuild.js'
import { runRebuildAsync } from '../cache/run-rebuild-async.js'
import { readBookConfig } from '../format/yaml.js'
import { assembleStatus } from '../process/assemble.js'
import { readChapterDir } from '../format/chapters.js'
import {
  readManifest,
  finalizedChapterNumbers,
  finalizedChapterSetOfBook,
  type Manifest,
} from '../document/manifest.js'
import type { BookConfig, ParseError } from '../format/types.js'
import { log, errMsg } from '../log/index.js'
import {
  healthCheck,
  detectHandEdits,
  detectIncompleteWorkdir,
  isChapterFinalized,
  unfinishedPieceNames,
  maxFileNameChapter,
  skipFinalizedChapters,
  volumeSizeOf,
  type HealthIssue,
} from './health.js'
import { buildRecap, type StatusRecap } from './recap.js'

// 拆分桥接：迁出公开导出逐名 re-export，全库 import 面零改动。
// 缝 A（state/health.ts）：三组节流缓存的复位与失效钩子。
export { __resetSweepThrottleForTest, forgetStateSweepStamp } from './health.js'
// 缝 B（state/recap.ts）：近况复述族（#15 第 4 节）。
export { buildRecap } from './recap.js'
export type { StatusRecap } from './recap.js'

/** 状态枚举（#15 第 2 节顺序）+ 态 5 卷末；CLI 退场无态 6/8（#34 未接入主流程） */
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
interface RouterAction {
  state: BookState
  /** 人话（对作者：现在该干什么，零机器味） */
  humanMsg: string
  /** 动作类型（机器侧：状态机/#16#17#18/M2 流程谁来接） */
  action?: RouterActionKind
  /** 是否需要 AI 介入（桩真） */
  needsAI: boolean
}

type RouterActionKind =
  | 'repair' // 态 2 → #18 修复确认
  | 'resume' // 态 4 → 中断恢复续跑
  | 'volume-review' // 态 5 → 卷复盘（概要）
  | 'write-new-chapter' // 态 7 →AI 写章流程

/**
 * 进门状态判定（#15 第 2 节，按序命中即返回）。
 * 全程零 AI：健康检查 / 全量重建收错 / 指纹比对 / 工作区文件 / 章号推算，全是确定性脚本。
 * 异步化——healthCheck → healMovePending 的崩溃自愈链含清单锁与 journal 锁
 * 等待，服务进程 HTTP 路径（/api/state、/api/overview）在此前同步版（Atomics.wait）
 * 下可冻结事件循环最坏 ≈12s；全部锁等待改异步孪生（withManifestLockAsync +
 * appendSettled/appendAborted），锁内临界段保持同步 FS。
 * opts.rebuildChannel——'worker' 把布线书的全量 rebuild 卸到
 * worker 线程（runRebuildAsync，process/summary.ts 先例同款接线），服务进程
 * 只等消息；缺省 'sync' 进程内同步（CLI enter/库形态/既有测试零变更）。结果结构
 * 同构（RebuildResult），异常路径共用下方既有 catch → 降级态 2 报文语义。
 */
interface DetectStateOptions {
  /** rebuild 执行通道：'sync'（缺省，进程内同步）/ 'worker'（worker 线程，
   *  HTTP 消费点 /api/state、/api/overview 专用——大书 index.db 缺失/损坏首进门
   *  全量重建 readChapter×N 秒级冻结 utilityProcess 事件循环）。 */
  rebuildChannel?: 'sync' | 'worker'
}

export async function detectState(
  bookRoot: string,
  config: BookConfig,
  manifest?: Manifest,
  opts?: DetectStateOptions,
): Promise<DetectedState> {
  // 入口读一次 manifest，传入各子函数（单次 detectState 调用链原先读盘 4 次；enter() 传入复用避免双读）
  const m = manifest ?? readManifest(join(bookRoot, '项目', '文档清单.jsonl'))

  // #1 健康检查（journal 崩溃恢复 + 网盘副本扫描）
  const issues = await healthCheck(bookRoot, m)
  if (issues.length > 0) {
    return { state: 1, issues }
  }

  // 全量重建一次（#2#3 都要用它的结果；幂等，删了能建回）
  // 无布线（短篇）跳过 rebuild：无布线书不依赖 index.db 长程账本（态7 分支直接扫 写作/正文/ 目录），
  // rebuild 扫的是长篇结构（布线/账本 + 写作/正文），对无布线书是纯浪费；态2 解析错误检测对此类书无意义（真相源是 写作/正文/）。
  const cachePath = join(bookRoot, '.cache', 'index.db')
  let rebuildResult: {
    leadCount: number
    chapterCount: number
    summaryCount: number
    errors: ParseError[]
    warnings?: ParseError[] // 报告级桶（book.yaml 降级/摘要命名）——不驱动本文件 state 2 硬闸
  }
  if (!existsSync(join(bookRoot, '布线'))) {
    rebuildResult = { leadCount: 0, chapterCount: 0, summaryCount: 0, errors: [], warnings: [] }
  } else {
    // rebuild 仅在 db 层故障(磁盘满/权限/损坏)抛异常;catch 后降级态2,不崩整个 enter
    try {
      // 通道分流——缺省 'sync' 直调进程内 rebuild（既有行为）；
      // 'worker' 走卸载层（同步内核原样搬线程，结果经 postMessage 回传，
      // 结构同 RebuildResult；worker 超时 120s/崩溃/异常退出均 reject → 共用下方
      // 既有 catch 降级态 2 报文，语义收敛不变）
      rebuildResult =
        opts?.rebuildChannel === 'worker'
          ? await runRebuildAsync({ bookRoot, cachePath })
          : rebuild(bookRoot, cachePath)
    } catch (e) {
      const msg = errMsg(e)
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
    const alreadyFinalized = isChapterFinalized(incomplete, m)
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
    // fm 解析失败的草稿不进 readChapterDir 的 chapters，但其文件名章号仍占位——
    // nextChapter 必须以正文区最大文件名章号为下限。否则「3 章已定稿 + 坏 fm 的 004 草稿」
    // 会算出 nextChapter=3，resolveDraftPath 覆盖写已定稿第 3 章。
    const formula = readChapterDir(bodyDir).chapters.length - excludeNames.size + 1
    // 跳过已定稿篇号——短篇集删除/回收造成编号断档（定稿剩 1、2、5）时
    // max(formula, maxFileName)=5 会回指已定稿第 5 篇，resolveDraftPath 的防覆盖闸
    // fail-loud 抛错卡死写作流。跳过 5 → 6，篇号永不复用。
    return {
      state: 7,
      nextChapter: skipFinalizedChapters(Math.max(formula, maxFileNameChapter(bodyDir)), finalizedChapterNumbers(m)),
    }
  }

  // 读缓存算 currentChapter（5/6/7 都要）
  const volumeSize = volumeSizeOf(config)
  // db 打开/统计与 rebuild 同层故障面（磁盘满/权限/损坏）——原先此处无兜底，
  // db 层异常直接从 detectState 抛出崩掉整个 enter（同文件 readRecapSnapshot 有 catch 降级，行为不一致）
  let snapshot
  try {
    const db = new DatabaseSync(cachePath)
    try {
      // 低级项：currentChapter 只数定稿章（缓存 chapters 表含写作中的草稿）；
      // 无清单 → undefined（全量口径），清单在册零定稿 → 空集（=0）
      snapshot = assembleStatus(db, config, volumeSize, finalizedChapterSetOfBook(bookRoot))
    } finally {
      db.close()
    }
  } catch (e) {
    const msg = errMsg(e)
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

  // #7 起草新章（兜底）。长轨同样跳过已定稿章号（外部删章/断档场景防回指定稿）。
  return { state: 7, nextChapter: skipFinalizedChapters(currentChapter + 1, finalizedChapterNumbers(m)) }
}

/**
 * 路由（#15 第 2 节，各态路由去向 + 人话）。
 * AI 介入处（修复确认语义、顺势圆）标 needsAI=true 出人话不真执行。
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
        needsAI: true, // 语义修复
      }
    }
    case 3: {
      const list = detected.handEdits.map((f) => `· ${f}`).join('\n')
      return {
        state: 3,
        humanMsg: `你直接改了下面这些文件，需要同步一下：\n${list}`,
        needsAI: true, // 补登内容判断
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
        needsAI: false, // 续跑判定脚本，真编排
      }
    }
    case 5:
      return {
        state: 5,
        humanMsg: `第 ${detected.volume} 卷写完了，建议做卷复盘（节奏/线收束/伏笔回收）再开下一卷。`,
        action: 'volume-review',
        needsAI: true, // 卷复盘深度
      }
    case 7: {
      // CLI 退场后写章收敛为单一入口（全自动/编辑器），不再分「手写起草」动作
      return {
        state: 7,
        humanMsg: `一切就绪，开始写第 ${detected.nextChapter} 章。`,
        action: 'write-new-chapter',
        needsAI: false, // AI 写稿由壳调
      }
    }
  }
  throw new Error(`未知状态：${JSON.stringify(detected)}`)
}

// ── 单入口：enter（#15 第 3 节，CLI + 库双形态）────────

/** enter 结果（库形态：结构化数据，前端自行渲染） */
interface EnterResult {
  recap: StatusRecap
  detected: DetectedState
  route: RouterAction
  /** 长短篇（正文单位统一为「章」） */
  kind: 'long' | 'short'
}

/**
 * 进门入口（#15 第 3 节）。
 * 串：判态 → 路由 → 近况复述。无 hook 等价入口（SessionStart 真 hook 接同一结构化结果）。
 * 随 detectState 异步化（enter 调用方需 await）。
 */
export async function enter(bookRoot: string): Promise<EnterResult> {
  const cfgPath = join(bookRoot, 'book.yaml')
  const cfgResult = readBookConfig(cfgPath)
  // book.yaml 损坏时静默降级到默认配置——至少留下诊断痕迹
  if (!cfgResult.ok) {
    log.warn('state', `book.yaml 解析降级: ${cfgResult.error.message}`)
  }
  const { config } = cfgResult
  // manifest 只读一次，detectState + buildRecap 复用（原先同一调用链读两次）
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  const detected = await detectState(bookRoot, config, manifest)
  const route = routeState(detected)
  const recap = buildRecap(bookRoot, config, detected, manifest)
  return { recap, detected, route, kind: config.kind ?? 'long' }
}
