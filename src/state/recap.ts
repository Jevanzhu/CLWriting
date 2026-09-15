/**
 * 近况复述族（#15 第 4 节）—— 自 src/state/state.ts 缝 B 拆出。
 *
 * R0916-5f（2026-09-16，⑤④产品巨件拆分波2）：state.ts（1175 行）缝 A+B 纯移动拆分。
 * 本文件承载缝 B：StatusRecap/buildRecap/readRecapSnapshot/fallbackRecapSnapshot。
 * StatusRecap/buildRecap 原即 state.ts 公开导出——经 state.ts 逐名 re-export 桥接，
 * 全库消费方 import 面零改动；readRecapSnapshot/fallbackRecapSnapshot 今日私有照旧。
 * 依赖方向单向（无环回引）：本文件 → health.js（判定辅助族 skipFinalizedChapters/
 * unfinishedPieceNames/maxFileNameChapter/volumeSizeOf/DEFAULT_VOLUME_SIZE 自彼单源
 * import，顶层求值常量不环回——R0916-5e count 拆分 HANZI 单源先例同款纪律）；
 * BookState/DetectedState 为 type-only import，编译期擦除，不构成运行时回边。
 * 注释全部原样随迁；行为、断言、测试零改动。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assembleStatus } from '../process/assemble.js'
import { readChapterDir } from '../format/chapters.js'
import { readManifest, finalizedChapterNumbers, finalizedChapterSetOfBook, type Manifest } from '../document/manifest.js'
import { readBatchPause } from './batch-pause.js'
import type { BookConfig } from '../format/types.js'
import type { BookState, DetectedState } from './state.js'
import { skipFinalizedChapters, unfinishedPieceNames, maxFileNameChapter, volumeSizeOf, DEFAULT_VOLUME_SIZE } from './health.js'

/** 读 .auto-batch.json 的 paused 字段（M6 #34 暂停元状态）——实现移 batch-pause.ts（写侧 self-heal 共用）。 */

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
    // R38-15（三十八轮）同族：close 包 try/catch——finally 内 close 抛错会顶替 catch
    // 的降级返回值直接上抛（node:sqlite close 极少抛错，防御级）。
    try {
      db?.close()
    } catch {
      /* 句柄由进程退出兜底回收 */
    }
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
