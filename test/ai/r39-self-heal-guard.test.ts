/**
 * R39-14（三十九轮）：self-heal 并发守卫 fail-fast——绕过 isSelfHealRunning 闸的
 * 并发调起此前会静默顶掉旧运行 ctrl（abortSelfHeal 中断通道丢失、settling 表项被
 * 覆盖）。守卫命中即 rejects（当前生产调用方「先查后调」且检查与调用间无 await，
 * 正常不可达——本测试直接构造绕闸形态锁定不变量）。
 */
import { test, expect } from 'vitest'
import { join } from 'node:path'
import { makeDualTrackWorkdir, tempUserData, SHORT_BOOK } from '../studio/fixtures.js'
import { runSelfHeal, isSelfHealRunning, type SelfHealOpts } from '../../src/ai/orchestrate/self-heal.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { saveDraft } from '../../src/studio/server/api/draft.js'
import type { CheckOutcome } from '../../src/studio/server/api/check.js'

const META: ChapterMeta = {
  章号: 1,
  标题: '测试章',
  钩子类型: '悬念钩',
  钩子强弱: '中',
  情绪定位: '铺垫',
}

/** stream 永不产出——编排停在等模型首块，首轮保持「在途」态（running 表项被持有）；
 *  mainSession 由 opts 直注入，startSession 不在编排主路径上，挂点须在 stream。 */
function makeHangingDriver(): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {
      await new Promise<never>(() => {})
    },
    dispose(): void {},
    emit(): void {},
  }
}

test('R39-14: 首轮在途时二次调起 → runSelfHeal rejects（并发守卫失效 fail-fast）', async () => {
  const workDir = makeDualTrackWorkdir()
  const ud = tempUserData()
  const bookRoot = join(workDir, '短篇', SHORT_BOOK)
  const save: typeof saveDraft = async (_root, _ch, content) => ({
    relPath: '工作区/草稿-1.md',
    docId: 'doc-短篇-1',
    words: content.length,
    snapshotted: false,
  })
  const check = (): CheckOutcome => ({ ok: true, report: { sections: [] }, hasRed: true, chapter: META, body: '正文' })
  const opts: SelfHealOpts = {
    driver: makeHangingDriver(),
    mainSession: { id: 'main', cwd: bookRoot, closed: false },
    userDataPath: ud,
    cwd: bookRoot,
    bookRoot,
    bookName: SHORT_BOOK,
    chapter: 1,
    check,
    save,
    // 生成期永挂——机检 hasRed: true 把编排推进到 genFn，Promise 永不结算 = 首轮在途
    //（running 表项持有中；自愈在机检通过时不会触碰生成器，挂点必须在 genFn）
    genFn: () => new Promise<string>(() => {}),
  }
  void runSelfHeal(opts) // 首轮在途（挂起 startSession——running 表项持有中）
  await new Promise((r) => setTimeout(r, 20))
  expect(isSelfHealRunning(SHORT_BOOK)).toBe(true)
  // 二次调起：守卫命中（修复前 = 静默顶掉旧 ctrl 继续跑）
  await expect(runSelfHeal(opts)).rejects.toThrow(/并发守卫失效/)
})

// 进程退出兜底：永不结算的首轮 promise 不阻塞 vitest 收尾（forks 池按文件隔离，
// running 表项随进程销毁，无需显式清理）
