/**
 * 0918独立重评二轮修复批（B101）：拆分光标落在 UTF-16 代理对中间的劈字防线回归。
 *
 * 机理：cursorOffset 落在高低位代理之间（CJK 扩展 B 生僻字 𠀀 U+20000、emoji 等
 * astral 字符内部）时，applyChapterSplit 的 slice 切分把一个字符劈成两个孤立代理，
 * 落盘各编码为 U+FFFD——原章尾与新章头同时永久损坏一字，且恢复重放经同一光标
 * 复现损坏。validateSplitCursor 补边界判定后：劈中间 → 400 BAD_INPUT；码点边界
 * （含 astral 字符前后两侧）→ 正常干跑/执行不受影响。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { chapterContent, bindStructureHelpers } from '../helpers/structure.js'

const BOOK = '拆分代理对测试书'
let studio: StudioHarness
let userDataPath = ''

const { createChapter } = bindStructureHelpers({
  studio: () => studio,
  book: BOOK,
  userDataPath: () => userDataPath,
})

async function planSplit(
  docId: string,
  cursorOffset: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(docId)}/structure-plan`,
    { op: 'split', cursorOffset },
  )
  return { status: r.status, json: r.json as Record<string, unknown> }
}

beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-split-surrogate-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-split-surrogate-',
    userDataPath,
    dirs: ['写作/正文/第一卷', '工作区'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 拆分代理对测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('拆分光标代理对边界（validateSplitCursor B101）', () => {
  it('光标落在 𠀀（U+20000）代理对中间 → 干跑 400 BAD_INPUT（修复前 200，apply 劈字成 U+FFFD）', async () => {
    // 𠀀 = \uD840\uDC00 高低位代理对；正文含两个 astral 字符夹正常段
    const body = '前段正文。\n\n主角念出古字𠀀后天地变色。\n\n后段迁移。'
    const content = chapterContent(1, '第1章', body)
    const d = await createChapter('写作/正文/第一卷/0001-第1章.md', content)
    const cp = content.indexOf('𠀀')
    expect(cp).toBeGreaterThan(0)
    // 高代理与低代理之间（cp + 1）＝字符内部
    const mid = await planSplit(d, cp + 1)
    expect(mid.status).toBe(400)
    expect(mid.json['code']).toBe('BAD_INPUT')
    expect((mid.json as { error: string }).error).toContain('代理对')
  })

  it('光标在码点边界（astral 字符前/后两侧）→ 干跑正常（防线不误伤合法拆分点）', async () => {
    const body = '前段正文。\n\n主角念出古字𠀀后天地变色。\n\n后段迁移。'
    const content = chapterContent(2, '第2章', body)
    const d = await createChapter('写作/正文/第一卷/0002-第2章.md', content)
    const cp = content.indexOf('𠀀')
    for (const cursor of [cp, cp + 2]) {
      const plan = await planSplit(d, cursor)
      expect(plan.status).toBe(200)
      const p = plan.json['plan'] as Record<string, unknown>
      expect(typeof p['planHash']).toBe('string')
      expect(p['tailWords']).toBeGreaterThan(0)
    }
  })

  it('apply 同道拒收：劈中间光标 → 400 且盘面不动（校验先于 slice 切分）', async () => {
    const body = '前段正文。\n\n主角念出古字𠀀后天地变色。\n\n后段迁移。'
    const content = chapterContent(3, '第3章', body)
    const rel = '写作/正文/第一卷/0003-第3章.md'
    const d = await createChapter(rel, content)
    const cp = content.indexOf('𠀀')
    const boundary = await planSplit(d, cp + 2)
    expect(boundary.status).toBe(200)
    const r = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(d)}/structure-apply`,
      {
        op: 'split',
        title: '新章',
        cursorOffset: cp + 1,
        planHash: (boundary.json['plan'] as Record<string, unknown>)['planHash'],
      },
    )
    expect(r.status).toBe(400)
    expect((r.json as Record<string, unknown>)['code']).toBe('BAD_INPUT')
    // 拒收即盘面逐字节不动（未发生任何劈字写盘）
    expect(readFileSync(join(studio.bookRoot, rel), 'utf8')).toBe(content)
  })
})
