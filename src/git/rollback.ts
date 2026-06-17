/**
 * 回滚「回到第 N 章」—— 依据 #16 git 隐身层 spec 第 5 节（M3 出口核心）。
 *
 * 把书状态回退到「第 N 章定稿后」。**定稿区 / .cache / 工作区三者一致**（#13 第 5 节、M3 出口验收）。
 *
 * 执行顺序（#16 第 5 节，先备份、再回退、后重建）：
 * 1. 定位：findChapterCommit(N) 按 ch:<章号> 前缀反查
 * 2. 备份再丢（可逆铁律）：N+1…M 章存备份 ref（git branch 回收/回到N-<时间戳>），可找回
 * 3. 回退定稿区：git reset --hard <第N章commit>，丢弃 N 之后的 commit
 * 4. 重建缓存：删 .cache 全量重建（#4 重建器），与回退后定稿区对齐
 * 5. 清工作区：删未完成的草稿/细纲/.confirm（工作区不在 git）
 * 6. 人话确认
 *
 * 原则（#16 第 1 节）：
 * - 回滚可逆——丢弃的内容先备份再丢，可找回（创作决策不应造成不可逆数据损失）。
 * - 不串改历史正文——reset 到旧 commit 是丢弃后续、回到旧状态，不 rebase/amend（不动原文）。
 */

import { existsSync, readdirSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { git, findChapterCommit } from './exec.js'
import { rebuild } from '../cache/rebuild.js'

/** 回滚结果 */
export type RollbackResult =
  | {
      ok: true
      /** 回退到的章号 */
      revertedTo: number
      /** 备份 ref 名（可找回丢弃的内容） */
      backupRef: string
      /** 丢弃的章数 */
      discardedChapters: number
      /** 人话确认 */
      humanMsg: string
    }
  | { ok: false; humanMsg: string }

/**
 * 回滚到第 N 章（#16 第 5 节）。
 * @param bookRoot 书仓库根
 * @param chapterN 回退到的章号（该章定稿后的状态）
 */
export function rollbackToChapter(bookRoot: string, chapterN: number): RollbackResult {
  // #1 定位第 N 章 commit
  const targetCommit = findChapterCommit(bookRoot, chapterN)
  if (!targetCommit) {
    return {
      ok: false,
      humanMsg: `找不到第 ${chapterN} 章的定稿记录（没有 ch:${String(chapterN).padStart(4, '0')} 的 commit）。确认章号没错？`,
    }
  }

  // #2 备份再丢（可逆铁律）：当前 HEAD 存备份 ref，丢弃的内容可找回
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupRef = `回收/回到${chapterN}-${timestamp}`
  const backupR = git(['branch', backupRef], bookRoot)
  if (!backupR.ok) {
    return { ok: false, humanMsg: `备份失败，为安全起见中止回滚：${backupR.humanMsg}` }
  }

  // 算丢弃的章数（回滚前 HEAD 比 targetCommit 多的 ch: commit 数）
  const discardedChapters = countDiscardedChapters(bookRoot, targetCommit)

  // #3 回退定稿区：git reset --hard（丢弃 N 之后的 commit）
  const resetR = git(['reset', '--hard', targetCommit], bookRoot)
  if (!resetR.ok) {
    return { ok: false, humanMsg: `回退定稿区失败（内容已备份在 ${backupRef}）：${resetR.humanMsg}` }
  }

  // #4 重建缓存：删 .cache 全量重建，与回退后定稿区对齐
  const cacheDir = join(bookRoot, '.cache')
  if (existsSync(cacheDir)) {
    rmSync(cacheDir, { recursive: true, force: true })
  }
  rebuild(bookRoot, join(cacheDir, 'index.db'))

  // #5 清工作区：删未完成的草稿/细纲/.confirm（工作区不在 git，是文件系统删除）
  clearWorkdir(bookRoot)

  return {
    ok: true,
    revertedTo: chapterN,
    backupRef,
    discardedChapters,
    humanMsg: formatRollbackMsg(chapterN, discardedChapters, backupRef),
  }
}

/** 算回滚丢弃的章数（targetCommit 之后的 ch: commit 数） */
function countDiscardedChapters(bookRoot: string, targetCommit: string): number {
  const r = git(['log', '--grep', '^ch:', '--format=%H', `${targetCommit}..HEAD`], bookRoot)
  if (!r.ok) return 0
  return r.stdout.split('\n').filter(Boolean).length
}

/** 清空工作区未完成内容（草稿/细纲/.confirm，#16 第 5 节步骤 5） */
function clearWorkdir(bookRoot: string): void {
  const workDir = join(bookRoot, '工作区')
  if (!existsSync(workDir)) return
  try {
    for (const f of readdirSync(workDir)) {
      // 删草稿-N.md、细纲.md、.confirm.json、本章写作材料.md、审稿.md
      if (f.startsWith('草稿-') || f === '细纲.md' || f === '.confirm.json' ||
          f === '本章写作材料.md' || f === '审稿.md' || f.startsWith('._草稿-')) {
        unlinkSync(join(workDir, f))
      }
    }
  } catch {
    // 工作区不存在无妨
  }
}

/** 回滚人话确认（#16 第 5 节步骤 6，对作者零机器味 + 可找回） */
function formatRollbackMsg(chapterN: number, discarded: number, backupRef: string): string {
  const lines: string[] = []
  lines.push(`已回到第 ${chapterN} 章。`)
  if (discarded > 0) {
    lines.push(`之后的 ${discarded} 章退回草稿状态。`)
    lines.push(`旧内容存在「${backupRef}」，要找回告诉我（这是你的创作决策，不该丢）。`)
  } else {
    lines.push(`（这章之后的暂无定稿，无需丢弃。）`)
  }
  return lines.join('')
}
