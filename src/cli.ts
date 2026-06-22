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
    case 'record-call': {
      import('./cli/record-call.js').then(({ recordCallCommand }) => recordCallCommand(rest))
      return
    }
    case 'prepare': {
      import('./cli/prepare.js').then(({ prepareCommand }) => void prepareCommand(rest))
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
    case 'rebook': {
      import('./cli/rebook.js').then(({ rebookCommand }) => rebookCommand(rest))
      return
    }
    case 'roles': {
      import('./cli/roles.js').then(({ rolesCommand }) => rolesCommand(rest))
      return
    }
    case 'knowledge': {
      import('./cli/knowledge.js').then(({ knowledgeCommand }) => knowledgeCommand(rest))
      return
    }
    case 'review': {
      import('./cli/review.js').then(({ reviewCommand }) => reviewCommand(rest))
      return
    }
    case 'session-start': {
      import('./cli/session-start.js').then(({ sessionStartCommand }) => sessionStartCommand(rest))
      return
    }
    case 'init': {
      import('./cli/init.js').then(({ initCommand }) => initCommand(rest))
      return
    }
    case 'update': {
      import('./cli/update.js').then(({ updateCommand }) => updateCommand(rest))
      return
    }
    case 'use': {
      import('./cli/use.js').then(({ useCommand }) => useCommand(rest))
      return
    }
    case 'list': {
      import('./cli/list.js').then(({ listCommand }) => listCommand(rest))
      return
    }
    case 'repair': {
      import('./cli/repair.js').then(({ repairCommand }) => repairCommand(rest))
      return
    }
    case 'auto': {
      import('./cli/auto.js').then(({ autoCommand }) => autoCommand(rest))
      return
    }
    case 'export': {
      import('./cli/export.js').then(({ exportCommand }) => exportCommand(rest))
      return
    }
    case 'import': {
      import('./cli/import.js').then(({ importCommand }) => importCommand(rest))
      return
    }
    case 'learn': {
      import('./cli/learn.js').then(({ learnCommand }) => learnCommand(rest))
      return
    }
    case 'enable-rag': {
      import('./cli/enable-rag.js').then(({ enableRagCommand }) => enableRagCommand(rest))
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
  console.log('  health [书目录] [--metrics|--style|--report]  git/指标/文风体检')
  console.log('  revert <章号> [书目录]  回到第 N 章（回滚，丢弃内容先进备份可找回）')
  console.log('  confirm <章号> [书目录] [--auto]  确认工作区细纲（写 .confirm.json）')
  console.log('  record-call <章号> --step <outline|draft> ([--calls N] [--tokens N] | --set-tokens N)  记账/回填 AI 调用')
  console.log('  prepare [书目录] [--lead A,B] [--scene 场景]  生成工作区/本章写作材料.md')
  console.log('  check [草稿文件] [书目录] [--full] [--strict-short]  运行机检（红项退出码 1）')
  console.log('  finalize [草稿文件] [书目录]  定稿并提交（需工作区/审稿.md）')
  console.log('  rebook [书目录] [--yes]  报告/补登定稿区与大纲区手改')
  console.log('  roles <generate|check> [工作目录|书目录]  生成角色壳 / 检查壳漂移')
  console.log('  knowledge check [书目录]  校验知识层 manifest 与素材哈希')
  console.log('  review <plan|run|collect|batch> [书目录] --chapter=N  三审计划 / 打包执行包 / 回收写审稿单 / 批量审稿')
  console.log('  session-start [书目录]  输出给 AI 的会话起始近况注入文本')
  console.log('  init [--name X --genre Y --leads 类,类]  装工作目录 + 建第一本书')
  console.log('  update   升级插件本体 + 重生角色壳（作者数据只增不覆盖）')
  console.log('  use <书名>   切换当前活动书')
  console.log('  list      列出已登记的所有书')
  console.log('  repair    自愈 books.jsonl（扫描重建登记，报告丢失的书）')
  console.log('  auto [N] [--resume]   连写 N 章（自动模式，产出攒进待定稿）')
  console.log('  export [--format <merged|split|both>]  干净导出定稿正文（剥 front matter）')
  console.log('  import <v0.2正文> [--name 书名] [--kind long|short]  导入 v0.2 正文（复用 scaffold 建书）')
  console.log('  learn [commit] [书目录]  文风样章/金句收割（#10 打分，候选制，交互式挑选入库）')
  console.log('  enable-rag --endpoint URL --model NAME [--key KEY]  启用 RAG 可选插件（key 不进 git）')
  console.log('  --version, -v    显示版本')
  console.log('  --help, -h       显示帮助')
}

main()
