/**
 * R71-4 回归：CRLF book.yaml 的裸键行补丁。
 *
 * setSectionKeyBlock / setTopSectionKey 的键行匹配未剥 \r——CRLF 文件的裸键行
 * （`  thresholds:\r`）两条件均不中被判「键不存在」：删除模式原样返回（静默丢改）、
 * 替换模式在段头后再插一份（残留重复块）。评审复现路径 = PUT /config 的
 * patchBookConfigText（thresholds 嵌套映射整块换），此处直测两函数 + 走补丁总入口。
 */
import { describe, it, expect } from 'vitest'
import { parseBookConfig, patchBookConfigText, setSectionKeyBlock, setTopSectionKey } from '../../src/format/yaml.js'

/** CRLF 版 book.yaml（leads 段含裸键块 thresholds）——行尾一律 \r\n */
const CRLF_BOOK = [
  'spec_version: 1',
  'book:',
  '  title: 测试书',
  'leads:',
  '  enabled: []',
  '  thresholds:',
  '    悬念: 3',
  '',
].join('\r\n')

/** LF 对照版（内容逐行相同，仅行尾不同） */
const LF_BOOK = CRLF_BOOK.replace(/\r\n/g, '\n')

describe('R71-4：patchBookConfigText 在 CRLF book.yaml 上的裸键行为与 LF 一致', () => {
  it('删除裸键块（thresholds）→ 输出不再含该键（修复前：判键不存在、原样返回丢改）', () => {
    const oldCfg = parseBookConfig(CRLF_BOOK).config
    const newCfg = structuredClone(oldCfg)
    delete newCfg.leads.thresholds
    const out = patchBookConfigText(CRLF_BOOK, oldCfg, newCfg)
    expect(out).not.toContain('thresholds')
    expect(out).not.toContain('悬念')
  })

  it('修改裸键块值 → 只有一处 thresholds（修复前：键不存在走插入、残留重复块）', () => {
    const oldCfg = parseBookConfig(CRLF_BOOK).config
    const newCfg = structuredClone(oldCfg)
    newCfg.leads.thresholds = { 悬念: 5 }
    const out = patchBookConfigText(CRLF_BOOK, oldCfg, newCfg)
    expect(out.match(/thresholds:/g)).toHaveLength(1)
    expect(out).toContain('悬念: 5')
    expect(out).not.toContain('悬念: 3')
  })

  it('删除场景 CRLF 产物与 LF 归一一致（行尾口径对齐，行为无分叉）', () => {
    const oldCfg = parseBookConfig(CRLF_BOOK).config
    const newCfg = structuredClone(oldCfg)
    delete newCfg.leads.thresholds
    const outCrlf = patchBookConfigText(CRLF_BOOK, oldCfg, newCfg)
    const outLf = patchBookConfigText(LF_BOOK, oldCfg, newCfg)
    expect(outCrlf.replace(/\r\n/g, '\n')).toBe(outLf)
  })
})

describe('R71-4：补丁函数单元（裸键行剥 \r）', () => {
  it('setSectionKeyBlock：CRLF 裸键删除成块移除；替换不残留旧块', () => {
    // 删除整个键块（键行 + 更深缩进的子行一起移除）
    const deleted = setSectionKeyBlock(CRLF_BOOK, 'leads', 'thresholds', null)
    expect(deleted.replace(/\r/g, '')).toBe(setSectionKeyBlock(LF_BOOK, 'leads', 'thresholds', null))
    expect(deleted).not.toContain('thresholds')
    // 替换（嵌套映射：键行 + 块体行）
    const replaced = setSectionKeyBlock(CRLF_BOOK, 'leads', 'thresholds', 'thresholds:', ['伏笔: 7'])
    expect(replaced.match(/thresholds:/g)).toHaveLength(1)
    expect(replaced).toContain('伏笔: 7')
    expect(replaced).not.toContain('悬念')
  })

  it('setTopSectionKey：CRLF 裸键行替换命中原位（修复前：判键不存在、插入后成两处）', () => {
    const out = setTopSectionKey(CRLF_BOOK, 'leads', 'thresholds', '迁移')
    expect(out.match(/thresholds:/g)).toHaveLength(1)
    expect(out).toContain('thresholds: 迁移')
    // 有值键行（`  enabled: []\r`）原先 startsWith 分支即可命中，行为不回归
    const titled = setTopSectionKey(CRLF_BOOK, 'book', 'title', '新书名')
    expect(titled).toContain('title: 新书名')
    expect(titled.match(/  title:/g)).toHaveLength(1)
  })
})
