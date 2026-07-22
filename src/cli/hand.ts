/**
 * `clwriting hand [章号|篇号] [书目录]` —— W2B 手写起草（自由模式默认）。
 *
 * 创建 工作区/草稿-N.md 空白 front matter 模板并占住编辑锁；
 * 作者用自己的编辑器手写正文，定稿时再走 `clwriting finalize`。
 * 与 AI 连写流程互斥（拒绝未完 batch + 占 editing_workdir 锁）。
 */

import process from 'node:process'
import { join } from 'node:path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolveBookRoot } from '../install/books.js'
import { readBookConfig } from '../format/yaml.js'
import { detectState } from '../state/state.js'
import { isBatchActive } from '../auto/batch.js'
import { acquireEditingWorkdir } from '../process/gui-active.js'

/** `clwriting hand [N] [书目录]` 命令处理器 */
export function handCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printHandHelp()
    return
  }

  // 章号/篇号位置参（第一个纯数字参）；非数字参留给 resolveBookRoot 定位书目录
  const numArg = args.find((a) => /^\d+$/.test(a))
  const nonNumArgs = args.filter((a) => !/^\d+$/.test(a) && !a.startsWith('--'))
  const resolved = resolveBookRoot(nonNumArgs)
  if (!resolved.ok) {
    console.error(`✗ ${resolved.reason}`)
    process.exit(1)
  }
  const { bookRoot } = resolved

  // 未完 batch 拒绝（与 AI 连写互斥）
  if (isBatchActive(bookRoot)) {
    console.error(
      '✗ 有未完成的 AI 连写批次。先 `clwriting auto --resume` 跑完，' +
        '或 `clwriting review batch rollback --yes` 回滚，再手写。',
    )
    process.exit(1)
  }

  const { config } = readBookConfig(join(bookRoot, 'book.yaml'))
  const isShort = config.kind === 'short'
  const unit = isShort ? '篇' : '章'

  // 当前态非 7（起草新章/篇）→ 提示先处理当前态（如态 4 有草稿没收尾）
  const detected = detectState(bookRoot, config)
  if (detected.state !== 7) {
    console.error(`✗ 当前不是「起草新${unit}」态（态 ${detected.state}）。先处理当前状态再手写。`)
    process.exit(1)
  }
  const num = numArg ? Number(numArg) : detected.nextChapter

  // 草稿路径（长篇=章号，短篇=篇号）+ 已存在拒绝
  const workDir = join(bookRoot, '工作区')
  const draftName = `草稿-${num}.md`
  const draftPath = join(workDir, draftName)
  if (existsSync(draftPath)) {
    console.error(`✗ 草稿已存在：${draftName}。定稿用 \`clwriting finalize ${draftName}\`，或删掉重建。`)
    process.exit(1)
  }

  // 创建草稿模板（钩子/情绪字段 readChapter/readPiece 有默认，此处给最小集）
  mkdirSync(workDir, { recursive: true })
  writeFileSync(draftPath, renderDraftTemplate(num, isShort), 'utf-8')

  // 占住工作区编辑锁（与 AI 批写互斥）；失败回滚草稿避免无锁半成品
  if (!acquireEditingWorkdir(bookRoot)) {
    rmSync(draftPath, { force: true })
    console.error('✗ 无法占住工作区编辑锁（写 .gui-active.json 失败）。检查目录权限后重试。')
    process.exit(1)
  }

  const dirHint = nonNumArgs[0] ? ` ${nonNumArgs[0]}` : ''
  console.log(`✓ 已创建 ${draftName}（第 ${num} ${unit}）。开始手写。`)
  console.log(`  草稿：${draftPath}`)
  console.log(`  定稿：clwriting finalize ${draftName}${dirHint}`)
}

/** 渲染草稿 front matter 模板（最小集：编号 + 标题；钩子/情绪留默认）。 */
function renderDraftTemplate(num: number, isShort: boolean): string {
  const head = isShort ? `篇号: ${num}` : `章号: ${num}`
  const unit = isShort ? '篇' : '章'
  return [
    '---',
    head,
    '标题: 未命名',
    '---',
    '',
    `（此处开始手写第 ${num} ${unit}正文）`,
    '',
  ].join('\n')
}

function printHandHelp(): void {
  console.log('用法：clwriting hand [章号|篇号] [书目录]')
  console.log('手写起草：创建 工作区/草稿-N.md 空白模板并占住编辑锁，用自己的编辑器写正文。')
  console.log('  省章号 → 取下一章（自动推算）。')
  console.log('  定稿：clwriting finalize 草稿-N.md')
}
