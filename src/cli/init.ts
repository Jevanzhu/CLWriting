/**
 * `clwriting init` —— M5 安装器门面（#30）。
 *
 * 一条命令装出工作目录（非 git）+ 建第一本书（独立 git）。
 * 混合式：关键项交互（书名/题材/账本），全参数（--name --genre --leads）则非交互逃生。
 */

import process from 'node:process'
import readline from 'node:readline'
import { resolve } from 'node:path'
import { doInit } from '../install/init.js'
import { matchGenreLeads, BASE_LEAD_TYPES, EXTENDED_LEAD_TYPES } from '../install/data.js'

/** `clwriting init [--name 书名] [--genre 题材] [--leads 类,类] [--kind long|short]` */
export async function initCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printInitHelp()
    return
  }

  const name = argValue(args, '--name')
  const genre = argValue(args, '--genre')
  const leadsRaw = argValue(args, '--leads')
  const kind = argValue(args, '--kind') === 'short' ? 'short' : 'long'

  // 工作目录：显式位置参 > cwd（剔除 flag 及其值后剩下的第一个位置参）
  const flagsWithValue = new Set(['--name', '--genre', '--leads', '--kind'])
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('--')) {
      if (flagsWithValue.has(a)) i++ // 跳过 flag 的值
      continue
    }
    positional.push(a)
  }
  const workDir = positional[0] ? resolve(positional[0]) : resolve(process.cwd())

  // 非交互逃生：全参数齐 → 直接建
  if (name && (genre || leadsRaw)) {
    const leads = leadsRaw ? leadsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined
    const result = doInit({ workDir, name, genre, leads, kind })
    reportInitResult(result, kind)
    return
  }

  // 交互式（需要 stdin）
  if (!process.stdin.isTTY) {
    console.error('✗ 非交互环境（无 TTY），请用 --name --genre --leads 全参数，或 --help 看用法。')
    process.exit(1)
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, (a) => r(a.trim())))

  try {
    // 步骤 2：书名
    const bookName = name ?? (await ask('书名？ '))
    if (!bookName) {
      console.error('✗ 书名不能为空')
      process.exit(1)
    }

    // 步骤 3：题材
    const bookGenre = genre ?? (await ask('题材？（如 玄幻/悬疑/言情/都市，回车跳过） '))

    // 步骤 4：题材推荐账本类 → 作者确认
    let leads: string[] | undefined
    if (leadsRaw) {
      leads = leadsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    } else if (bookGenre) {
      const recommended = matchGenreLeads(bookGenre)
      console.log(`\n按题材「${bookGenre}」推荐扩展账本类：${recommended.length ? recommended.join('、') : '（仅基础三类：' + BASE_LEAD_TYPES.join('、') + '）'}`)
      console.log(`可选扩展类：${EXTENDED_LEAD_TYPES.join('、')}`)
      const confirm = await ask('直接用推荐？（回车确认 / 输入要加的类用逗号分隔 / 输入 none 仅基础三类） ')
      if (confirm === '' || confirm.toLowerCase() === 'y' || confirm.toLowerCase() === '是') {
        leads = recommended
      } else if (confirm.toLowerCase() === 'none' || confirm.toLowerCase() === '无') {
        leads = []
      } else {
        leads = confirm.split(',').map((s) => s.trim()).filter(Boolean)
      }
    }

    const result = doInit({ workDir, name: bookName, genre: bookGenre || undefined, leads, kind })
    reportInitResult(result, kind)
  } finally {
    rl.close()
  }
}

function reportInitResult(
  result: { ok: true; bookName: string } | { ok: false; reason: string },
  kind: 'long' | 'short' = 'long',
): void {
  if (!result.ok) {
    console.error(`✗ ${result.reason}`)
    process.exit(1)
  }
  const isShort = kind === 'short'
  console.log(`✓ ${isShort ? '短篇集' : '书'}「${result.bookName}」建好了。`)
  console.log('· 工作目录：已装角色壳 + 插件本体（.clwriting/）')
  if (isShort) {
    console.log('· 书仓库：book.yaml（kind: short）+ 篇/ + 文风/ + 工作区/ + 初始 git commit')
  } else {
    console.log('· 书仓库：book.yaml + 大纲/定稿/文风目录 + 初始 git commit')
  }
  console.log('')
  console.log(`下一步：敲 \`clwriting enter\` 起草第一${isShort ? '篇' : '章'}。`)
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const val = args[idx + 1]
  return val && !val.startsWith('--') ? val : undefined
}

function printInitHelp(): void {
  console.log('用法：clwriting init [--name 书名] [--genre 题材] [--leads 类,类] [--kind long|short]')
  console.log('')
  console.log('一条命令装出工作目录 + 建第一本书。')
  console.log('· 不给参数：交互问书名/题材/账本类')
  console.log('· --name --genre --leads 全给：非交互（AI/CI 用）')
  console.log('· --kind short：短篇集（细节归 M8）')
}
