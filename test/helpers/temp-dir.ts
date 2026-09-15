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
 *
 * 双体系现状与收编口径（重评-0914-三轮 nano R7-2 记档）：test 树并存两套临时目录
 * 卫生体系——本文件 mkdtempTracked（登记 + afterEach 兜底）251 文件在用（另 11 文件
 * 双轨并用）；散布全树的 ad-hoc 形态（裸 mkdtempSync + 测试体尾行/afterEach 手工
 * rmSync）307 文件。两体系清理语义等价（成功路径尾行清理、失败路径兜底回收），
 * 差异只在失败用例是否留残留；收编须逐文件核对 beforeAll 共享目录等登记例外，
 * 300+ 文件迁移成本超单批边界——如实记档维持现状，不设强迁时限；新增测试默认
 * 走 mkdtempTracked，改动所及的 ad-hoc 文件顺手收编。
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
