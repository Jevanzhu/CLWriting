/**
 * R63-7（十一轮）：机检草稿预读快照（draftText）透传链锚测。
 *
 * 三审端点此前三次独立读文件（sourceHash 一读、机检内二读、draftHash 三读），
 * 机检窗口内保存会让两个 hash 无任何单一文件状态与之对应。修复后端点单次读取
 * 取 buffer，经 opts.draftText 喂机检——本测试锚住透传链 readFile → readChapter
 * → readDraft → checkWithDb → runCheckForDocument：快照传入时零文件读、机检
 * chapter/body 取快照而非盘上文件。
 */
import { test, expect } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDraft } from '../../src/format/draft.js'
import { runCheckForDocument } from '../../src/check/run.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const FM1 = '---\n章号: 1\n标题: 盘上版\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n'
const FM2 = '---\n章号: 2\n标题: 快照版\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n'

test('readDraft(path, content) 按预读文本解析——文件不存在也成立（零文件读）', () => {
  const ghost = join(tmpdir(), `clwriting-r63-7-ghost-${process.pid}.md`) // 刻意不落盘
  const draft = readDraft(ghost, FM2 + '快照正文。')
  expect(draft.ok).toBe(true)
  if (draft.ok) {
    expect(draft.chapter.章号).toBe(2)
    expect(draft.chapter.标题).toBe('快照版')
    expect(draft.body).toBe('\n快照正文。') // body 带前导换行（splitFrontMatter 既有口径，与文件路径一致）
  }
  // 不传 content → 回落读文件路径（缺文件守卫照常）
  expect(readDraft(ghost).ok).toBe(false)
})

test('runCheckForDocument opts.draftText → chapter/body 取快照（盘上文件被另一版本覆盖也不串拍）', () => {
  const bookRoot = mkdtempTracked(join(tmpdir(), 'clwriting-r63-7-check-'))
  const draftPath = join(bookRoot, '0001-盘上版.md')
  try {
    writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 快照书\nhost: cc\nleads:\n  enabled: []\n', 'utf8')
    writeFileSync(draftPath, FM1 + '盘上正文。', 'utf8')

    // 不传快照（既有口径回归）：读盘上文件
    const fromFile = runCheckForDocument(bookRoot, draftPath, null)
    expect(fromFile.ok).toBe(true)
    if (fromFile.ok) {
      expect(fromFile.chapter.章号).toBe(1)
      expect(fromFile.body).toBe('\n盘上正文。')
    }

    // 传快照：章号/正文取快照（端点单次读取的 buffer 派生）
    const fromSnapshot = runCheckForDocument(bookRoot, draftPath, null, { draftText: FM2 + '快照正文。' })
    expect(fromSnapshot.ok).toBe(true)
    if (fromSnapshot.ok) {
      expect(fromSnapshot.chapter.章号).toBe(2)
      expect(fromSnapshot.body).toBe('\n快照正文。')
    }
  } finally {
    rmSync(bookRoot, { recursive: true, force: true })
  }
})
