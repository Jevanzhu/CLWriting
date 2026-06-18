/**
 * `clwriting roles generate/check` —— M4 #21 角色壳生成与 drift check 薄门面。
 *
 * M4 只出生成器与检查；宿主检测、安装链路和 books.jsonl 归 M5。
 */

import process from 'node:process'
import { resolve } from 'node:path'
import {
  checkRoleShellDrift,
  formatDriftReport,
  generateRoleShells,
  type ShellPlatform,
} from '../roles/shells.js'

/** `clwriting roles <generate|check> [书目录] [--platform=claude,codex,generic]` */
export function rolesCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printRolesHelp()
    return
  }

  const subcommand = args[0]
  if (subcommand !== 'generate' && subcommand !== 'check') {
    printRolesHelp(console.error)
    process.exit(1)
  }

  const platformArg = args.find((arg) => arg.startsWith('--platform='))
  const platforms = platformArg ? parsePlatforms(platformArg.slice('--platform='.length)) : undefined
  const positional = args.slice(1).filter((arg) => !arg.startsWith('--platform='))
  const projectRoot = positional[0] ? resolve(positional[0]) : process.cwd()

  if (subcommand === 'generate') {
    const result = generateRoleShells({ projectRoot, ...(platforms ? { platforms } : {}) })
    if (!result.ok) {
      console.error(`✗ ${result.reason}`)
      process.exit(1)
    }
    console.log(`✓ 已生成 ${result.manifest.outputs.length} 个角色壳。`)
    for (const path of result.written) console.log(`· ${path}`)
    return
  }

  const report = checkRoleShellDrift(projectRoot)
  console.log(formatDriftReport(report))
  if (!report.ok) process.exit(1)
}

function parsePlatforms(raw: string): ShellPlatform[] {
  const values = raw.split(',').map((item) => item.trim()).filter(Boolean)
  const platforms: ShellPlatform[] = []
  for (const value of values) {
    if (value !== 'claude' && value !== 'codex' && value !== 'generic') {
      console.error(`未知平台：${value}`)
      process.exit(1)
    }
    platforms.push(value)
  }
  return platforms.length > 0 ? platforms : ['claude', 'codex', 'generic']
}

function printRolesHelp(write: (message: string) => void = console.log): void {
  write('用法：clwriting roles <generate|check> [书目录] [--platform=claude,codex,generic]')
}
