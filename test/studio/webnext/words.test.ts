/**
 * shared/words 纯函数测：mergeFm（fm 往返）+ formKindOf（含 chapter）。
 * 编辑区剥离 fm 的核心保证：stripFrontmatter / mergeFm 往返一致（fm 不丢不重，body 不被改写）。
 */
import { describe, it, expect } from 'vitest'
import { stripFrontmatter, mergeFm, formKindOf, isBodyKind } from '../../../src/studio/web-next/src/shared/words'

describe('mergeFm（stripFrontmatter 的逆）', () => {
  it('有 fm：保留 fm 头，拼接新 body', () => {
    const full = '---\n章号: 1\n标题: 开篇\n---\n\n旧正文\n'
    expect(mergeFm(full, '新正文\n')).toBe('---\n章号: 1\n标题: 开篇\n---\n\n新正文\n')
  })

  it('无 fm：原样返回 body', () => {
    expect(mergeFm('只有正文\n', '改\n')).toBe('改\n')
  })

  it('fm 未闭合（缺尾 ---）：当无 fm 处理，返回 body', () => {
    expect(mergeFm('---\n章号: 1\n', 'body')).toBe('body')
  })

  it('body 前导空行被去掉（fm/body 分隔空行不重复）', () => {
    const full = '---\n标题: x\n---\n\n旧\n'
    expect(mergeFm(full, '\n\n新正文')).toBe('---\n标题: x\n---\n\n新正文')
  })

  it('往返一致：编辑区取 body 后再 mergeFm 拼回，body 不变', () => {
    // 模拟编辑区完整往返：full → strip 取 body 给 CM → 用户改 body → mergeFm 拼回 → 再 strip 应等于用户输入
    const full = '---\n标题: 开篇\n钩子类型: 悬念钩\n---\n\n旧\n'
    const bodyShownToCm = stripFrontmatter(full).replace(/^\n+/, '') // 编辑区看到的
    const userEdited = bodyShownToCm.replace('旧', '新章正文') // 用户改 body
    const merged = mergeFm(full, userEdited) // patch 拼回全文
    // 编辑区再次取 body，应等于用户刚输入的（不跳变、不丢字）
    expect(stripFrontmatter(merged).replace(/^\n+/, '')).toBe(userEdited)
    // fm 头原样保留
    expect(merged.startsWith('---\n标题: 开篇\n钩子类型: 悬念钩\n---')).toBe(true)
  })
})

describe('formKindOf（含 chapter）', () => {
  it('写作/正文 → chapter（fm 走右栏表单 + 顶部标题可编辑）', () => {
    expect(formKindOf('写作/正文/第一卷/0001-开篇.md')).toBe('chapter')
  })
  it('大纲/章纲 → chapter-outline', () => {
    expect(formKindOf('大纲/章纲/0001-开篇.md')).toBe('chapter-outline')
  })
  it('设定/角色 → character', () => {
    expect(formKindOf('设定/角色/林远.md')).toBe('character')
  })
  it('设定/世界观 → worldview', () => {
    expect(formKindOf('设定/世界观.md')).toBe('worldview')
  })
  it('设定/物品 → item', () => {
    expect(formKindOf('设定/物品/玉佩.md')).toBe('item')
  })
  it('设定/伏笔 → foreshadow', () => {
    expect(formKindOf('设定/伏笔/玉佩埋设.md')).toBe('foreshadow')
  })
  it('短篇正文（写作/正文/001-x.md）path 视为 chapter；piece-body 由 role 判定', () => {
    // 短篇正文与长篇路径相同（写作/正文/），formKindOf 无法区分 → 返回 chapter
    expect(formKindOf('写作/正文/001-开篇.md')).toBe('chapter')
  })
  it('大纲/关系线（派生数据，移出编辑树）→ null（不进表单）', () => {
    expect(formKindOf('大纲/关系线/关系线-001-师徒债.md')).toBeNull()
  })
  it('非表单文档 → null', () => {
    expect(formKindOf('笔记/随便.md')).toBeNull()
  })
})

describe('isBodyKind（v2 正文判定）', () => {
  it('写作/正文/ 前缀为正文（含短篇）', () => {
    expect(isBodyKind('写作/正文/第一卷/0001-开篇.md')).toBe(true)
    expect(isBodyKind('写作/正文/001-开篇.md')).toBe(true)
  })
  it('非正文 → false', () => {
    expect(isBodyKind('大纲/章纲/x.md')).toBe(false)
    expect(isBodyKind('设定/角色/x.md')).toBe(false)
  })
})
