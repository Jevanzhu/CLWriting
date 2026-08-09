/**
 * M1 草稿覆写留底 + M3 docId 返回单测（最小修缮方案）。
 *
 * snapshotBeforeOverwrite 纯函数：覆写前检测 + force 快照。
 * draft-save 端点集成：响应 {docId, snapshotted} 契约（前端「存草稿并编辑」跳转依赖）。
 * 范式同 kind-branches：临时目录 fixture，不调大模型。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotBeforeOverwrite } from '../../src/studio/server/api/draft.js'
import { startServer } from '../../src/studio/server/index.js'
import { legacyId, generateDocId } from '../../src/document/stable-id.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'

let root = ''
const REL = '写作/正文/0042-测试章.md'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-draft-m1-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 列指定 docId 目录下的快照文件 */
function snapshotFiles(docId: string): string[] {
  const dir = join(root, '工作区', '.版本', docId)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
}

describe('snapshotBeforeOverwrite(M1 覆写留底)', () => {
  it('已有草稿且内容不同 → 留快照（旧内容 + origin draft-overwrite）', () => {
    writeFileSync(join(root, REL), '旧稿：他把烟摁灭。', 'utf8')
    const id = snapshotBeforeOverwrite(root, REL, '新稿：重生成的内容。')
    expect(id).not.toBeNull()
    // 未登记清单 → 文件名派生键
    const files = snapshotFiles('0042-测试章')
    expect(files).toHaveLength(1)
    const snap = readFileSync(join(root, '工作区', '.版本', '0042-测试章', files[0]!), 'utf8')
    expect(snap).toContain('旧稿：他把烟摁灭。')
    expect(snap).toContain('来源: draft-overwrite')
    expect(snap).not.toContain('新稿')
  })

  it('内容相同 → 不留', () => {
    writeFileSync(join(root, REL), '同一份内容', 'utf8')
    expect(snapshotBeforeOverwrite(root, REL, '同一份内容')).toBeNull()
    expect(snapshotFiles('0042-测试章')).toHaveLength(0)
  })

  it('目标文件不存在（首次生成）→ 不留', () => {
    expect(snapshotBeforeOverwrite(root, REL, '首稿')).toBeNull()
    expect(existsSync(join(root, '工作区', '.版本'))).toBe(false)
  })

  it('清单已登记 → 快照落真 docId 目录（与编辑器历史同目录可恢复）', () => {
    writeFileSync(join(root, REL), '旧稿', 'utf8')
    mkdirSync(join(root, '项目'), { recursive: true })
    const lines = [
      JSON.stringify({ version: 1, type: 'header' }),
      JSON.stringify({ id: 'doc-abc123', nodeType: 'document', path: REL, parentId: null, status: 'draft' }),
    ]
    writeFileSync(join(root, '项目', '文档清单.jsonl'), lines.join('\n') + '\n', 'utf8')
    const id = snapshotBeforeOverwrite(root, REL, '新稿')
    expect(id).not.toBeNull()
    expect(snapshotFiles('doc-abc123')).toHaveLength(1)
    expect(snapshotFiles('0042-测试章')).toHaveLength(0)
  })

  it('连续覆写 → 每次都留（force 绕节流）', () => {
    writeFileSync(join(root, REL), '版本1', 'utf8')
    expect(snapshotBeforeOverwrite(root, REL, '版本2')).not.toBeNull()
    writeFileSync(join(root, REL), '版本2', 'utf8')
    expect(snapshotBeforeOverwrite(root, REL, '版本3')).not.toBeNull()
    expect(snapshotFiles('0042-测试章')).toHaveLength(2)
  })

  it('短篇固定名 001-标题.md 同样受保护', () => {
    const shortRel = '写作/正文/001-短篇.md'
    writeFileSync(join(root, shortRel), '第1章草稿', 'utf8')
    const id = snapshotBeforeOverwrite(root, shortRel, '第2章草稿盖过来')
    expect(id).not.toBeNull()
    const files = snapshotFiles('001-短篇')
    expect(files).toHaveLength(1)
    expect(readFileSync(join(root, '工作区', '.版本', '001-短篇', files[0]!), 'utf8')).toContain('第1章草稿')
  })
})

// ---- 端点集成：POST /draft-save 响应契约（M3 存草稿并编辑） ----

const BOOK = '草稿测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function postDraft(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/draft-save`, {
    method: 'POST',
    headers: { 'x-studio-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }))
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-draft-api-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 草稿测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf8',
  )
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('POST /draft-save 响应契约（M3）', () => {
  it('新草稿：docId 回落 legacyId(relPath)（与树扫盘一致）+ snapshotted=false', async () => {
    const r = await postDraft({ chapter: 2, content: '第一版生成正文。' })
    expect(r.status).toBe(200)
    expect(r.json['ok']).toBe(true)
    // 无 frontmatter → resolveDraftPath 用默认标题「第2章」+ 默认卷「第一卷」
    expect(r.json['path']).toBe('写作/正文/第一卷/2-第2章.md')
    expect(r.json['docId']).toBe(legacyId('写作/正文/第一卷/2-第2章.md'))
    expect(r.json['snapshotted']).toBe(false)
  })

  it('覆写不同内容：snapshotted=true（M1 留底生效）', async () => {
    const r = await postDraft({ chapter: 2, content: '第二版生成正文，盖掉第一版。' })
    expect(r.status).toBe(200)
    expect(r.json['snapshotted']).toBe(true)
    // 快照真实落盘
    const snapDir = join(workDir, BOOK, '工作区', '.版本')
    expect(existsSync(snapDir)).toBe(true)
  })

  it('清单已登记：docId 返回真 ID', async () => {
    const manifestPath = join(workDir, BOOK, '项目', '文档清单.jsonl')
    mkdirSync(join(workDir, BOOK, '项目'), { recursive: true })
    const m = readManifest(manifestPath)
    const realId = generateDocId()
    // 登记正文区路径（draft-save 走 resolveDraftPath，长篇默认卷 第一卷）
    upsertEntry(m, { id: realId, nodeType: 'document', path: '写作/正文/第一卷/3-第3章.md', parentId: null })
    writeManifest(manifestPath, m)
    const r = await postDraft({ chapter: 3, content: '登记过的草稿内容。' })
    expect(r.status).toBe(200)
    expect(r.json['docId']).toBe(realId)
  })
})
