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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeVersion, readVersion, readVersionRaw, readVersionMeta, listVersions } from '../../src/document/version.js'
import { log } from '../../src/log/index.js'
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

  // R1010-P3（2026-09-10 全量重评 GLM-5.3 修复批）：fence 尾随空白容忍对齐文本侧
  // R54-E-2——`--- `（编辑器/同步盘注入）此前字节层只认裸 `---`/`---\r`，同文件
  // 文本侧读得、字节层 read null 的判定漂移
  it('fence 尾随空白（--- \\t / --- \\r）：字节层与文本侧同判有效，正文零损伤', () => {
    const body = '正文第一行\n第二行'
    const id = writeVersion(dir, docId, body, { origin: 'manual' })
    expect(id).not.toBeNull()
    // 手工重写档案头：起始/闭合 fence 均带尾随空白（起始 [ \t]、闭合 [ \t]\r 混合形态）
    writeFileSync(join(dir, docId, `${id}.md`), `--- \n版本ID: ${id}\n来源: manual\n---\t\r\n${body}`)
    const raw = readVersionRaw(dir, docId, id!)
    expect(raw).not.toBeNull()
    expect(raw!.content.toString('utf-8')).toBe(body)
    expect(raw!.meta.origin).toBe('manual')
    expect(readVersion(dir, docId, id!)?.content).toBe(body)
  })

  // A-2：`.版本/<docId>/` 是外部工具/同步盘可写的盘面，列表是 id 的唯一派生点——
  // 白名单（与 readVersion/readVersionMeta/readVersionRaw 同款）必须在此收口，
  // 否则不合形态的名称参与 join(dir, id + '.md') 会定位到目录外。
  it('A-2: 非 ULID 文件名不进列表（防越出与「最新版本」位抢占），并留痕', () => {
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      const id = writeVersion(dir, docId, '正文', { origin: 'manual' })
      expect(id).not.toBeNull()
      // 外部放入的非法版本名：小写字母按字节序排在 ULID 之后 → 不滤除时占列表首位
      //（写侧去重/节流即以此为「最新版本」锚点）
      writeFileSync(join(dir, docId, 'zzz-not-a-ulid.md'), '外来件', 'utf-8')
      expect(listVersions(dir, docId).map((v) => v.id)).toEqual([id])
      expect(warnSpy.mock.calls.flat().map(String).join(' ')).toContain('zzz-not-a-ulid.md')
      // 读侧三入口同判：非 ULID id 恒不可读（列表与读两面对齐）
      expect(readVersionMeta(dir, docId, 'zzz-not-a-ulid')).toBeNull()
    } finally {
      warnSpy.mockRestore()
    }
  })

  // A-3：外部编辑器/同步盘把快照写成 CRLF——fm 首键（来源）与末值（原因）都不得带
  // 行尾 CR（读侧行尾归一收口在 parseFlat 的行切分原语），正文与双视图零损伤。
  it('A-3: CRLF 快照档案：fm 首键与末值不带 \\r，正文双视图一致', () => {
    const id = writeVersion(dir, docId, '正文', { origin: 'manual' })
    expect(id).not.toBeNull()
    // 手工重写为 CRLF 档案：来源在首键、原因在末值（末值携带 split('\n') 残留的 CR）
    const crlfBody = '正文第一行\r\n正文第二行'
    writeFileSync(
      join(dir, docId, `${id}.md`),
      `---\r\n来源: manual\r\n字数: 12\r\n永久: true\r\n原因: 手改留底\r\n---\r\n${crlfBody}`,
      'utf-8',
    )
    const raw = readVersionRaw(dir, docId, id!)
    expect(raw).not.toBeNull()
    expect(raw!.meta.origin).toBe('manual') // 首键
    expect(raw!.meta.reason).toBe('手改留底') // 末值
    expect(raw!.meta.words).toBe(12)
    expect(raw!.meta.pinned).toBe(true)
    expect(raw!.content.toString('utf-8')).toBe(crlfBody) // 字节层正文零损伤
    // 文本侧两入口同判（头部 bounded read 与整读口径一致）
    expect(readVersionMeta(dir, docId, id!)?.meta.origin).toBe('manual')
    expect(readVersionMeta(dir, docId, id!)?.meta.reason).toBe('手改留底')
    expect(readVersion(dir, docId, id!)?.meta.reason).toBe('手改留底')
  })
})
