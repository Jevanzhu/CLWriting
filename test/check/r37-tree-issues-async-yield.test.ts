/**
 * R37-3（三十七轮批 D）回归：collectTreeIssuesAsync 异步孪生。
 *
 * 修复前：/tree-issues 聚合在 HTTP 路径同步遍历全书（rebuild + 全章扫描 + 逐章机检），
 * 大书单请求秒级冻结事件循环（Electron 主进程内嵌单进程服务 = 桌面整体卡死）；既有
 * 5s TTL 缓存只降频不减峰。修复：实现体收进生成器核心（collectTreeIssuesCore，逻辑
 * 单源），同步版驱到尾（行为与修复前逐位一致——存量回归测试全走此口径零感知），HTTP
 * 路径改走 async 孪生：每 TREE_ISSUES_YIELD_EVERY（25）章悬停点 await setImmediate。
 *
 * 用例：
 * 1. 等价性：同一本书同步版与 async 版聚合结果 deep equal（同书双跑：async 跑在同步
 *    版落下的章级缓存之上，冷/热缓存两条路径结果一致性一并守护）；另一本独立书冷启动
 *    直接走 async 版，红点数与降级标志符合同步口径。
 * 2. 心跳插队：聚合未落定期间 setImmediate 回调能插队执行（事件循环可响应）——断言
 *    「至少一次」，不脆断言次数（时序依赖块大小常数的精确次数断言易碎）。
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectTreeIssues, collectTreeIssuesAsync } from '../../src/check/run.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 造一本 N 章正文的书（带布线 + 每章禁词「玉佩」制造确定红源——口径同
 *  tree-issues-scan-count.test.ts 的 makeBook，证逐章 checkWithDb 真的跑了）。 */
function makeBook(chapterCount: number): string {
  const root = mkdtempTracked(join(tmpdir(), 'r37-tree-async-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= chapterCount; no++) {
    const pad = String(no).padStart(3, '0')
    writeFileSync(
      join(root, '写作', '正文', `${pad}-第${no}章.md`),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的雨夜里，玉佩，连响了三下。\n`,
      'utf-8',
    )
    upsertEntry(m, {
      id: generateDocId(),
      nodeType: 'document',
      path: `写作/正文/${pad}-第${no}章.md`,
      parentId: null,
    })
  }
  writeManifest(manifestPath, m)
  return root
}

describe('R37-3 collectTreeIssuesAsync 异步孪生', () => {
  it('同一本书：async 版结果与同步版 deep equal（同步版先跑落下章级缓存，async 跑热缓存路径）', async () => {
    const root = makeBook(60)
    const sync = collectTreeIssues(root, () => undefined)
    expect(Object.keys(sync.issues).length).toBe(60) // 每章命中禁词「玉佩」→ 全红
    const asyncResult = await collectTreeIssuesAsync(root, () => undefined)
    expect(asyncResult).toEqual(sync)
  })

  it('独立书冷启动直接走 async 版：红点齐全、降级标志为零', async () => {
    const root = makeBook(60)
    const r = await collectTreeIssuesAsync(root, () => undefined)
    expect(Object.keys(r.issues).length).toBe(60)
    expect(r.rebuildFailed).toBe(false)
    expect(r.leadsBookDegraded).toBe(false)
    expect(r.chaptersDegraded).toBe(0)
    expect(r.chaptersParseDegraded).toBe(0)
  })

  it('聚合未落定期间事件循环可响应：setImmediate 心跳至少插队一次', async () => {
    const root = makeBook(60)
    let beats = 0
    const probe = (): void => {
      if (beats < 64) {
        beats++
        setImmediate(probe) // 心跳链续期（cap 防挂尾泄漏）
      }
    }
    const p = collectTreeIssuesAsync(root, () => undefined)
    // 此刻聚合已同步跑完首个 25 章块、在悬停点排队让出——心跳排在首个让出之后，
    // 生成器续跑前可插队（同步实现下 beats 恒为 0：await 前无任何让出窗口）
    setImmediate(probe)
    const r = await p
    expect(Object.keys(r.issues).length).toBe(60)
    expect(beats).toBeGreaterThan(0) // 「至少一次」：不脆断言次数
  })
})
