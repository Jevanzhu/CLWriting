/**
 * `clwriting health [书目录]` —— 单独触发 git 健康检查（#16 第 2 节，#15 态 1）。
 *
 * 作者怀疑书仓库 git 有问题时单独敲这个（不必走完整 enter 流程）。
 * 输出各异常的人话 + 修复指引；干净则报平安。
 */

import process from 'node:process'
import { resolve } from 'node:path'
import { gitHealthCheck } from '../git/exec.js'

/** `clwriting health [bookRoot]` 命令处理器 */
export function healthCommand(args: string[]): void {
  const bookRoot = args[0] ? resolve(args[0]) : process.cwd()

  const report = gitHealthCheck(bookRoot)
  if (report.clean) {
    console.log('✓ 书仓库 git 干净，没有半提交 / 冲突 / 锁 / 同步盘副本残留。')
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
