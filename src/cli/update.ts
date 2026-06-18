/**
 * `clwriting update` —— M5 #31 升级门面（占位，逻辑 WP5 补全）。
 *
 * 三类文件分治：插件本体升级 / 派生物重生 / 作者数据只增不覆盖。
 */

import process from 'node:process'
import { findWorkDir } from '../install/books.js'
import { doUpdate } from '../install/update.js'

/** `clwriting update` */
export function updateCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：clwriting update [--brief|--full]')
    console.log('升级插件本体 + 重生角色壳（作者数据只增不覆盖，有差异会提示）。')
    return
  }

  const workDir = findWorkDir(process.cwd())
  if (!workDir) {
    console.error('✗ 当前不在 CLWriting 工作目录（找不到 .clwriting/）。先 clwriting init 建一个。')
    process.exit(1)
  }

  const brief = args.includes('--brief')
  const full = args.includes('--full')
  const result = doUpdate({ workDir, detail: full ? 'full' : brief ? 'brief' : 'brief' })
  if (!result.ok) {
    console.error(`✗ ${result.reason}`)
    process.exit(1)
  }
  for (const line of result.report) console.log(line)
}
