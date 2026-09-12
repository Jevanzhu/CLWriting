/**
 * 重评-0912-2 P2-4（2026-09-12 全量重评修复批）回归：收割异步链同步阻塞同族收尾。
 *
 * 背景：harvestStyleCandidatesAsync 源1 逐 tracked doc 残留两处同步阻塞——① 裸
 * readFileSync 整读章正文（不走缓存、无让出，大书冷缓存冻结 HTTP 事件循环数百 ms
 * 至秒级）；② collectDocSignalsAsync 内 compareVersions 为 O(P²) 段对矩阵纯同步
 * CPU 计算（style-compare 无让出）。R44-13 已把同链同步 spawnSync 清零，本批补齐
 * 同族纪律：① → md-text-cache 指纹缓存异步读 readMdTextCachedAsync（缓存面=原始
 * 文本，与 readFileSync utf-8 逐位等价；消失/读失败 → null 映射原 catch { continue }
 * 跳过口径），② → 逐 doc yieldToEventLoop（src/async.ts 单源）。
 *
 * 覆盖：
 * - 读取走缓存（隔离源1）：tracked doc 置于 写作/正文 之外（设定集），源2
 *   scanChaptersAsync 零章不读盘、readBaseline/铁律为裸 readFileSync 不入缓存——
 *   清空指纹表后异步收割，缓存驻留 >=1 只能来自源1 的改道读（修前裸
 *   readFileSync 零缓存驻留，本用例红）
 * - 口径不变：缓存未命中/命中两轮收割（间抹候选箱），候选内容逐位一致——
 *   读取改道不换 harvest 输出口径
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harvestStyleCandidatesAsync } from '../../src/process/style-harvest.js'
import { __mdTextCacheTestHooks } from '../../src/fs/md-text-cache.js'
import { recordAiVersion } from '../../src/git/ai-track.js'
import { legacyId } from '../../src/document/stable-id.js'
import { readCandidates, CANDIDATES_DIR } from '../../src/format/style-candidate.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { execFileSync } from 'node:child_process'

let root = ''
beforeEach(() => {
  root = mkdtempTracked(join(tmpdir(), 'clw-r0912-2-harvest-'))
  __mdTextCacheTestHooks.clear()
})
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  __mdTextCacheTestHooks.clear()
})

/** git init + 身份配置（execFileSync 直连，不经过被测执行器） */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
}

const AI_TEXT = 'AI 生成的第一段草稿，用语平淡而机械，节奏均匀没有任何起伏，像是从模板里抄出来的句子。'
const AUTHOR_BODY =
  '雨点砸在铁皮屋檐上，他数到第七声才推门，门轴的锈味混着煤烟扑了满脸，柜台后的老人头也不抬，只把一枚铜纽扣推过桌面。'

/** 最小书骨架（书名文件 + 文风幕后目录 + 空正文目录——源2 零章不读盘） */
function makeBookSkeleton(dir: string): void {
  mkdirSync(join(dir, '写作', '正文'), { recursive: true })
  mkdirSync(join(dir, '文风'), { recursive: true })
  writeFileSync(join(dir, 'book.yaml'), 'spec_version: 1\nkind: short\nbook:\n  title: 异步收割\n')
  writeFileSync(join(dir, '文风', '文风铁律.md'), '# 文风铁律\n- 正文纯文本\n')
  initGitRepo(dir)
}

describe('重评-0912-2 P2-4: harvestStyleCandidatesAsync 源1 读取改道与口径', () => {
  it('源1 读取走 md-text-cache 指纹缓存（设定集 tracked doc 隔离源2，修前裸 readFileSync 本用例红）', async () => {
    makeBookSkeleton(root)
    // tracked doc 在 写作/正文 之外：树反查得到路径，源1 独读；正文目录留空（源2 零章）
    const rel = '设定/世界观.md'
    mkdirSync(join(root, '设定'), { recursive: true })
    writeFileSync(join(root, rel), `---\n标题: 世界观\n---\n\n${AUTHOR_BODY}`)
    recordAiVersion(root, legacyId(rel), AI_TEXT)
    expect(__mdTextCacheTestHooks.size()).toBe(0) // recordAiVersion 为写侧，不入指纹表

    const r = await harvestStyleCandidatesAsync(root, 'short', '2026-09-04')

    expect(r.created.length).toBeGreaterThanOrEqual(1) // 非平凡臂：轨迹确实产候选
    expect(__mdTextCacheTestHooks.size()).toBeGreaterThanOrEqual(1) // 修复点：源1 整读落入指纹缓存
  })

  it('缓存未命中/命中两轮收割产物逐位一致（读取改道不换输出口径）', async () => {
    makeBookSkeleton(root)
    writeFileSync(
      join(root, '写作', '正文', '001-雨夜.md'),
      `---\n章号: 1\n标题: 雨夜\n---\n\n${AUTHOR_BODY}`,
    )
    recordAiVersion(root, legacyId('写作/正文/001-雨夜.md'), AI_TEXT)

    // 机器可复现字段比对（created 含 ulid 文件名，两轮必然不同——同 R44-13 口径）
    const pick = (): string[] =>
      readCandidates(join(root, CANDIDATES_DIR)).candidates
        .map((c) =>
          JSON.stringify([c.类型, c.场景, c.来源, c.正文, c.状态, c.创建, c.章号, c.相似度, c.AI版]),
        )
        .sort()

    const r1 = await harvestStyleCandidatesAsync(root, 'short', '2026-09-04') // 未命中路径
    const pick1 = pick()
    expect(r1.created.length).toBeGreaterThanOrEqual(1)

    rmSync(join(root, CANDIDATES_DIR), { recursive: true, force: true }) // 抹候选箱防查重闸吞第二轮
    const r2 = await harvestStyleCandidatesAsync(root, 'short', '2026-09-04') // 命中路径

    expect(r2.created).toHaveLength(r1.created.length)
    expect(r2.skipped).toBe(r1.skipped)
    expect(pick()).toEqual(pick1)
  })
})
