/**
 * R65-29（第六十五轮）回归：导出 worker 卸载层补 'exit' 监听。
 *
 * worker 非错误退出（resourceLimits 内存上限 abort / 入口显式 process.exit）不触发
 * 'error' 事件——修复前 Promise 悬挂至 120s 超时才拒；修复后 exit 即快速 reject。
 * 注入方式：ExportRunnerOptions.workerUrl 指向一个立即 process.exit(0) 的 worker
 * 脚本（.mjs，非 .ts → 不挂 tsx loader），timeoutMs 放大——若 exit 监听缺失则用例
 * 等满超时（测试内墙钟断言拦下「没等超时就拒绝」）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from 'vitest'
import { runExportBookAsync } from '../../src/export/run-async.js'

test('R65-29: worker 无消息即退出（process.exit(0)）→ 快速 reject，不等 120s 超时', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clw-run-async-exit-'))
  try {
    const workerScript = join(dir, 'exit-immediately.mjs')
    writeFileSync(workerScript, 'process.exit(0)\n', 'utf-8')
    const t0 = Date.now()
    // timeoutMs 放大到 60s：修复前（无 exit 监听）该 Promise 悬挂至超时——
    // 墙钟断言 <10s 拦下「靠超时兜底才拒绝」的回归形态
    await expect(
      runExportBookAsync({ bookRoot: dir }, { workerUrl: pathToFileURL(workerScript), timeoutMs: 60_000 }),
    ).rejects.toThrow(/工作线程已退出/)
    expect(Date.now() - t0).toBeLessThan(10_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
