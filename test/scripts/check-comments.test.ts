/**
 * 源码注释门直测（scripts/check-comments.mjs）。
 *
 * 覆盖三面：
 * 1. 形态命中——批号 / 轮次 / 日期戳 / 评审过程词各形逐一红。
 * 2. 字符串字面量零误报——字符串 / 模板串（含 ${} 嵌套）/ 正则字面量 / .vue 属性串 /
 *    裸 URL 里的标签样文本一律不进注释判定（清理只动注释、绝不碰生产字面量的机器化）。
 * 3. allowlist——承重锚注（被测试 readFileSync 断言钉住的注释）按 文件+行内容 放行。
 */
import { describe, expect, it } from 'vitest'
import {
  ANCHOR_ALLOWLIST,
  extractCommentLines,
  findTagHits,
  isAllowlisted,
  TOKEN_EXCEPTIONS,
  // @ts-expect-error —— .mjs 直跑脚本无类型声明（不为其维护 d.ts；断言口径靠用例锚定）。
  // 注记须紧贴 `} from` 行（TS 把 TS7016 报在模块说明符所在行），故放字面量末项之后。
} from '../../scripts/check-comments.mjs'

interface CommentLine {
  line: number
  col: number
  endCol: number
  text: string
}
interface TagHit {
  line: number
  name: string
  match: string
  text: string
}
interface HitOpts {
  file?: string
  ext?: string
  allowlist?: { file: string; contains: string; why: string }[]
}

const hits = (content: string, opts: HitOpts = {}): TagHit[] => findTagHits(content, opts)

describe('extractCommentLines：注释抽取与字符串保护', () => {
  it('行注释 / 块注释 / .vue HTML 注释均抽出，行号正确', () => {
    const src = ['const a = 1 // 行注', '/* 块注 */', 'const b = 2'].join('\n')
    expect(extractCommentLines(src).map((l: CommentLine) => l.line)).toEqual([1, 2])
    const vue = ['<template>', '  <!-- 模板注 -->', '</template>'].join('\n')
    expect(extractCommentLines(vue, '.vue').map((l: CommentLine) => l.text)).toEqual(['<!-- 模板注 -->'])
    // 非 .vue 扩展名不启用 HTML 注释态
    expect(extractCommentLines(vue)).toEqual([])
  })

  it('字符串字面量里的标签样文本不算注释（生产字面量红线）', () => {
    const src = "const a = 'R40-2 修复' // 真注释 R41"
    const lines: CommentLine[] = extractCommentLines(src)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.text).toBe('// 真注释 R41')
  })

  it('模板串文本不进注释；${} 内代码照常判定、其内块注释仍抽出', () => {
    const src = 'const b = `模板 P3-2 ${x /* 块注 R42 */} 尾`'
    expect(extractCommentLines(src).map((l: CommentLine) => l.text)).toEqual(['/* 块注 R42 */'])
  })

  it('模板串闭合后状态复位——后续注释照常抽出（闭合反引号不得吞正文）', () => {
    const src = 'const b = `模板` // 真注 R47'
    expect(extractCommentLines(src).map((l: CommentLine) => l.text)).toEqual(['// 真注 R47'])
  })

  it('正则字面量内容不进注释（等号后隔空白仍识别正则态）', () => {
    const src = 'const re = /R43\\d/ // 真注 R44'
    expect(extractCommentLines(src).map((l: CommentLine) => l.text)).toEqual(['// 真注 R44'])
  })

  it('裸 URL 的 :// 不开行注释（CSS url() 场景）', () => {
    const src = 'background: url(https://example.com/a.png) // 真注'
    expect(extractCommentLines(src).map((l: CommentLine) => l.text)).toEqual(['// 真注'])
  })
})

