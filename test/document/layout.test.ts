import { describe, it, expect } from 'vitest'
import { roleOf, capabilitiesOf, layoutOf } from '../../src/document/layout.js'

describe('layout / roleOf 按路径判 role', () => {
  it('长篇定稿区', () => {
    expect(roleOf('定稿/正文/0001-开篇.md')).toBe('chapter')
    expect(roleOf('定稿/设定/世界观.md')).toBe('setting')
    expect(roleOf('定稿/摘要/0001.md')).toBe('note')
  })

  it('大纲区：卷纲 / 账本 / 普通大纲', () => {
    expect(roleOf('大纲/卷纲/第一卷.md')).toBe('volume-outline')
    expect(roleOf('大纲/伏笔/001-玉佩.md')).toBe('ledger')
    expect(roleOf('大纲/悬念/001-凶手.md')).toBe('ledger')
    expect(roleOf('大纲/总纲.md')).toBe('outline')
  })

  it('文风 / 简介 / 工作区草稿细纲', () => {
    expect(roleOf('文风/样章.md')).toBe('style')
    expect(roleOf('简介.md')).toBe('introduction')
    expect(roleOf('工作区/草稿-1.md')).toBe('draft')
    expect(roleOf('工作区/细纲.md')).toBe('draft')
    expect(roleOf('工作区/账本推进.md')).toBe('note')
  })

  it('自由区 / 废稿 / 未匹配', () => {
    expect(roleOf('素材/灵感.md')).toBe('material')
    expect(roleOf('笔记/随手.md')).toBe('note')
    expect(roleOf('废稿/旧版.md')).toBe('discard')
    expect(roleOf('随便/放哪.md')).toBe('note')
  })

  it('短篇篇包', () => {
    expect(roleOf('篇/001-雨夜/正文.md')).toBe('piece-body')
    expect(roleOf('篇/001-雨夜/清单.md')).toBe('piece-manifest')
    expect(roleOf('篇/001-雨夜/其他.md')).toBe('note')
  })

  it('反斜杠与前导 ./ 容错', () => {
    expect(roleOf('./定稿/正文/0001-开篇.md')).toBe('chapter')
    expect(roleOf('定稿\\正文\\0001-开篇.md')).toBe('chapter')
  })
})

describe('layout / capabilitiesOf 系统文档与只读', () => {
  it('定稿/摘要（脚本产物）只读', () => {
    const c = capabilitiesOf('note', '定稿/摘要/0001.md')
    expect(c.write).toBe(false)
    expect(c.trash).toBe(false)
    expect(c.read).toBe(true)
  })

  it('笔记/ 的 note 全开', () => {
    const c = capabilitiesOf('note', '笔记/随手.md')
    expect(c.write).toBe(true)
    expect(c.trash).toBe(true)
  })

  it('账本 ledger：可写不可删', () => {
    const c = capabilitiesOf('ledger', '大纲/伏笔/001-玉佩.md')
    expect(c.write).toBe(true)
    expect(c.trash).toBe(false)
  })

  it('篇清单 piece-manifest：不可删', () => {
    const c = capabilitiesOf('piece-manifest', '篇/001-雨夜/清单.md')
    expect(c.trash).toBe(false)
    expect(c.write).toBe(true)
  })

  it('chapter 可写（定稿直改 §6）', () => {
    const c = capabilitiesOf('chapter')
    expect(c.write).toBe(true)
  })

  it('所有 role 的 aiPropose 冻结期 false', () => {
    const roles = ['chapter', 'ledger', 'note', 'draft', 'outline'] as const
    for (const r of roles) {
      expect(capabilitiesOf(r).aiPropose).toBe(false)
    }
  })
})

describe('layout / layoutOf 组合', () => {
  it('定稿/摘要 → role=note + write=false', () => {
    const info = layoutOf('定稿/摘要/0001.md')
    expect(info.role).toBe('note')
    expect(info.capabilities.write).toBe(false)
  })

  it('账本 → ledger + trash=false', () => {
    const info = layoutOf('大纲/伏笔/001-玉佩.md')
    expect(info.role).toBe('ledger')
    expect(info.capabilities.trash).toBe(false)
    expect(info.capabilities.write).toBe(true)
  })
})
