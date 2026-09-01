/**
 * R34D-18（三十四轮）：版本档案写读字节对称性（readVersionRaw）。
 *
 * 场景核心：R26-52 写侧对非 UTF-8 源（GBK 旧档）按原字节留底（Buffer 直存），
 * 但读侧 readVersion 是 utf-8 文本视图，非 UTF-8 正文必被 U+FFFD 替换——盘上字节
 * 在、读出必失真，字节档的恢复形同虚设。修复后新增 readVersionRaw：fm 头按 utf-8
 * 解析（与 readVersion 同口径），正文段零解码原样返回 Buffer。本组锁定：
 *   1. GBK 字节档 write → readVersionRaw 字节级零损伤往返；
 *   2. 正常 utf-8 文本档 raw/text 双视图一致（含 meta、CRLF、正文伪 fence 行）；
 *   3. 头部损坏/非法 id 与 readVersion 同判 null。
 */
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeVersion, readVersion, readVersionRaw } from '../../src/document/version.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let dir: string
const docId = 'doc_r34d_raw'

beforeEach(() => {
  dir = mkdtempTracked(join(tmpdir(), 'clw-r34d-raw-'))
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* mkdtempTracked 的 afterEach 兜底回收 */
  }
})

describe('R34D-18：readVersionRaw 字节保真读', () => {
  it('GBK 字节档：write 原字节留底 → readVersionRaw 逐字节还原（零 U+FFFD 损伤）', () => {
    // 「旧档」的 GBK 双字节序列（非合法 UTF-8，与 r73-data-safety 口径一致）
    const gbk = Buffer.concat([
      Buffer.from('第一章 ', 'utf-8'),
      Buffer.from([0xbe, 0xc9, 0xb5, 0xb5]), // GBK「旧档」
      Buffer.from('\n正文继续', 'utf-8'),
    ])
    const id = writeVersion(dir, docId, gbk, { origin: 'move', reason: '移动前留底' })
    expect(id).not.toBeNull()

    const raw = readVersionRaw(dir, docId, id!)
    expect(raw).not.toBeNull()
    expect(raw!.content.equals(gbk)).toBe(true)
    // 原字节里不得混入 U+FFFD 替换符的 UTF-8 序列（EF BF BD）——零解码的直接证据
    expect(raw!.content.includes(Buffer.from('\uFFFD', 'utf8'))).toBe(false)
    expect(raw!.meta.origin).toBe('move')
    expect(raw!.meta.reason).toBe('移动前留底')

    // 对照：文本视图（readVersion）对同一档案必然有损——这正是 raw 入口存在的理由
    const text = readVersion(dir, docId, id!)
    expect(text).not.toBeNull()
    expect(text!.content.includes('\uFFFD')).toBe(true)
  })

  it('正常 utf-8 文本档：raw 与 text 双视图一致（meta/CRLF/正文伪 fence 行/空正文）', () => {
    const body = '---\n看似 front matter 的正文行\n第二行\r\n第三行'
    const id = writeVersion(dir, docId, body, { origin: 'finalize', pinned: true, words: 123 })
    expect(id).not.toBeNull()

    const raw = readVersionRaw(dir, docId, id!)
    expect(raw).not.toBeNull()
    expect(raw!.content.toString('utf-8')).toBe(body)
    expect(raw!.meta.origin).toBe('finalize')
    expect(raw!.meta.pinned).toBe(true)
    expect(raw!.meta.words).toBe(123)
    expect(readVersion(dir, docId, id!)?.content).toBe(body)

    // 空正文：闭合 fence 后无字节 → 空 Buffer（与文本侧空串对齐）
    const emptyId = writeVersion(dir, docId, '', { origin: 'manual' })
    const emptyRaw = readVersionRaw(dir, docId, emptyId!)
    expect(emptyRaw).not.toBeNull()
    expect(emptyRaw!.content.length).toBe(0)
  })

  it('头部损坏 / 非法 id / 不存在：与 readVersion 同判 null', () => {
    const id = writeVersion(dir, docId, '正文', { origin: 'manual' })
    expect(id).not.toBeNull()
    // 头部截断（fm 未闭合）
    writeFileSync(join(dir, docId, `${id}.md`), '---\n版本ID: 损坏\n时间: 截断\n')
    expect(readVersionRaw(dir, docId, id!)).toBeNull()
    expect(readVersion(dir, docId, id!)).toBeNull()
    // 非法 id（防穿越）与不存在的 id
    expect(readVersionRaw(dir, docId, '../escape')).toBeNull()
    expect(readVersionRaw(dir, docId, '01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull()
  })
})
