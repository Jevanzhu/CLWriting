/**
 * `clwriting health [书目录]` —— 单独触发 git 健康检查（#16 第 2 节，#15 态 1）。
 *
 * 作者怀疑书仓库 git 有问题时单独敲这个（不必走完整 enter 流程）。
 * 输出各异常的人话 + 修复指引；干净则报平安。
 *
 * 体检周期闭环（#15 第 6 节）：git 干净时顺手记一笔「体检做到当前章」，
 * 让状态机态 6 的「该体检了」提示消除（作者跑一次 health 即算体检）。
 */

import process from 'node:process'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gitHealthCheck } from '../git/exec.js'
import { writeHealthCheck } from '../cache/healthcheck.js'
import { rebuild } from '../cache/rebuild.js'
import { resolveBookRoot } from '../install/books.js'

/** `clwriting health [bookRoot]` 命令处理器 */
export function healthCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printHealthHelp()
    return
  }

  const resolved = resolveBookRoot(args)
  if (!resolved.ok) {
    console.error(`✗ ${resolved.reason}`)
    process.exit(1)
  }
  const bookRoot = resolved.bookRoot

  const report = gitHealthCheck(bookRoot)
  if (report.clean) {
    console.log('✓ 书仓库 git 干净，没有半提交 / 冲突 / 锁 / 同步盘副本残留。')
    // 体检闭环：干净则记账，消除态 6 提示（#15 第 6 节）
    markHealthCheckDone(bookRoot)
    return
  }

  console.log(`✗ 发现 ${report.issues.length} 个问题，逐个处理：\n`)
  for (const issue of report.issues) {
    console.log(`· ${issue.humanMsg}`)
    console.log(`  怎么办：${issue.fix}`)
    if (issue.files && issue.files.length > 0) {
      console.log(`  相关文件：${issue.files.join('、')}`)
    }
    console.log()
  }
}

function printHealthHelp(): void {
  console.log('用法：clwriting health [书目录]')
  console.log('单独跑 git 健康检查；干净时记录一次体检完成。')
}

/** 记体检完成（先重建缓存，再读当前章号写 health-check.json；失败不阻断 health 命令） */
function markHealthCheckDone(bookRoot: string): void {
  const cachePath = join(bookRoot, '.cache', 'index.db')
  try {
    // health 可单独运行，不能假设 enter 已经把缓存重建到最新。
    rebuild(bookRoot, cachePath)
    const db = new DatabaseSync(cachePath)
    let currentChapter = 0
    try {
      const row = db.prepare('SELECT MAX(number) AS maxNum FROM chapters').get() as
        | { maxNum: number | null }
        | undefined
      currentChapter = row?.maxNum ?? 0
    } finally {
      db.close()
    }
    writeHealthCheck(bookRoot, currentChapter)
  } catch {
    // 读缓存失败不阻断 health 命令本身（体检记账是附带功能）
  }
}
