/**
 * `clwriting enter` —— 状态机单入口命令（#15 第 3 节，无 hook 等价入口）。
 *
 * 作者进书时敲这个：进门体检（git/文件/手改）→ 判态 → 路由 → 近况复述。
 * SessionStart 真 hook 由 M4 平台壳接，届时复用同一近况（enter 的库形态 enter()）。
 *
 * 输出（对作者，零机器味）：
 * 1. 近况复述（写到哪里了、体检情况、上一章确认是否干净）
 * 2. 路由建议（现在该干什么）
 *
 * M3 阶段：作者可见路由建议；真执行（续跑/写章/修复）的 AI 介入由 M4 壳调。
 */

import process from 'node:process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveBookRoot } from '../install/books.js'
import { enter, formatRecap, formatRoute } from '../state/state.js'

/** `clwriting enter [bookRoot]` 命令处理器 */
export function enterCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printEnterHelp()
    return
  }

  const resolved = resolveBookRoot(args)
  if (!resolved.ok) {
    console.error(`✗ ${resolved.reason}`)
    process.exit(1)
  }
  const bookRoot = resolved.bookRoot

  const { recap, route, kind } = enter(bookRoot)
  const templates = ensureShortDraftTemplates(bookRoot, kind, route)

  // 近况复述（#15 第 4 节）
  console.log(formatRecap(recap, kind))
  console.log()
  // 路由建议（#15 第 2 节）
  console.log(formatRoute(route))
  if (templates.length > 0) {
    console.log(`已生成短篇起草骨架：${templates.map((p) => `工作区/${p}`).join('、')}`)
  }
}

function printEnterHelp(): void {
  console.log('用法：clwriting enter [书目录]')
  console.log('进书：进门体检 + 判态 + 近况复述。')
}

function ensureShortDraftTemplates(
  bookRoot: string,
  kind: 'long' | 'short',
  route: { state: number; action: string; nextChapter?: unknown },
): string[] {
  if (kind !== 'short' || route.state !== 7 || route.action !== 'write-new-chapter') return []
  const workDir = join(bookRoot, '工作区')
  mkdirSync(workDir, { recursive: true })

  const created: string[] = []
  const outlinePath = join(workDir, '细纲.md')
  if (!existsSync(outlinePath)) {
    writeFileSync(outlinePath, renderShortOutlineTemplate(nextPieceNumber(route)), 'utf-8')
    created.push('细纲.md')
  }

  const manifestPath = join(workDir, '清单.md')
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, renderShortManifestTemplate(), 'utf-8')
    created.push('清单.md')
  }
  return created
}

function nextPieceNumber(route: { nextChapter?: unknown }): number {
  return typeof route.nextChapter === 'number' ? route.nextChapter : 1
}

function renderShortOutlineTemplate(piece: number): string {
  return [
    '---',
    `篇号: ${piece}`,
    '标题: 待定',
    '目标情绪: 待定',
    '核心反转: 待定',
    '---',
    '',
    '# 细纲',
    '',
    '## 开头钩子',
    '（待补）',
    '',
    '## 铺垫',
    '（待补）',
    '',
    '## 升级',
    '（待补）',
    '',
    '## 反转',
    '（待补）',
    '',
    '## 余韵',
    '（待补）',
    '',
  ].join('\n')
}

function renderShortManifestTemplate(): string {
  return [
    '## 反转线索表',
    '- 核心反转：待定',
    '- 铺垫点（≥3，反转可回溯）：',
    '  - [开头钩子] 待补',
    '  - [铺垫] 待补',
    '  - [升级] 待补',
    '',
    '## 伏笔回收',
    '- 待补伏笔 → 回收于 待补',
    '',
  ].join('\n')
}
