/**
 * M-2 回归：per-book 后台任务登记——fire-and-forget 逃生口收编。
 *
 * 修复前：定稿章摘要（afterFinalizeGenerateSummary）与账本推进草稿（self-heal
 * exitPass）是 settle 等待够不到的裸 promise——books.ts 删/改名与优雅退出在它们
 * 仍在途时继续执行，落盘窗口撞上目录删除/搬移会在旧路径重建孤儿目录。
 * 本测试锁三件事：
 * 1. 登记后 waitBackgroundTasks 不 resolve，任务收尾后才 resolve；
 * 2. 任务收尾前再登记新任务（批量定稿连发形态）也能被循环追上；
 * 3. 无在途时立即 resolve（等待方不被悬挂）。
 */
import { describe, expect, it } from 'vitest'
import { registerBackgroundTask, waitBackgroundTasks, hasBackgroundTasks } from '../../src/ai/orchestrate/background.js'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('M-2: 后台任务登记/等待', () => {
  it('在途不 resolve；任务收尾后 resolve；登记表清理干净', async () => {
    const book = 'bg-book-1'
    expect(hasBackgroundTasks(book)).toBe(false)
    let done = false
    registerBackgroundTask(book, sleep(150).then(() => {
      done = true
    }))
    expect(hasBackgroundTasks(book)).toBe(true)

    let settled = false
    void waitBackgroundTasks(book).then(() => {
      settled = true
    })
    await sleep(50)
    expect(settled).toBe(false) // 在途：等待不 resolve

    await waitBackgroundTasks(book)
    expect(done).toBe(true)
    expect(settled).toBe(true)
    expect(hasBackgroundTasks(book)).toBe(false) // 清理链跑完，表项回收
  })

  it('收尾前追登记新任务也能被循环追上（批量连发形态）', async () => {
    const book = 'bg-book-2'
    const order: string[] = []
    registerBackgroundTask(
      book,
      sleep(80).then(() => {
        order.push('one')
        // 第一条收尾前再登记第二条——旧实现若只等一轮，这里就会漏
        registerBackgroundTask(
          book,
          sleep(80).then(() => {
            order.push('two')
          }),
        )
      }),
    )
    await waitBackgroundTasks(book)
    expect(order).toEqual(['one', 'two']) // 两条都收尾才返回
    expect(hasBackgroundTasks(book)).toBe(false)
  })

  it('任务 reject 也不悬挂等待（登记方约定自留痕，此处兜底不传播）', async () => {
    const book = 'bg-book-3'
    registerBackgroundTask(book, Promise.reject(new Error('boom')))
    await expect(waitBackgroundTasks(book)).resolves.toBeUndefined()
    expect(hasBackgroundTasks(book)).toBe(false)
  })

  it('无在途立即 resolve', async () => {
    await expect(waitBackgroundTasks('bg-book-none')).resolves.toBeUndefined()
  })
})
