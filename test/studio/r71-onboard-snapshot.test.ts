/**
 * R71-9（总七十一轮）onboard-ai 覆盖前快照留底回归：
 * onboard-ai（分钟级）与 onboard-save 闸键不同互不阻挡——AI 完成后 atomicWriteFile
 * 直接覆盖目标文件，作者在生成期间的手改此前静默丢失（该域无版本链）。修复后复用
 * draft 侧 snapshotBeforeOverwrite：覆盖前把旧内容写进 工作区/.版本/<docId>/<ULID>.md。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio。
 */
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = 'R71快照书'
const OLD_CONTENT = '# 作者手改版总纲\n\n主角第三章已死，AI 别再写活他。'
let studio: StudioHarness

/** 递归收集目录下全部文件绝对路径 */
function listFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(p))
    else out.push(p)
  }
  return out
}

beforeAll(async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'clw-r71-onboard-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-r71-onboard-',
    dirs: ['大纲'],
    // 模拟「AI 生成期间作者已手改落盘」的现场（onboard-save 与 onboard-ai 闸键不同互不阻挡）
    files: [{ rel: '大纲/总纲.md', content: OLD_CONTENT }],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: R71快照书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    userDataPath,
    env: { CLWRITING_DRIVER: 'mock' },
  })
})

afterAll(() => studio.close())

describe('R71-9: onboard-ai 覆盖既有文件前快照留底', () => {
  it('AI 产出覆盖前 → .版本 内生成含旧内容的快照 + 响应 snapshotted 留痕', async () => {
    const versionsDir = join(studio.bookRoot, '工作区', '.版本')
    expect(listFiles(versionsDir)).toHaveLength(0) // 前置：无版本链

    const r = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`, { step: 'synopsis' })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; snapshotted?: boolean; content: string }
    expect(body.ok).toBe(true)
    expect(body.snapshotted).toBe(true) // 响应留痕

    // 快照存在且内容 = 作者手改的旧内容（mock 产出与之必然不同）
    const snaps = listFiles(versionsDir)
    expect(snaps.length).toBeGreaterThan(0)
    const snapContents = snaps.map((p) => readFileSync(p, 'utf8'))
    expect(snapContents.some((c) => c.includes(OLD_CONTENT))).toBe(true)

    // 主流程不受影响：目标文件被 AI 产出覆盖
    const after = readFileSync(join(studio.bookRoot, '大纲', '总纲.md'), 'utf8')
    expect(after).toBe(body.content)
    expect(after).not.toContain(OLD_CONTENT)
  })

  it('目标文件不存在（首次生成）→ 无快照、snapshotted 缺省', async () => {
    const r = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`, { step: 'characters' })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; snapshotted?: boolean }
    expect(body.ok).toBe(true)
    expect(body.snapshotted).toBeUndefined()
    expect(existsSync(join(studio.bookRoot, '设定', '名册.md'))).toBe(true)
  })
})

// ── R26-59（二十六轮）：onboard-save 覆盖写前快照留底回归 ──────
// onboard-save 直接 atomicWriteFile 覆盖目标文件，作者对既有文件的手改此前无版本链；
// 修复后与 onboard-ai（R71-9）同口径接入 snapshotBeforeOverwrite（fail-open）。

describe('R26-59: onboard-save 覆盖既有文件前快照留底', () => {
  it('覆盖已有文件 → .版本 新增含旧内容的快照 + 响应 snapshotted 留痕', async () => {
    const versionsDir = join(studio.bookRoot, '工作区', '.版本')
    const count = (dir: string): number => listFiles(dir).length
    const before = count(versionsDir)
    // 前置：世界观.md 尚不存在——先用 onboard-save 创建，再覆盖
    const create = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
      step: 'world',
      content: '作者手写的世界观底稿',
    })
    expect(create.status).toBe(200)
    expect((create.json as { snapshotted?: boolean }).snapshotted).toBeUndefined() // 首次创建不触发
    expect(count(versionsDir)).toBe(before)

    const r = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
      step: 'world',
      content: '保存按钮覆盖后的世界观',
    })
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean; snapshotted?: boolean }).snapshotted).toBe(true) // 响应留痕

    // 快照存在且内容 = 覆盖前的旧内容
    const snaps = listFiles(versionsDir)
    expect(snaps.length).toBeGreaterThan(before)
    expect(snaps.some((p) => readFileSync(p, 'utf8').includes('作者手写的世界观底稿'))).toBe(true)
    // 主流程不受影响：新内容落盘
    expect(readFileSync(join(studio.bookRoot, '设定', '世界观.md'), 'utf8')).toBe('保存按钮覆盖后的世界观')
  })
})
