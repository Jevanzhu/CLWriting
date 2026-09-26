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
  stripTagSpans,
  tagSpansOf,
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
    ['// 2026-09-11 全量重评', ['2026-09-11', '重评']],
    ['// RC 源码重审 A-8：更名', ['重审', 'A-8']],
    ['// 复审-0914-优化修复批 C1 单源移位', ['复审', '0914', '修复批', 'C1']],
    // 批名形态（后缀闭集）与裸轮次（无「第」无括注）——批 5 清理器的病史正在这两形：
    // 前者靠「后缀 + 批 + 非汉字」，后者靠前后视挡「下一轮 / 本轮 / 轮次」。
    // 注：`0918二轮修复批` 的 `二轮` 由**切除期**的前缀补齐吞掉（`expandLeft`），门只报
    // `0918` 与 `修复批`——门判定面窄（零误报优先），切除面宽由补齐兜住，二者口径不同。
    ['// 0918二轮修复批：收尾', ['0918', '修复批']],
    ['// 临时目录收敛批 记批', ['收敛批']],
    ['// 收口·拍板快断批：旧迁移存量', ['快断批']],
    ['// 四轮-A404：单槽缓存改小 LRU', ['四轮', 'A404']],
    [
      '// 见 fs/lock-file.ts 快路段（复审-0914-优化修复批 C1 单源移位；R0916-7-P3-3 起居新家）',
      ['复审', '0914', '修复批', 'C1', 'R0916-7-P3-3'],
    ],
    // 二级域号（`L-A3`/`E-N1`/`L-S2`）——`-` 后跟字母再跟数字，一级形（`A-6`/`H-1`）的
    // 旧正则要求 `-` 后**立即**是数字，于是这类域号全成黑洞；批 5 清理正因判不出而把
    // `L-A3（第八轮）` 切成 `L-` 半截桩（`L-` 自身也判不出，永远修不回来）。
    ['// L-A3（第八轮）：事件库降级（store=null）时 regenerate', ['L-A3', '第八轮']],
    ['// E-N1 域内条目已收口', ['E-N1']],
    // 批次词两侧同现（`D3 批 5`）整段算一个标签：拆成「前缀+批」「批+序号」两支时，
    // 左支会在更靠左处先命中、吃掉两支共用的 `批`，剥完残留 `（5 起三口径` 半截序号。
    ['// 预算判定（D3 批 5 起三口径：次数 / tokens / cost）', ['D3 批 5']],
  ])('命中：%s → %j', (line, matches) => {
    const h = hits(line)
    expect(h.map((x) => x.match)).toEqual(matches)
  })

  it('点号里程碑号不误伤（B0.2 / E3.3 / T2.1 / W1.5 是设计文档块号，不是批号）', () => {
    for (const line of [
      '// M12 B0.2/B4 拆 3 子问题',
      '// 块 B0.1/B0.2/B0.5 依次落',
      '// E3.3 与 T2.1 同源',
      '// W1.5 三面单源',
    ]) {
      expect(hits(line), line).toHaveLength(0)
    }
  })

  it('斜杠兄弟形右半不误伤（左邻是域号即属引用别的号，不是残桩）', () => {
    for (const line of [
      '// severity 人话（S1/S2→重点，其余→参考）',
      '// G1/G3 特性未生效',
      '// 动作类型（状态机/#18/M2 流程谁来接）',
    ]) {
      expect(hits(line), line).toHaveLength(0)
    }
  })

  it('孤儿斜杠域号必报（左邻是空白 / 标点 = 兄弟号被切走留下的残桩）', () => {
    for (const line of [
      '// /D4：长任务门控包装 + 生成失败状态映射单源',
      '// 链上 fork 新 child 成孤儿（/S1 同向）。拆分后旗正本在 lifecycle.ts',
      '// ROLLBACK 抛 "no transaction is active" 会掩蔽原始写错误（/C4 加固）——',
      "// Book 重挂（/book/A → /shelf）后首跑为 ''/F1 双双跳过",
    ]) {
      expect(hits(line), line).not.toHaveLength(0)
    }
  })

  it('孤儿斜杠形不误伤 URL 路径与正则字面量（不含数字的斜杠串）', () => {
    for (const line of [
      '// 原裸子串（/SSE/、/network/、/429/、/invalid.*key/）收窄为子串匹配',
      '// /API/ 大写前缀（含裸 /api，无尾斜杠）在静态回退前兜一道',
      '// win 保留设备名请求拦截（/CON、/nul.txt 等）——stat 可解析到设备',
      '// stdio 子进程 stderr（Node 警告/V8 诊断整行进档）',
    ]) {
      expect(hits(line), line).toHaveLength(0)
    }
  })

  it('括注轮次带内容必报（`（N轮…）` 的 `轮` 后随汉字，前后视两形都不收）', () => {
    for (const line of [
      '// （二十二轮批 A）：message_start 已实测的 cache 两档原样保留',
      '// （七十四轮批 D）：颜色格式白名单——此前只验 typeof',
      '// （十五轮登记销账）：进程内参数表版本常量',
    ]) {
      expect(hits(line), line).not.toHaveLength(0)
    }
  })

  it('「N 轮」作实义量词时不误伤（一轮最多一个工具调用是领域语义，不是轮次叙事）', () => {
    for (const line of ['// 「一轮最多一个工具调用」是 chat 的硬约束', '// 二轮审校后收口']) {
      expect(hits(line), line).toHaveLength(0)
    }
  })

  it('单字母域号不在拉丁词 / 术语内片段命中', () => {
    for (const line of [
      '// UTF-8 编码',
      '// SHA-256 摘要',
      '// GB2312 字符集',
      '// fooR40 变量',
      '// R40foo 变量',
      '// GLM-5.3 适配',
    ]) {
      expect(hits(line), line).toHaveLength(0)
    }
  })

  it('裸轮次前后视挡真词（下一轮 / 本轮 / 轮次 / 轮询不受影响）', () => {
    for (const line of ['// 下一轮生效', '// 本轮不做', '// 轮次口径', '// 轮询退避']) {
      expect(hits(line), line).toHaveLength(0)
    }
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

describe('stripTagSpans：切除粒度与门同源', () => {
  it('剥标签不碰正文里的空参数表（`()` 曾被「空括注整删」误吃，是实打实的正文损伤）', () => {
    expect(stripTagSpans('// timer.refresh() 重置——六轮重评 B101 勘误：Node 语义')).toBe(
      '// timer.refresh() 重置——勘误：Node 语义',
    )
    expect(stripTagSpans('// 干净行：clearTimeout() 与 refresh() 都该原样')).toBe(
      '// 干净行：clearTimeout() 与 refresh() 都该原样',
    )
  })

  it('无标签可剥时逐字原样返回（标点收敛不在干净行上行使改写权）', () => {
    for (const line of ['// 无标签：JSON 损坏不静默取空（保守阻断）', '// A 与 B 之间无空格——破折号是正文']) {
      expect(stripTagSpans(line)).toBe(line)
    }
  })

  it('二级域号整段切除，不留 `L-` 半截桩', () => {
    expect(stripTagSpans('// L-A3（第八轮）：事件库降级（store=null）时 regenerate')).toBe(
      '// 事件库降级（store=null）时 regenerate',
    )
  })

  it('批次词两侧同现整体带走，不残半截序号', () => {
    expect(stripTagSpans('// 预算判定（D3 批 5 起三口径：次数 / tokens）')).toBe(
      '// 预算判定（起三口径：次数 / tokens）',
    )
  })

  it('过程词左侧裸轮次由补齐吞掉（否则剥完留 `——六轮勘误`）', () => {
    expect(stripTagSpans('// 重置」——六轮重评 B101 勘误')).toBe('// 重置」——勘误')
  })

  it('纯标签括注整删，括注内混正文时只删标签（留对称括注）', () => {
    expect(stripTagSpans('// 闸门（P3-1）生效')).toBe('// 闸门生效')
    expect(stripTagSpans('// 闸门（P3-1：保守阻断）生效')).toBe('// 闸门（保守阻断）生效')
  })

  it('孤儿斜杠连斜杠一起切走，不留 `// /三段` 这类残桩', () => {
    expect(stripTagSpans('// /D4：长任务门控包装 + 生成失败状态映射单源')).toBe(
      '// 长任务门控包装 + 生成失败状态映射单源',
    )
    expect(stripTagSpans('// 链上 fork 新 child 成孤儿（/S1 同向）。拆分后旗正本在 lifecycle.ts')).toBe(
      '// 链上 fork 新 child 成孤儿。拆分后旗正本在 lifecycle.ts',
    )
  })

  it('剥净后零命中——门与切除器同一形态表，剥完必过门', () => {
    for (const line of [
      '// R40-2（三十四轮）：读侧改异步孪生',
      '// 0918二轮修复批：收尾（A404 条目）',
      '// 预算判定（D3 批 5 起三口径）',
      '// L-A3（第八轮）：事件库降级',
    ]) {
      expect(findTagHits(stripTagSpans(line)), line).toHaveLength(0)
    }
  })

  it('tagSpansOf 去重叠后跨度互不相交（切除不重不漏）', () => {
    const spans = tagSpansOf('// R0916-7-P3-3 与 D3 批 5 同批')
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end)
  })
})
