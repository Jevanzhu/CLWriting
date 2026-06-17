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
import { resolve } from 'node:path'
import { enter, formatRecap, formatRoute } from '../state/state.js'

/** `clwriting enter [bookRoot]` 命令处理器 */
export function enterCommand(args: string[]): void {
  const bookRoot = args[0] ? resolve(args[0]) : process.cwd()

  const { recap, route } = enter(bookRoot)

  // 近况复述（#15 第 4 节）
  console.log(formatRecap(recap))
  console.log()
  // 路由建议（#15 第 2 节）
  console.log(formatRoute(route))
}
