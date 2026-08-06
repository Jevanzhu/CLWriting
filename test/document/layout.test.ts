import { describe, it, expect } from 'vitest'
import { roleOf, capabilitiesOf, layoutOf } from '../../src/document/layout.js'

describe('layout / roleOf 按路径判 role', () => {
  it('正文 + 设定（v2 目录结构）', () => {
    expect(roleOf('写作/正文/0001-开篇.md')).toBe('chapter')
    expect(roleOf('设定/世界观.md')).toBe('setting')
    expect(roleOf('定稿/摘要/0001.md')).toBe('note')
  })

  it('卷级分层：写作/正文/<卷>/<章> 任意深度 → chapter', () => {
    expect(roleOf('写作/正文/第一卷/0001-开篇.md')).toBe('chapter')
    expect(roleOf('写作/正文/第二卷/0051-惊蛰.md')).toBe('chapter')
    expect(roleOf('写作/正文/番外/茶馆往事.md')).toBe('chapter')
    expect(roleOf('写作/正文/第一卷·初/0001-开篇.md')).toBe('chapter')
    // 平铺兼容（无卷，章直接挂正文目录）
    expect(roleOf('写作/正文/0001-开篇.md')).toBe('chapter')
  })

  it('大纲区：卷纲 / 普通大纲（线索拆到 布线/）', () => {
    expect(roleOf('大纲/卷纲/第一卷.md')).toBe('volume-outline')
    expect(roleOf('大纲/总纲.md')).toBe('outline')
    expect(roleOf('大纲/章纲/0001-开篇.md')).toBe('outline')
  })

  it('布线区：线索 → ledger', () => {
    expect(roleOf('布线/悬念/001-玉佩.md')).toBe('ledger')
    expect(roleOf('布线/感情线/001-初遇.md')).toBe('ledger')
  })

  it('短篇清单（大纲/清单/ → piece-manifest）', () => {
    expect(roleOf('大纲/清单/001-雨夜.md')).toBe('piece-manifest')
  })

  it('文风 / 简介 / 工作区', () => {
    expect(roleOf('文风/样章.md')).toBe('style')
    expect(roleOf('简介.md')).toBe('introduction')
    // 工作区是运行时资产区 → note
    expect(roleOf('工作区/.journal/doc.jsonl')).toBe('note')
  })

  it('自由区 / 废稿 / 未匹配', () => {
    expect(roleOf('素材/灵感.md')).toBe('material')
    expect(roleOf('笔记/随手.md')).toBe('note')
    expect(roleOf('废稿/旧版.md')).toBe('discard')
    expect(roleOf('随便/放哪.md')).toBe('note')
  })

  it('反斜杠与前导 ./ 容错', () => {
    expect(roleOf('./写作/正文/0001-开篇.md')).toBe('chapter')
    expect(roleOf('写作\\正文\\0001-开篇.md')).toBe('chapter')
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
    const c = capabilitiesOf('ledger', '布线/悬念/001-玉佩.md')
    expect(c.write).toBe(true)
    expect(c.trash).toBe(false)
  })

  it('篇清单 piece-manifest：不可删', () => {
    const c = capabilitiesOf('piece-manifest', '大纲/清单/001-雨夜.md')
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

  it('布线 → ledger + trash=false', () => {
    const info = layoutOf('布线/悬念/001-玉佩.md')
    expect(info.role).toBe('ledger')
    expect(info.capabilities.trash).toBe(false)
    expect(info.capabilities.write).toBe(true)
  })
})
