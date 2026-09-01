/**
 * 文风 API 端点集成测试（文风系统重整 S6）：
 * 条目 CRUD / 首读自动迁移 / 候选箱确认忽略 / 收割闭环（源1 轨迹→候选）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServerSafe } from '../helpers/safe-port.js'
import { legacyId } from '../../src/document/stable-id.js'
import { recordAiVersion } from '../../src/git/ai-track.js'
import { git } from '../../src/git/exec.js'

const BOOK = '文风书'

let workDir = ''
let bookRoot = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function api(path: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}${path}`, {
    ...init,
    headers: { 'x-studio-token': token, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }))
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-style-api-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文', '第一卷'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 文风书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf8',
  )
  // 旧文风资产（首读 GET entries 应触发迁移）
  mkdirSync(join(bookRoot, '文风', '样章库', '战斗'), { recursive: true })
  writeFileSync(
    join(bookRoot, '文风', '样章库', '战斗', '战斗-001.md'),
    '---\n场景: 战斗\n来源: 作者原作\n---\n刀光没入雪雾。',
    'utf8',
  )
  // git 仓库（源1 轨迹用）
  git(['init'], bookRoot)

  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('条目库端点', () => {
  it('GET entries 首读触发迁移（旧样章入库）；二读幂等 migration=null', async () => {
    const first = await api('/style/entries')
    expect(first.status).toBe(200)
    const mig = first.json['migration'] as Record<string, unknown> | null
    expect(mig).not.toBeNull()
    expect(mig!['migrated']).toBe(1)
    const entries = first.json['entries'] as Record<string, unknown>[]
    expect(entries.some((e) => e['正文'] === '刀光没入雪雾。' && e['类型'] === '样章')).toBe(true)
    // _path 相对化
    expect(String(entries[0]!['_path'])).toMatch(/^文风\/条目\//)
    expect(existsSync(join(bookRoot, '文风', '样章库', '战斗', '战斗-001.md'))).toBe(false)

    const second = await api('/style/entries')
    expect(second.json['migration']).toBeNull()
  })

  it('POST entries 手动入库（源4）；类型非法/正文空 → 400', async () => {
    const r = await api('/style/entries', {
      method: 'POST',
      body: JSON.stringify({ 类型: '手法', 正文: '对话不用提示语', 场景: '' }),
    })
    expect(r.status).toBe(200)
    expect(r.json['path']).toBe('文风/条目/手法/通用-001.md')

    const bad1 = await api('/style/entries', { method: 'POST', body: JSON.stringify({ 类型: '妙笔', 正文: 'x' }) })
    expect(bad1.status).toBe(400)
    const bad2 = await api('/style/entries', { method: 'POST', body: JSON.stringify({ 类型: '手法', 正文: '  ' }) })
    expect(bad2.status).toBe(400)
  })

  it('DELETE entries 限条目目录内；穿越拒绝', async () => {
    const del = await api('/style/entries', {
      method: 'DELETE',
      body: JSON.stringify({ path: '文风/条目/手法/通用-001.md' }),
    })
    expect(del.status).toBe(200)
    expect(existsSync(join(bookRoot, '文风', '条目', '手法', '通用-001.md'))).toBe(false)

    const evil = await api('/style/entries', {
      method: 'DELETE',
      body: JSON.stringify({ path: '文风/条目/../../book.yaml' }),
    })
    expect(evil.status).toBe(400)
    expect(existsSync(join(bookRoot, 'book.yaml'))).toBe(true)
  })
})

describe('收割 + 候选箱端点（源1 闭环）', () => {
  const AI_TEXT =
    '他心中涌起一股难以言喻的感动，这一刻他终于明白了坚持的意义，原来所有的付出都是值得的。'
  const AUTHOR_TEXT =
    '巷口的馄饨摊还亮着一盏昏灯，老板娘往锅里下了最后一把面，蒸汽腾起来，糊住了她半张脸。他数出六个铜板放在案上，没说话。'

  it('harvest：轨迹 AI 版 vs 作者重写 → 样章候选落箱；重复收割走查重闸', async () => {
    const rel = '写作/正文/第一卷/0002-草稿.md'
    mkdirSync(join(bookRoot, '写作', '正文', '第一卷'), { recursive: true })
    writeFileSync(join(bookRoot, rel), AUTHOR_TEXT, 'utf8')
    expect(recordAiVersion(bookRoot, legacyId(rel), AI_TEXT)).not.toBeNull()

    const r1 = await api('/style/harvest', { method: 'POST' })
    expect(r1.status).toBe(200)
    expect(r1.json['created']).toBe(1)

    const r2 = await api('/style/harvest', { method: 'POST' })
    expect(r2.json['created']).toBe(0)
    expect(r2.json['skipped']).toBe(1)
  })

  it('GET candidates：样章候选带 AI版 对照证据 + 呈现状态待确认', async () => {
    const r = await api('/style/candidates')
    expect(r.status).toBe(200)
    const cs = r.json['candidates'] as Record<string, unknown>[]
    expect(cs).toHaveLength(1)
    expect(cs[0]!['类型']).toBe('样章')
    expect(cs[0]!['来源']).toBe('改稿行为')
    expect(cs[0]!['正文']).toBe(AUTHOR_TEXT)
    expect(cs[0]!['AI版']).toBe(AI_TEXT)
    expect(cs[0]!['状态']).toBe('待确认')
    expect(String(cs[0]!['_path'])).toMatch(/^文风\/候选\//)
  })

  it('ignore → 状态已忽略留档；confirm → 入条目库 + 候选文件删除', async () => {
    const list = await api('/style/candidates')
    const p = String((list.json['candidates'] as Record<string, unknown>[])[0]!['_path'])

    const ig = await api('/style/candidates/ignore', { method: 'POST', body: JSON.stringify({ path: p }) })
    expect(ig.status).toBe(200)
    const afterIg = await api('/style/candidates')
    expect((afterIg.json['candidates'] as Record<string, unknown>[])[0]!['状态']).toBe('已忽略')

    const cf = await api('/style/candidates/confirm', { method: 'POST', body: JSON.stringify({ path: p }) })
    expect(cf.status).toBe(200)
    expect(String(cf.json['entryPath'])).toMatch(/^文风\/条目\/样章\//)
    expect(existsSync(join(bookRoot, p))).toBe(false)

    const entries = await api('/style/entries')
    const es = entries.json['entries'] as Record<string, unknown>[]
    expect(es.some((e) => e['正文'] === AUTHOR_TEXT && e['来源'] === '改稿行为')).toBe(true)

    // 穿越拒绝
    const evil = await api('/style/candidates/confirm', {
      method: 'POST',
      body: JSON.stringify({ path: '文风/条目/样章/通用-001.md' }),
    })
    expect(evil.status).toBe(400)
  })

  // Windows 无 POSIX 权限位/需开发者模式，symlinkSync 直建 EPERM，该守卫语义由 macOS/Linux CI 腿覆盖
  it.skipIf(process.platform === 'win32')('M-7：中间组件符号链接穿越——路径字面在候选目录内但 realpath 越出书库，confirm/ignore 都拒', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'clwriting-style-evil-'))
    try {
      writeFileSync(join(outside, 'evil.md'), '---\n场景: 战斗\n---\n逃逸正文', 'utf8')
      symlinkSync(outside, join(bookRoot, '文风', '候选', '连结'))
      for (const ep of ['confirm', 'ignore']) {
        const r = await api(`/style/candidates/${ep}`, {
          method: 'POST',
          body: JSON.stringify({ path: '文风/候选/连结/evil.md' }),
        })
        expect(r.status).toBe(400)
      }
      // 逃逸目标文件未被动过（confirm 未搬入条目库 / ignore 未落档）
      expect(existsSync(join(outside, 'evil.md'))).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('定标端点（S7）', () => {
  it('GET config：铁律缺省空规则 + injection=light + 基线 null', async () => {
    const r = await api('/style/config')
    expect(r.status).toBe(200)
    expect(r.json['rules']).toEqual({})
    expect(r.json['injection']).toBe('light')
    expect(r.json['baseline']).toBeNull()
  })

  it('POST baseline/freeze：条目库样章按场景冻结；config 读回摘要', async () => {
    const fr = await api('/style/baseline/freeze', { method: 'POST' })
    expect(fr.status).toBe(200)
    const b = fr.json['baseline'] as Record<string, unknown>
    expect(b['frozenFrom']).toBe('文风/条目/样章')
    // 迁移入库的「战斗」样章 + confirm 入库的「通用」样章
    expect((b['scenes'] as string[]).sort()).toEqual(['战斗', '通用'])
    expect(existsSync(join(bookRoot, '文风', '基线.json'))).toBe(true)

    const cfg = await api('/style/config')
    const cb = cfg.json['baseline'] as Record<string, unknown>
    expect(cb['frozenFrom']).toBe('文风/条目/样章')
  })
})
