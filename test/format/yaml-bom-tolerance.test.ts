/**
 * book.yaml 的 UTF-8 BOM 容忍（读侧解析 + 写侧补丁族，行首 BOM 不误判）。
 *
 * Windows 编辑器（记事本「UTF-8 with BOM」）存盘常在首行行首留 \uFEFF，两族各有一段
 * 失守与收口：
 * - 读侧解析（R42-34）：BOM 计入首行缩进 → 首段 1 空格子行被弹栈提为顶层键后静默丢弃；
 *   trim() 恰剥 ZWNBSP 才不出键名事故。修复：入口窄剥前导 BOM（不归一行尾）。
 * - 写侧补丁族（R2W-6 / R37-10）：matchesKeyLine 的 === / startsWith 比对均不中 BOM 行
 *   → 段/键定位走「不存在」追加分支，在文件尾造重复段/重复键（解析取首个 → 改动静默
 *   丢失，或撞 fail-loud 重复守卫致全书配置降级）。修复：比较前剥行首 BOM（只剥一次）。
 *
 * 判定走公开调用面 —— matchesKeyLine 为私有，经 patchTopSection / setTopSectionKey /
 * patchBookConfigText / parseBookConfig 触发。
 */
import { describe, expect, it, test } from 'vitest'
import {
  DEFAULT_CONFIG,
  parseBookConfig,
  patchBookConfigText,
  patchTopSection,
  setTopSectionKey,
} from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

const BOM = '\uFEFF'

describe('补丁族键行 BOM 容忍（R2W-6）', () => {
  it('patchTopSection：BOM 开头的段头 → 原位替换，不追加重复段', () => {
    const raw = `${BOM}genre:\n  基调: 热血\n\nspec_version: 1\n`
    const out = patchTopSection(raw, 'genre', '  基调: 玄幻\n')
    // BOM'd 段头被识别（修复前：原段不被匹配 → 文件尾追加第二处 genre:）
    expect(out.match(/genre:/g)).toHaveLength(1)
    expect(out).toContain('基调: 玄幻')
    expect(out).not.toContain('基调: 热血')
  })

  it('setTopSectionKey：BOM 开头的段头 → 段内键原位更新，不造重复段', () => {
    const raw = `${BOM}genre:\n  基调: 热血\n`
    const out = setTopSectionKey(raw, 'genre', '基调', '玄幻')
    expect(out.match(/genre:/g)).toHaveLength(1)
    expect(out).toContain('基调: 玄幻')
  })

  it('patchBookConfigText：BOM 行首的标量键 → 原位更新，不重复插键', () => {
    const raw = `${BOM}spec_version: 1\n`
    const oldCfg: BookConfig = { ...DEFAULT_CONFIG, spec_version: 1 }
    const newCfg: BookConfig = { ...DEFAULT_CONFIG, spec_version: 2 }
    const out = patchBookConfigText(raw, oldCfg, newCfg)
    expect(out.match(/spec_version:/g)).toHaveLength(1)
    expect(out).toContain('spec_version: 2')
  })
})

describe('R37-10: matchesKeyLine 行首 BOM 剥除（补丁族段/键定位）', () => {
  /** BOM 紧贴段头首行（缺陷形态）+ CRLF 行尾 */
  const BOM_CRLF = '\uFEFFrag:\r\n  enabled: false\r\n'
  /** BOM + LF 对照 */
  const BOM_LF = '\uFEFFrag:\n  enabled: false\n'
  /** 无 BOM 双行尾对照（既有行为锁定） */
  const PLAIN_LF = 'rag:\n  enabled: false\n'
  const PLAIN_CRLF = 'rag:\r\n  enabled: false\r\n'

  test('BOM+CRLF 首段头原位替换（修复前误判段不存在、文件尾追加造重复段）', () => {
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

  test('BOM+LF 首段头同口径原位替换', () => {
    const out = patchTopSection(BOM_LF, 'rag', '  enabled: true')
    expect(out.match(/^(\uFEFF)?rag:/gm)).toHaveLength(1)
    expect(out).toContain('enabled: true')
  })

  test('无 BOM 的 LF/CRLF 段头行为不回归（Z-7 既有口径）', () => {
    const lf = patchTopSection(PLAIN_LF, 'rag', '  enabled: true')
    expect(lf.match(/^rag:/m)).toHaveLength(1)
    const crlf = patchTopSection(PLAIN_CRLF, 'rag', '  enabled: true')
    expect(crlf.match(/^rag:/m)).toHaveLength(1)
    expect(crlf).toContain('enabled: true')
  })

  test('BOM 在非目标行（spec_version 首行）不碍事，rag 段照常定位', () => {
    // BOM 只在文件首行——目标段不在首行时本就不受影响（剥除只对行首 \uFEFF 生效一次）
    const raw = '\uFEFFspec_version: 1\nrag:\n  enabled: false\n'
    const out = patchTopSection(raw, 'rag', '  enabled: true')
    expect(out.match(/^rag:/m)).toHaveLength(1)
    expect(out).toContain('enabled: true')
  })

  test('setTopSectionKey 在 BOM+CRLF 首段头下原位替换单键（同 matchesKeyLine 调用面）', () => {
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
})

describe('R42-34: book.yaml 解析入口 BOM 剥除', () => {
  it('BOM + kind: short 首行 → 解析出 short（不被静默路由长篇轨）', () => {
    const r = parseBookConfig(`${BOM}kind: short\nhost: cc\nbook:\n  title: 测试\n`)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.kind).toBe('short')
  })

  it('BOM + spec_version 首键 → 键被认（不回落默认 1）', () => {
    const r = parseBookConfig(`${BOM}spec_version: 3\nhost: cc\nbook:\n  title: 测试\n`)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.spec_version).toBe(3)
  })

  it('BOM 首段 + 1 空格缩进子行 → 子键仍挂首段（首行缩进不再多计 1）', () => {
    // 修复前：BOM 计入缩进（首段 indent=1）→ 1 空格子行弹栈提为顶层键 → title 静默丢
    const r = parseBookConfig(`${BOM}book:\n title: 一空格子行\nhost: cc\n`)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.book.title).toBe('一空格子行')
  })

  it('BOM + CRLF 混形 → 行尾容忍语义维持（窄剥 BOM 不动 CRLF）', () => {
    const r = parseBookConfig(`${BOM}kind: short\r\nhost: cc\r\nbook:\r\n  title: 换行书\r\n`)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.config.kind).toBe('short')
      expect(r.config.book.title).toBe('换行书')
    }
  })

  it('无 BOM 文件零变化（replace 无命中，回归锚）', () => {
    const r = parseBookConfig('kind: short\nhost: cc\nbook:\n  title: 无BOM\n')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.config.kind).toBe('short')
      expect(r.config.book.title).toBe('无BOM')
    }
  })
})
