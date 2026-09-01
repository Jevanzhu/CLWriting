/**
 * RB-SV-P2-6：退出前清理——中断在途编排 + 关 HTTP server。
 *
 * 只用现有 API：abortSelfHeal / abortChat（per book，self-heal 与 chat 编排的
 * 中断入口，与删书端点同款接线）；server.close。DocumentService 写队列无公开
 * drain/flush API（保存路径有 journal 崩溃恢复兜底），本层不强行介入。
 * close 对 SSE/keep-alive 长连接会悬置回调——限时放行，由调用方再兜一层总超时。
 */
import http from 'node:http'
import { readBooks } from '../install/books.js'
import { abortSelfHeal, waitSelfHealSettled } from '../ai/orchestrate/self-heal.js'
import { abortChat, waitChatSettled } from '../ai/orchestrate/chat.js'
import { waitBackgroundTasks } from '../ai/orchestrate/background.js'
import { isSpawnRunning } from '../ai/orchestrate/spawn-registry.js'
import { getDriver, getSession } from '../driver/index.js'
import { heldTaskGatesFor } from '../studio/server/api/task-gate.js'

export interface ShutdownOptions {
  /** server.close 回调等待上限（SSE 长连接未断时悬置）；缺省 1.5s */
  closeTimeoutMs?: number
  /** #7/L3：被中断编排的收尾等待上限（session/end 落库）；缺省 1.5s（与 close 同量级） */
  settleTimeoutMs?: number
}

/** R70-7：轮询等某书全部 task-gate 释放（100ms 间隔；上限即 settle 预算，由外层 race 兜底）。 */
function waitTaskGatesSettled(bookName: string, timeoutMs: number): Promise<void> {
  return new Promise((resolveP) => {
    const t0 = Date.now()
    const poll = (): void => {
      if (heldTaskGatesFor(bookName).length === 0 || Date.now() - t0 >= timeoutMs) resolveP()
      else setTimeout(poll, 100).unref()
    }
    poll()
  })
}

/** 优雅关闭：workDir 下每本书中断在途编排，再关 HTTP server。幂等性由调用方保证（只调一次）。 */
export async function shutdownStudio(
  getWorkDir: () => string | null,
  server: http.Server | null,
  opts: ShutdownOptions = {},
): Promise<void> {
  const workDir = getWorkDir()
  const names: string[] = []
  if (workDir) {
    for (const b of readBooks(workDir)) {
      abortSelfHeal(b.name)
      abortChat(b.name)
      // R69-23（十七轮）：spawn 在途的中止——spawn ctrl 按 owner='spawn' 注册进 driver
      // （无 abortSpawn 独立入口），退出链此前只走 chat/self-heal 两路 abort，手动写稿
      // 生成中的 LLM 请求在 settle 窗口内无人中止、process.exit 硬杀 → 该次 llm/call
      // 终态事件不落库（费用/审计少记一笔）。与 /interrupt 端点同款：driver.interrupt 全
      // 槽 abort（对空闲会话 no-op）。
      if (isSpawnRunning(b.name)) {
        const session = getSession(b.name)
        if (session) getDriver().interrupt?.(session)
      }
      names.push(b.name)
    }
  }
  // #7/L3（二轮复审）：等被中断的编排收尾（session/end 事件落库）——此前 abort 后不等
  // 编排解旋就 quit，被中断对话的收尾 flush 没机会落库，孤儿会话要等启动修复的 10 分钟
  // 宽限才补 synthetic end，快速重启窗口内 latestSession 可能选到未闭合会话。与 server.close
  // 并行等待，总时长不叠加。
  // M-2：补 waitBackgroundTasks——定稿章摘要/账本草稿等无 abort 句柄的 fire-and-forget
  // 后台任务，退出前给它们一个有界的收尾窗口（超时放行，磁盘是原子写）
  // R-20（第十六轮）：settle/close 兜底超时定时器 .unref()——不 unref 时它们是进程
  // 事件循环的活跃句柄，close 已顺利完成后定时器仍挂满剩余时长才放行退出（无谓拖慢
  // 退出）；unref 后无其他句柄时进程可即退，超时触发语义不变。
  const settleWait = Promise.all(
    names.map((n) =>
      Promise.race([
        Promise.all([
          waitChatSettled(n),
          waitSelfHealSettled(n),
          waitBackgroundTasks(n),
          // R70-7（十八轮）：task-gate 长任务（review/outline/analyze/onboard/lead-updates）
          // 无 abort 通道（R69-23 为 spawn 修的同型缺口）——给有界 settle 窗口等闸释放
          // （在途 LLM 调用得以收尾落 llm/call 终态事件，费用/审计不丢账），超时放行
          // 与旧口径一致（process.exit 硬杀，孤儿终态由事件库宽限修复补）。
          waitTaskGatesSettled(n, opts.settleTimeoutMs ?? 1_500),
        ]),
        new Promise<void>((resolveP) => setTimeout(resolveP, opts.settleTimeoutMs ?? 1_500).unref()),
      ]),
    ),
  )
  if (server) {
    await new Promise<void>((resolveP) => {
      let done = false
      let timer: NodeJS.Timeout | undefined
      const fin = (): void => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer) // R-20：settle（close 回调）即清，不留挂满时长的空转定时器
        resolveP()
      }
      server.close(() => fin())
      // R33-64（三十三轮）：close 只停接新请求并等在途响应，keep-alive/SSE 空闲连接
      // 此前靠下方定时器硬等拖满排水尾——主动摘除空闲连接（Node ≥18.2）。
      server.closeIdleConnections?.()
      timer = setTimeout(fin, opts.closeTimeoutMs ?? 1_500)
      timer.unref() // R-20：同上，不阻塞无其他句柄时的正常退出
    })
  }
  await settleWait
}
