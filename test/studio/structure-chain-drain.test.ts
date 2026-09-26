/**
 * 阶段 24 章节结构操作（S3/S4）批 B 回归：structure per-book 串行链 + 删书排水收口。
 *
 * 被测面（documents.ts 阶段 24 段）：structure-apply 把合并执行排进 per-book 串行链
 * （链 key=书根，draft.ts draftSaveChains / files.ts filePutChains 同款范式，链内临界
 * 段首行 bookMovedFailure 单源重验）；books.ts 删书排水段第 5 调用
 * drainStructureChainsUnder 兜「在途链跨墓地 rename 按旧书根重建幽灵目录树」。
 *
 * 断言口径裁决（按实测实现锚定，draft-save-drain-chaining 三段式的 structure 变体）：
 * structure-apply 全程持 acquireTaskGate(name,'structure')（S4 互斥矩阵接线，
 * 'structure' 已入 KNOWN_ACTIONS），而 draft-save 无闸——故删书在途 draft-save 场景
 * 由 drainDraftSaveChainsUnder 等待收尾（draft 测试锁「两 promise 均未 settle」），
 * 在途 structure-apply 场景则在更早的删书入口 busyGate（heldTaskGatesFor 全集）即
 * 409 拒收（含 'structure' 字样），删书绝不推进墓地 rename；链收尾、闸释放后删书
 * 才放行。drainStructureChainsUnder 位于闸后作纵深兜底（闸释放与链键自清理仅隔微
 * 任务，公共端点无法确定性触达 drain 等待窗）——本测试锁端到端不变量：在途链期间
 * 书目录原样在位（零幽灵）→ 合并在活书内落盘 → 删书 200 → 迟到 apply 404 不复活。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { acquireCrossProcessLockAsync } from '../../src/fs/cross-process-lock.js'
import { __structureChainKeysForTest } from '../../src/studio/server/api/documents.js'
import { encodeDocDirName } from '../../src/document/version.js'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = '结构链排水书'
let studio: StudioHarness

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-struct-drain-',
    dirs: ['写作/正文/第一卷', '工作区'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 结构链排水书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

afterAll(() => studio.close())

describe('阶段 24（S3/S4）: structure 串行链与删书排水', () => {
  it('在途 structure-apply（目标章 save 锁被占）在链上可见；删书入口被拦下等待其收尾，零幽灵残留', async () => {
    // 建两章（fm 必须含 章号——readChapterState 的章文档判定口径）
    const mk1 = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents`, {
      relPath: '写作/正文/第一卷/0001-第1章.md',
      content: '---\n章号: 1\n标题: 第1章\n---\n\n第一章正文，足够成段的文字。',
    })
    expect(mk1.status).toBe(201)
    const mk2 = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents`, {
      relPath: '写作/正文/第一卷/0002-第2章.md',
      content: '---\n章号: 2\n标题: 第2章\n---\n\n第二章正文，足够成段的文字。',
    })
    expect(mk2.status).toBe(201)
    const targetDocId = (mk1.json as { docId: string }).docId
    const sourceDocId = (mk2.json as { docId: string }).docId
    expect(targetDocId.startsWith('doc_')).toBe(true) // canonical 前缀，无冒号

    // 干跑取指纹（目标=第1章，源=第2章）
    const planRes = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${targetDocId}/structure-plan`,
      { op: 'merge', sourceDocId },
    )
    expect(planRes.status).toBe(200)
    expect((planRes.json as { ok: boolean }).ok).toBe(true)
    const planHash = (planRes.json as { plan: { planHash: string } }).plan.planHash

    // 占住目标章 per-doc 保存锁（executeSave 同键）→ apply 悬停在链单元内的 svc.save
    const jPath = join(studio.bookRoot, '工作区', '.journal', `${encodeDocDirName(targetDocId)}.jsonl`)
    const release = await acquireCrossProcessLockAsync(`${jPath}.save.lock`, 100)
    expect(release).not.toBeNull()

    let applySettled = false
    const applyP = studio
      .req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${targetDocId}/structure-apply`, {
        op: 'merge',
        sourceDocId,
        planHash,
      })
      .then((r) => {
        applySettled = true
        return r
      })
    // 链注册可见（__draftSaveChainKeysForTest 同款观测面）
    await vi.waitFor(() => {
      expect([...__structureChainKeysForTest()]).toContain(studio.bookRoot)
    })

    let delSettled = false
    const delP = studio.req('DELETE', `/api/books/${encodeURIComponent(BOOK)}`).then((r) => {
      delSettled = true
      return r
    })
    // win 合并批复核批（2026-09-13）：400ms 固定睡眠改 vi.waitFor（同文件 :85 惯例）——
    // 只等 DELETE 响应返回这一事实，不再假设墙钟 400ms 内必达（慢机 flake 源）；
    // 下方 applySettled===false 由 save 锁在持保证，无时序依赖，不受此改影响。
    await vi.waitFor(() => {
      expect(delSettled).toBe(true)
    })
    // 删书不推进墓地 rename：在途 apply 持 'structure' 任务闸（S4 互斥矩阵，
    // KNOWN_ACTIONS 全集），删书入口 busyGate 即 409 拒收——排水段第 5 个
    // drainStructureChainsUnder 在闸后作纵深兜底。apply 仍在链上悬置（save 锁等待处）。
    expect(applySettled).toBe(false)
    expect(delSettled).toBe(true)
    const delEarly = await delP
    expect(delEarly.status).toBe(409)
    expect((delEarly.json as { code: string }).code).toBe('BUSY')
    expect(String((delEarly.json as { error: string }).error)).toContain('structure')
    // 书目录原样在位（未被搬进墓地；链任务继续在还活着的书里跑）
    expect(existsSync(studio.bookRoot)).toBe(true)

    release!()
    const applyRes = await applyP
    expect(applyRes.status).toBe(200) // 删书未推进，合并在活书里落盘
    expect(applySettled).toBe(true)
    expect((applyRes.json as { ok: boolean }).ok).toBe(true)
    expect((applyRes.json as { mergedInto: number[] }).mergedInto).toEqual([2])
    // 链收尾自清理（settle 后链键移除）
    await vi.waitFor(() => {
      expect([...__structureChainKeysForTest()]).not.toContain(studio.bookRoot)
    })
    // 目标章 fm 折叠 并入: [2]（读文件断言）；源章文件已软删、不在正文区
    expect(readFileSync(join(studio.bookRoot, '写作/正文/第一卷/0001-第1章.md'), 'utf8')).toContain('并入: [2]')
    expect(existsSync(join(studio.bookRoot, '写作/正文/第一卷/0002-第2章.md'))).toBe(false)

    // 链排空 + 闸释放后删书放行：200；书目录入墓地，workDir 顶层无旧书路径残留（零幽灵）
    const delRes = await studio.req('DELETE', `/api/books/${encodeURIComponent(BOOK)}`)
    expect(delRes.status).toBe(200)
    expect(existsSync(studio.bookRoot)).toBe(false)
    expect(existsSync(join(studio.workDir, BOOK))).toBe(false)
  })

  it('书已删后迟到 structure-apply → 入口 404（resolveBook 守卫，不写旧键）', async () => {
    const r = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_late/structure-apply`, {
      op: 'merge',
      sourceDocId: 'doc_gone',
      planHash: 'p',
    })
    expect(r.status).toBe(404)
    expect(existsSync(join(studio.workDir, BOOK))).toBe(false)
  })
})
