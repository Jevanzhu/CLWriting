/**
 * R0912-ds41（重评-deepseek-v4.1-flash P3-9）回归锚：versions-prune 编排互斥补向。
 *
 * 修复前矩阵单向不对称：prune 只 acquireTaskGate('versions-prune')（同 action 重入
 * + 删书/改名 busyGate 反向枚举面），不查 orchestrationBusyFor——写稿系编排（self-
 * heal/对话/手动写稿/后台收尾）在途放行 prune，收尾快照与批量清理并发互踩。修复后
 * 照 analysis.ts analyze 端点精确形态补齐（先查编排闸再占自身 action 闸，409 code/
 * error 与同族端点逐字节一致）。占闸手法用 __setSpawnRunning 测试夹具（先例
 * orchestrator-mutex-gates / r75-relations-mine-mutex）。无平台门，三平台同跑。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { __setSpawnRunning } from '../../src/ai/orchestrate/spawn-registry.js'
import { isTaskGateHeld } from '../../src/studio/server/api/task-gate.js'

const BOOK = 'R0912清理闸书'
let studio: StudioHarness
const PRUNE_PATH = `/api/books/${encodeURIComponent(BOOK)}/versions/prune`

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-r0912-ds41-prune-',
    env: { CLWRITING_DRIVER: 'mock' },
    // book.yaml title 必须与书名一致：启动段 repairBooks 以 title 覆写登记名
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: R0912清理闸书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    dirs: ['工作区/.版本'],
  })
})

afterAll(async () => {
  __setSpawnRunning(BOOK, false) // 兜底清理，防注入态泄漏到同进程其它用例（r75 先例）
  await studio.close()
})

describe('R0912-ds41：versions-prune 编排互斥', () => {
  it('生成类在途（手动写稿 spawn）→ 409 BUSY（文案与同族端点逐字节一致），且不占自身任务闸', async () => {
    __setSpawnRunning(BOOK, true)
    const busy = await studio.req('POST', PRUNE_PATH)
    expect(busy.status).toBe(409)
    expect((busy.json as { code: string }).code).toBe('BUSY')
    // orchestrationBusyFor 的 spawn 分支人话文案（task-gate.ts 单源，逐字节钉死）
    expect((busy.json as { error: string }).error).toBe('本书手动写稿进行中，等它完成后再生成（防写稿上下文被覆盖写混态）')
    // 409 走编排闸前置分支：自身 action 闸未被占持（不残留死闸挡后续请求）
    expect(isTaskGateHeld(BOOK, 'versions-prune')).toBe(false)
    __setSpawnRunning(BOOK, false) // 用例内即时解除（afterAll 兜底为辅），防泄漏到下一用例
  })

  it('无在途 → 正常 prune 成功（空 .版本 目录 → removed 0）', async () => {
    const ok = await studio.req('POST', PRUNE_PATH)
    expect(ok.status).toBe(200)
    expect(ok.json).toEqual({ ok: true, removed: 0 })
  })
})
