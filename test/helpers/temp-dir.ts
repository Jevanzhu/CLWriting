/**
 * R72-21（二十轮 G-3）测试基建：临时目录自动回收兜底。
 *
 * 重脚手架测试文件的既有口径是「测试体尾行 rmSync」——断言一旦失败清理行不可达，
 * 临时目录在 $TMPDIR 无限累积（不污染结果，但失败跑批持续泄漏）。本助手提供
 * mkdtempTracked：创建即登记，文件级 afterEach 兜底移除。与测试体尾行 rmSync
 * 并存：通过用例先走尾行清理，afterEach 的 force:true 幂等 no-op；失败用例由
 * afterEach 收走。注意：beforeAll 创建、跨测试共享的目录不得登记（afterEach 会在
 * 首个测试后提前删共享目录），此类（如 resolve-book-root 的 isoTmp）保持手工
 * beforeAll/afterAll 对。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { afterEach } from 'vitest'

const pending = new Set<string>()

/** 登记临时目录（当前测试结束后无论成败都移除）。返回原路径便于内联包装。 */
export function trackTempDir(dir: string): string {
  pending.add(dir)
  return dir
}

/** mkdtempSync 追踪版：参数与返回值同 node:fs.mkdtempSync 的 string 形态。 */
export function mkdtempTracked(prefix: string): string {
  return trackTempDir(mkdtempSync(prefix))
}

afterEach(() => {
  if (pending.size === 0) return
  for (const dir of pending) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort：进程占用（如 Windows cwd 停在目录内）时放弃，不掩盖测试失败
    }
  }
  pending.clear()
})
