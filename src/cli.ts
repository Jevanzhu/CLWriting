#!/usr/bin/env node
import process from 'node:process'

const MIN_NODE_MAJOR = 24
const VERSION = '1.0.0-alpha.0' // M0 暂硬编码，收尾改单源（第 12 节）

function ensureNodeVersion(): void {
  const major = Number(process.versions.node.split('.')[0])
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    console.error(
      `CLWriting 需要 Node ${MIN_NODE_MAJOR} 或更高版本（当前 ${process.versions.node}）。\n` +
        `请升级 Node 后重试：https://nodejs.org/`,
    )
    process.exit(1)
  }
}

function main(): void {
  ensureNodeVersion()
  const arg = process.argv[2]
  if (arg === '--version' || arg === '-v') {
    console.log(VERSION)
    return
  }

  // 子命令路由（⑮ 状态机单入口；M3 起逐步补命令）
  const rest = process.argv.slice(3)
  switch (arg) {
    case 'enter': {
      // 动态 import：只在用 enter 时加载状态机依赖链，保持其他命令启动轻
      import('./cli/enter.js').then(({ enterCommand }) => enterCommand(rest))
      return
    }
    case 'health': {
      import('./cli/health.js').then(({ healthCommand }) => healthCommand(rest))
      return
    }
    case 'revert': {
      import('./cli/revert.js').then(({ revertCommand }) => revertCommand(rest))
      return
    }
    case '--help':
    case '-h':
    case undefined:
      printHelp()
      return
    default:
      console.error(`未知命令：${arg}`)
      printHelp()
      process.exit(1)
  }
}

function printHelp(): void {
  console.log('CLWriting —— 中文网文 AI 创作系统')
  console.log('')
  console.log('用法：clwriting <命令> [参数]')
  console.log('')
  console.log('命令：')
  console.log('  enter [书目录]   进书：进门体检 + 判态 + 近况复述（状态机单入口）')
  console.log('  health [书目录]  单独跑 git 健康检查（半提交/冲突/锁/同步盘副本）')
  console.log('  revert <章号> [书目录]  回到第 N 章（回滚，丢弃内容先进备份可找回）')
  console.log('  --version, -v    显示版本')
  console.log('  --help, -h       显示帮助')
}

main()
