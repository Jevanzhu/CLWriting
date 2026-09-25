/**
 * 复审-0913-合并批 P3-5（登记备查 → 2026-09-15 机械批处置）回归锚：rag rebuild
 * 编排互斥补向。
 *
 * 修复前 rebuild（resetIndexFirst=true 清库）只持自身 'rag-build' 闸、不查
 * orchestrationBusyFor——与 prune 端点（R0912-ds41 P3-9 已补）同形不对称：在途
 * 编排写索引行可被清库打断。修复后照 snapshots.ts prune 端点精确形态补齐（先查
 * 编排闸再占自身闸，409 code/error 与同族端点逐字节一致）。占闸手法与断言面 =
 * r0912-ds41-prune-gate 同款（__setSpawnRunning 夹具）。无平台门，三平台同跑。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { __setSpawnRunning } from '../../src/ai/orchestrate/spawn-registry.js'
import { isTaskGateHeld } from '../../src/studio/server/api/task-gate.js'

const BOOK = 'R0915重建闸书'
let studio: StudioHarness
const REBUILD_PATH = `/api/books/${encodeURIComponent(BOOK)}/rag/rebuild`

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-r0915-rebuild-gate-',
    env: { CLWRITING_DRIVER: 'mock' },
    // book.yaml title 必须与书名一致：启动段 repairBooks 以 title 覆写登记名
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: R0915重建闸书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    dirs: ['工作区'],
  })
})

afterAll(async () => {
  __setSpawnRunning(BOOK, false) // 兜底清理，防注入态泄漏到同进程其它用例（r75 先例）
  await studio.close()
})

describe('复审-0913-合并批 P3-5：rag rebuild 编排互斥', () => {
  it('生成类在途（手动写稿 spawn）→ 409 BUSY（文案与同族端点逐字节一致），且不占自身任务闸', async () => {
    __setSpawnRunning(BOOK, true)
    const busy = await studio.req('POST', REBUILD_PATH)
    expect(busy.status).toBe(409)
    expect((busy.json as { code: string }).code).toBe('BUSY')
    // R0916-7-P3-12：忙闸文案单源化——矩阵 spawn 信号句 + generate 意图尾句，逐字节钉死
    expect((busy.json as { error: string }).error).toBe('本书正在手动写稿，先等它跑完或中断再生成')
    // 409 走编排闸前置分支：自身 action 闸未被占持（不残留死闸挡后续请求）
    expect(isTaskGateHeld(BOOK, 'rag-build')).toBe(false)
    __setSpawnRunning(BOOK, false) // 用例内即时解除（afterAll 兜底为辅），防泄漏到下一用例
  })

  it('无在途 → 编排预检放行，进入 startRagBuild 前置校验（未启用 RAG → 400 BAD_INPUT 原文案）', async () => {
    const r = await studio.req('POST', REBUILD_PATH)
    expect(r.status).toBe(400)
    expect((r.json as { code: string }).code).toBe('BAD_INPUT')
    expect((r.json as { error: string }).error).toBe('知识检索未启用：请在「设置 · 本书」页开启')
  })
})
