/**
 * R30-20（三十轮）回归：snapshotPolicy 的 global.json stat 缓存。
 *
 * 每次 save 原先都 existsSync+readFileSync global.json；修后 statSync（mtimeMs+size）
 * 不变则复用上次解析结果。测法（行为级，不 mock fs）：
 * 1. 缓存命中不重读——把 global.json 改写为**等长**内容（snapMaxCount 2→9）并把
 *    mtime 回拨到缓存时的值：stat 键未变 → 命中缓存 → 仍按旧值 2 修剪；若缓存失效
 *    重读则会按 9 保留更多版本；
 * 2. 失效取新值——正常改写 global.json（mtime 变化）→ 下一次 save 即按新值 1 修剪
 *    （「手工编辑 global.json 后下次 save 生效」语义）。
 *
 * 版本量通过 restore origin 的强制留底堆叠（force 跳过节流，内容逐次不同不被去重）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { listVersions, VERSIONS_DIR_NAME } from '../../src/document/version.js'
import { computeRevision } from '../../src/document/revision.js'

interface Ctx {
  root: string
  userData: string
  svc: DocumentService
  rel: string
  globalJson: string
  versionsDir: string
}

function setup(): Ctx {
  const root = mkdtempSync(join(tmpdir(), 'r30-policy-book-'))
  const userData = mkdtempSync(join(tmpdir(), 'r30-policy-ud-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n\n第一版\n', 'utf-8')
  const globalJson = join(userData, 'global.json')
  writeFileSync(globalJson, '{"snapMaxCount":2,"snapMaxDays":90}')
  const svc = new DocumentService({ bookRoot: root, userDataPath: userData })
  return { root, userData, svc, rel: '写作/正文/0001-开篇.md', globalJson, versionsDir: join(root, '工作区', VERSIONS_DIR_NAME) }
}

/** 以 restore origin（强制留底，跳过节流）覆盖保存一次，内容各不相同。 */
async function restoreSave(ctx: Ctx, content: string): Promise<void> {
  const abs = join(ctx.root, ...ctx.rel.split('/'))
  const r = await ctx.svc.save('doc_policy', ctx.rel, {
    content,
    expectedRevision: computeRevision(abs),
    operationId: `op-${content}`,
    origin: 'restore',
  })
  expect(r.ok).toBe(true)
}

test('R30-20: stat 键未变 → 命中缓存不重读（等长改写 + mtime 回拨后仍按旧策略修剪）', async () => {
  const ctx = setup()
  try {
    // 堆到 maxCount=2 的封顶态：3 次强制留底 → prune 只留最新 2 版
    await restoreSave(ctx, '第二版\n')
    await restoreSave(ctx, '第三版\n')
    await restoreSave(ctx, '第四版\n')
    expect(listVersions(ctx.versionsDir, 'doc_policy').length).toBe(2)

    // 等长改写 global.json（2→9）+ mtime 回拨：stat 键（floor(mtimeMs)+size）不变
    const st = statSync(ctx.globalJson)
    writeFileSync(ctx.globalJson, '{"snapMaxCount":9,"snapMaxDays":90}')
    utimesSync(ctx.globalJson, new Date(st.atimeMs), new Date(st.mtimeMs))
    const st2 = statSync(ctx.globalJson)
    expect(st2.size).toBe(st.size)
    expect(Math.floor(st2.mtimeMs)).toBe(Math.floor(st.mtimeMs))

    // 第 4 次留底：缓存命中 → 仍按 snapMaxCount=2 修剪（若重读得 9 则会留 3 版）
    await restoreSave(ctx, '第五版\n')
    expect(listVersions(ctx.versionsDir, 'doc_policy').length).toBe(2)
  } finally {
    rmSync(ctx.root, { recursive: true, force: true })
    rmSync(ctx.userData, { recursive: true, force: true })
  }
})

test('R30-20: global.json 变更（mtime/size 变化）→ 缓存失效取新值，下次 save 即生效', async () => {
  const ctx = setup()
  try {
    await restoreSave(ctx, '第二版\n')
    await restoreSave(ctx, '第三版\n')
    expect(listVersions(ctx.versionsDir, 'doc_policy').length).toBe(2)
    // 手工编辑 global.json：snapMaxCount 2→1（正常写入，mtime 变化）
    writeFileSync(ctx.globalJson, '{"snapMaxCount":1,"snapMaxDays":90}')
    await restoreSave(ctx, '第四版\n')
    expect(listVersions(ctx.versionsDir, 'doc_policy').length).toBe(1)
  } finally {
    rmSync(ctx.root, { recursive: true, force: true })
    rmSync(ctx.userData, { recursive: true, force: true })
  }
})
