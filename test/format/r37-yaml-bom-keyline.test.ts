/**
 * R37-10（三十七轮批 B）回归：matchesKeyLine 不剥行首 BOM。
 *
 * 根因：Windows 编辑器存盘常带 UTF-8 BOM（\uFEFF），文件首键行形如 `\uFEFFrag:`——
 * matchesKeyLine 的 === / startsWith 比对均不中 → patchTopSection 等补丁族段定位
 * 走「段不存在」追加分支，在文件尾造重复段（解析取首个段 → 改动静默丢失）。读侧
 * 先例 R33D-3（账本推进 BOM 同族）。修复：比较前剥行首 BOM（只剥一次；调用方均为
 * findIndex 直吃 raw 原文，上游无统一剥除点，故在 matchesKeyLine 收口）。
 *
 * 测法：matchesKeyLine 私有，走其公开调用面 patchTopSection / setTopSectionKey
 * （BOM 只出现在文件首行行首，故样例把目标段头放首行）。
 */
import { test, expect } from 'vitest'
import { patchTopSection, setTopSectionKey } from '../../src/format/yaml.js'

/** BOM 紧贴段头首行（缺陷形态）+ CRLF 行尾 */
const BOM_CRLF = '\uFEFFrag:\r\n  enabled: false\r\n'
/** BOM + LF 对照 */
const BOM_LF = '\uFEFFrag:\n  enabled: false\n'
/** 无 BOM 双行尾对照（既有行为锁定） */
const PLAIN_LF = 'rag:\n  enabled: false\n'
const PLAIN_CRLF = 'rag:\r\n  enabled: false\r\n'

test('R37-10: BOM+CRLF 首段头原位替换（修复前误判段不存在、文件尾追加造重复段）', () => {
  const out = patchTopSection(BOM_CRLF, 'rag', '  enabled: true')
  // 修复前：追加分支产出两处段头（\uFEFFrag: 原段 + 追加的 rag:）——段头计数须容
  // BOM 形态才数得出重复（追加行无 BOM，仅数 ^rag: 会漏数原段）
  expect(out.match(/^(\uFEFF)?rag:/gm)).toHaveLength(1)
  expect(out).toContain('enabled: true')
  expect(out).not.toContain('enabled: false')
  // 段头行被重写为 `${section}:`（patchTopSection 既有行为）——BOM 随行重写消失，
  // 对后续再解析无害（matchesKeyLine 剥不剥 BOM 均命中），非本修复语义面
  expect(out.startsWith('rag:')).toBe(true)
})

test('R37-10: BOM+LF 首段头同口径原位替换', () => {
  const out = patchTopSection(BOM_LF, 'rag', '  enabled: true')
  expect(out.match(/^(\uFEFF)?rag:/gm)).toHaveLength(1)
  expect(out).toContain('enabled: true')
})

test('R37-10: 无 BOM 的 LF/CRLF 段头行为不回归（Z-7 既有口径）', () => {
  const lf = patchTopSection(PLAIN_LF, 'rag', '  enabled: true')
  expect(lf.match(/^rag:/m)).toHaveLength(1)
  const crlf = patchTopSection(PLAIN_CRLF, 'rag', '  enabled: true')
  expect(crlf.match(/^rag:/m)).toHaveLength(1)
  expect(crlf).toContain('enabled: true')
})

test('R37-10: BOM 在非目标行（spec_version 首行）不碍事，rag 段照常定位', () => {
  // BOM 只在文件首行——目标段不在首行时本就不受影响（剥除只对行首 \uFEFF 生效一次）
  const raw = '\uFEFFspec_version: 1\nrag:\n  enabled: false\n'
  const out = patchTopSection(raw, 'rag', '  enabled: true')
  expect(out.match(/^rag:/m)).toHaveLength(1)
  expect(out).toContain('enabled: true')
})

test('R37-10: setTopSectionKey 在 BOM+CRLF 首段头下原位替换单键（同 matchesKeyLine 调用面）', () => {
  const raw = '\uFEFFbook:\r\n  title: 旧书\r\n'
  // 修复前：book 段定位失明 → start=-1 走追加分支，文件尾多出 book: 段成两处。
  // 段头行含 BOM，正则行首断言需容 BOM；平台规范化批一：输出经 canonicalizeText
  // 收口——BOM 剥除、CRLF 归一 LF（写侧规范形，读侧容忍不变）。
  const out = setTopSectionKey(raw, 'book', 'title', '新书')
  expect(out.match(/^(\uFEFF)?book:/gm)).toHaveLength(1)
  expect(out).toContain('title: 新书')
  expect(out).not.toContain('title: 旧书')
  expect(out.startsWith('book:')).toBe(true) // BOM 随规范形写回收口剥除
  expect(out.includes('\r')).toBe(false) // CRLF 宿主归一 LF
})
