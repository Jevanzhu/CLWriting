/**
 * R74-4（二十二轮）：outline 覆盖前快照留底回归（对齐 R71-9 onboard 先例）。
 *
 * outline 生成是分钟级窗口，作者可经 PUT /file 手改 工作区/细纲.md（files.ts
 * WORKDIR_EDITABLE 白名单恰含此文件，/file 与 outline 闸互不相查）——生成完成的
 * atomicWriteFile 覆盖写此前把手改静默丢失（细纲域无版本链）。修复后落盘前
 * snapshotBeforeOverwrite 留底（标签 outline-overwrite → 快照 fm「来源:」行），
 * fail-open：快照失败不阻断主流程（log.warn 留痕）。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio。
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = 'R74细纲快照书'
const OLD_CONTENT = '# 作者手改版细纲\n\n本章改成双线并行，别按旧纲写。'
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
  const userDataPath = mkdtempSync(join(tmpdir(), 'clw-r74-outline-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-r74-outline-',
    dirs: ['工作区', '写作/正文'],
    // 模拟「outline 生成期间作者已手改落盘」的现场（PUT /file 白名单含 细纲.md，
    // 与 outline 闸互不相查）
    files: [{ rel: '工作区/细纲.md', content: OLD_CONTENT }],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: R74细纲快照书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    userDataPath,
    env: { CLWRITING_DRIVER: 'mock' },
  })
})

afterAll(() => studio.close())

describe('R74-4: outline 覆盖既有 细纲.md 前快照留底', () => {
  it('AI 产出覆盖前 → .版本 内生成含旧内容、标签 outline-overwrite 的快照', async () => {
    const versionsDir = join(studio.bookRoot, '工作区', '.版本')
    expect(listFiles(versionsDir)).toHaveLength(0) // 前置：无版本链

    const r = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/outline`, { chapter: 1 })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean }
    expect(body.ok).toBe(true)

    // 快照存在且内容 = 作者手改的旧内容；标签经 fm「来源:」行可回溯（mock 产出必不相同）
    const snaps = listFiles(versionsDir)
    expect(snaps.length).toBeGreaterThan(0)
    const hit = snaps.map((p) => readFileSync(p, 'utf8')).find((c) => c.includes(OLD_CONTENT))
    expect(hit).toBeDefined()
    expect(hit).toContain('来源: outline-overwrite')

    // 主流程不受影响：细纲被 AI 产出覆盖（fm 前置章号 + mock 文本）
    const after = readFileSync(join(studio.bookRoot, '工作区', '细纲.md'), 'utf8')
    expect(after).toContain('章号: 1')
    expect(after).toContain('mock 细纲')
    expect(after).not.toContain(OLD_CONTENT)
  })

  it('细纲不存在（首次生成）→ 无快照（留底只在覆盖既有文件时发生）', async () => {
    rmSync(join(studio.bookRoot, '工作区', '细纲.md'))
    const versionsDir = join(studio.bookRoot, '工作区', '.版本')
    const before = listFiles(versionsDir).length
    const r = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/outline`, { chapter: 2 })
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean }).ok).toBe(true)
    expect(existsSync(join(studio.bookRoot, '工作区', '细纲.md'))).toBe(true)
    expect(listFiles(versionsDir)).toHaveLength(before) // 首次生成零留底
  })
})