describe('findTagHits：批号标签形态', () => {
  it.each([
    ['// R40-2：读侧改异步孪生', ['R40-2']],
    ['// R0916-7-P3-3：原语迁 src/fs/lock-file.ts', ['R0916-7-P3-3']],
    ['// R34D-19（三十四轮）：开库走异步孪生', ['R34D-19', '（三十四轮）']],
    ['// r0912-task-gate-port.test.ts 源锚测试锁死', ['r0912-task-gate-port']],
    ['// P3-6：mock 回合不再是审计黑洞', ['P3-6']],
    ['// CC-P2-3：先默认权限写再补 chmodSync', ['CC-P2-3']],
    ['// PM-10（性能专项）核查', ['PM-10']],
    ['// A-6（二十九轮）：含估计入账标记', ['A-6', '（二十九轮）']],
    ['// T5 泛化', ['T5']],
    ['// 第六十轮', ['第六十轮']],
    ['// R37-5（三十七轮）：读侧改异步孪生', ['R37-5', '（三十七轮）']],
    ['// D3（批 5）：本章金额累计', ['D3', '（批 5）']],
    ['// 2026-09-11 全量重评', ['2026-09-11']],
    ['// RC 源码重审 A-8：更名', ['重审', 'A-8']],
    ['// 复审-0914-优化修复批 C1 单源移位', ['复审', 'C1']],
  ])('命中：%s → %j', (line, matches) => {
    const h = hits(line)
    expect(h.map((x) => x.match)).toEqual(matches)
  })

  it('r 系批号吞同链后缀（r0912-task-gate-port 整段算一个标签）', () => {
    const h = hits('// r0912-task-gate-port.test.ts 源锚测试锁死')
    expect(h[0]!.match).toMatch(/^r0912/)
  })

  it('同 token 多形撞车只报一次（R2W-7 不折算两个标签）', () => {
    expect(hits('// R2W-7：行键剥行尾')).toHaveLength(1)
  })

  it('豁免术语表放行 V8 / K8s', () => {
    expect(hits('// V8 FatalError 经 error 事件到达')).toHaveLength(0)
    expect(TOKEN_EXCEPTIONS.has('V8')).toBe(true)
  })

  it('干净注释零命中（约束 / 不变量 / 平台差语义不受影响）', () => {
    for (const line of [
      '// 预算闸据此保守阻断——JSON 损坏不静默取空',
      '* win 文件名非法字符须编码在前（权威位优先）',
      '/* 不变量：写入字节即 revision 派生源，不写后重读盘 */',
      '<!-- 弹层关闭时归还焦点 -->',
      '// 见 fs/atomic.ts 的 serializedLockedWrite 快路段',
      'import { atomicWriteFile } from "../fs/atomic.js"',
      'const x = 1',
    ]) {
      expect(hits(line), line).toHaveLength(0)
    }
  })
})

describe('allowlist：承重锚注放行', () => {
  const allowlist = [{ file: 'ai/calls.ts', contains: 'R-5（第十六轮）', why: 'test/ai/calls.test.ts 源码锚钉住' }]

  it('file + contains 命中即放行（findTagHits 不再报）', () => {
    const src = '// R-5（第十六轮）：同 bookRoot 写操作经互斥队列串行化\n// R36-5 写侧已异步化'
    const all = findTagHits(src, { file: 'src/ai/calls.ts', allowlist })
    expect(all.map((h: TagHit) => h.match)).toEqual(['R36-5'])
  })

  it('isAllowlisted：路径后缀匹配 + 子串匹配，双条件缺一不放行', () => {
    expect(isAllowlisted('src/ai/calls.ts', '// R-5（第十六轮）', allowlist)).toBe(true)
    expect(isAllowlisted('ai/calls.ts', '// R-5（第十六轮）', allowlist)).toBe(true)
    expect(isAllowlisted('src/ai/other.ts', '// R-5（第十六轮）', allowlist)).toBe(false)
    expect(isAllowlisted('src/ai/calls.ts', '// 别的注释', allowlist)).toBe(false)
  })

  it('生产 allowlist 启动为空表——开工盘点零批号锚注的结论固化在此', () => {
    expect(ANCHOR_ALLOWLIST).toEqual([])
  })
})
