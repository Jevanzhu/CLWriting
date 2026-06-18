#!/usr/bin/env node
import process from 'node:process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const MIN_NODE_MAJOR = 24

/** 从 package.json 读版本号（单源；读取失败兜底回硬编码防崩） */
function readVersion(): string {
  try {
    // 本文件在 src/（或打包后 dist/），包根是其上一级目录
    const here = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(here, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const VERSION = readVersion()

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

  // 子命令路由（#15 状态机单入口；M3 起逐步补命令）
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
    case 'confirm': {
      import('./cli/confirm.js').then(({ confirmCommand }) => confirmCommand(rest))
      return
    }
    case 'check': {
      import('./cli/check.js').then(({ checkCommand }) => checkCommand(rest))
      return
    }
    case 'finalize': {
      import('./cli/finalize.js').then(({ finalizeCommand }) => finalizeCommand(rest))
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
  console.log('  confirm <章号> [书目录] [--auto]  确认工作区细纲（写 .confirm.json）')
  console.log('  check [草稿文件] [书目录] [--full]  运行机检（红项退出码 1）')
  console.log('  finalize [草稿文件] [书目录]  定稿并提交（需工作区/审稿.md）')
  console.log('  --version, -v    显示版本')
  console.log('  --help, -h       显示帮助')
}

main()
