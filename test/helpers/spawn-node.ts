/**
 * R32-37（三十二轮）：跨进程测试子进程统一 spawn 兜底。
 *
 * 此前各跨进程互斥回归的 worker spawn（node --import tsx --eval）裸 await 'close'：
 * 子进程挂死（锁死循环/IO 卡住）时 vitest 用例超时只杀测试不杀子进程，孤儿进程残留
 * 到 CI 进程组之外。本 helper 统一带看门狗：超时 SIGKILL，退出码语义不变。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export interface SpawnNodeEvalOptions {
  /** 看门狗超时（毫秒）；默认 60s（各 worker 正常完成秒级，60s 已极保守） */
  timeoutMs?: number
  /** 错误消息里的 worker 标签（默认 'worker'） */
  label?: string
  /** stdout 块回调（worker 需要收集子进程输出时用） */
  onStdout?: (chunk: string) => void
}

/**
 * 给 child 挂超时 SIGKILL 看门狗（close/error 时自动拆除）。只兜底不接管退出语义——
 * 自定义收尾的 spawn 方（如 server-main 长驻子进程）直接用本函数。
 */
export function armWatchdog(child: ChildProcess, timeoutMs = 60_000): void {
  const watchdog = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, timeoutMs)
  child.once('close', () => clearTimeout(watchdog))
  child.once('error', () => clearTimeout(watchdog))
}

/**
 * spawn 一个 `node --import tsx --eval <script>` 子进程并挂看门狗。
 * 返回 done：退出码 0 → resolve；非零 → reject（带 stderr 前 500 字符摘要）；
 * 看门狗触发 → SIGKILL 后按非零 reject。
 */
export function spawnNodeEval(script: string, opts: SpawnNodeEvalOptions = {}): { child: ChildProcess; done: Promise<number> } {
  const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
  if (opts.onStdout) child.stdout?.on('data', (c: Buffer) => opts.onStdout!(c.toString('utf8')))
  armWatchdog(child, opts.timeoutMs ?? 60_000)
  const done = new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(code)
      else reject(new Error(`${opts.label ?? 'worker'} 退出码 ${code}：${stderr.slice(0, 500)}`))
    })
  })
  return { child, done }
}
