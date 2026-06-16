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
  console.log('CLWriting —— 中文网文 AI 创作系统（M0 骨架）')
  console.log('用法：clwriting [--version | --help]')
}

main()
