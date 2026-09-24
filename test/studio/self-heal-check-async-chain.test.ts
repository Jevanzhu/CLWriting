/**
 * 自愈编排的机检链必须走异步入口（质量评审 P2-2 回归）。
 *
 * 文件头锚注：源码锚 src/ai/orchestrate/self-heal.ts（orchestrate 开库段与
 * ChapterCtx.check 默认实现）。
 *
 * 修复前：orchestrate 在服务端事件循环上同步 rebuild + `new DatabaseSync` + 同步机检腿
 * （driveToEnd）——SMB / 网盘 / 慢盘上 /auto-write 的起步 rebuild 与每轮重写后的机检整段
 * 冻结 server 事件循环，期间全部 API 与 SSE 心跳停摆（批量连写成倍放大）。
 * 修复后：开库经 openCheckDbAsync（rebuild 内核搬 worker 线程），机检体经 driveToEndAsync
 * 驱动（每个悬停让出一拍事件循环）——与 check 端点、chat check_chapter 同一条异步链。
 *
 * 用例锁「异步入口被走到」这一机制面：全库仅 self-heal 与 check 端点两处调
 * openCheckDbAsync / driveToEndAsync，本套件只跑编排器，故计数归零即「该腿被改回同步」。
 * 时间面不设阈值断言（慢腿抖动），只钉入口。
 */
import { test, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeDualTrackWorkdir, LONG_BOOK, tempUserData } from './fixtures.js'
import { trackTempDir } from '../helpers/temp-dir.js'
import { runSelfHeal, type SelfHealOpts } from '../../src/ai/orchestrate/self-heal.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import type { saveDraft } from '../../src/studio/server/api/draft.js'

// 计数器走 vi.hoisted（vi.mock 工厂提升后不触外层未初始化绑定——口径同
// test/cache/r0911-e-p3-2-scan-summaries-toctou.test.ts 惯例）
const spies = vi.hoisted(() => ({ openCheckDbAsync: 0, driveToEndAsync: 0 }))

vi.mock('../../src/check/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/check/run.js')>()
  return {
    ...actual,
    openCheckDbAsync: (...args: Parameters<typeof actual.openCheckDbAsync>) => {
      spies.openCheckDbAsync++
      return actual.openCheckDbAsync(...args)
    },
  }
})

vi.mock('../../src/async.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/async.js')>()
  return {
    ...actual,
    driveToEndAsync: async <T>(it: Generator<unknown, T, unknown>): Promise<T> => {
      spies.driveToEndAsync++
      return actual.driveToEndAsync(it)
    },
  }
})

const FM = '---\n章号: 1\n标题: 测试章\n---\n'

/** 长篇书（含 布线 → hasWiring 真，开库段才可达）+ 注入生成/落盘，check 走生产默认实现 */
function setup(): SelfHealOpts {
  const workDir = trackTempDir(makeDualTrackWorkdir())
  const bookRoot = join(workDir, '长篇', LONG_BOOK)
  const driver: StudioDriver = {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(): void {},
  }
  const save: typeof saveDraft = async (root, _chapter, content) => {
    const relPath = '写作/正文/1-测试章.md'
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(join(root, relPath), content, 'utf8')
    return { relPath, docId: 'doc-长篇-1', words: content.length, snapshotted: false }
  }
  return {
    driver,
    mainSession: { id: 'main', cwd: workDir, closed: false },
    userDataPath: trackTempDir(tempUserData()),
    cwd: workDir,
    bookRoot,
    bookName: LONG_BOOK,
    chapter: 1,
    save,
    genFn: async () => FM + '林远踏入宗门，山门古拙，青石阶上苔痕斑驳。',
    maxAttempts: 0, // 首轮机检后即收口（红→escalate / 绿→pass），只验入口不被拖长
  }
}

test('默认机检链：开库走 openCheckDbAsync（worker rebuild）、机检体走 driveToEndAsync（让出驱动）', async () => {
  spies.openCheckDbAsync = 0
  spies.driveToEndAsync = 0

  const result = await runSelfHeal(setup())

  // 编排本身正常收口（红→escalate 保留稿 / 绿→pass），断言只钉异步入口
  expect(result.outcome).not.toBe('aborted')
  expect(result.outcome).not.toBe('failed')
  expect(spies.openCheckDbAsync).toBeGreaterThan(0)
  expect(spies.driveToEndAsync).toBeGreaterThan(0)
}, 60_000)
