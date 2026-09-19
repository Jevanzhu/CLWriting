/**
 * 文档篇幅门（check-docs）直测。
 *
 * 本门由 2026-09-19 作者指令「也要保证后续不会塞废话进去」+「根目录 README 只是项目
 * 介绍，不要把项目进展什么的塞进去」而立，把「索引面只写结论 + 指针、介绍面禁进展」
 * 从自律升级为机器门（check-counts X-P2-16 先例）。锚定三档口径的边界语义与两个面的
 * 差异，防止本门自身漂移（尤其 main() 曾因裸拼 `file://` 判据静默不执行——门形同虚设，
 * 用例钉死直跑可执行性）。
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error —— .mjs 直跑脚本无类型声明（不为其维护 d.ts；断言口径靠用例锚定）
import { INDEX_FILES, INTRO_FILES, FORBIDDEN_PHRASES, FORBIDDEN_INTRO_PHRASES, isExemptLine, findLongLines, forbiddenPhrasesIn, findDateAnnotations, checkDocsIndex, checkIntroDoc } from '../../scripts/check-docs.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('isExemptLine：表格/围栏/URL 行豁免', () => {
  it('表格行、代码围栏、纯 URL 行豁免；普通长句不豁免', () => {
    expect(isExemptLine('| 目录 | 角色 | 实态 |')).toBe(true)
    expect(isExemptLine('```bash')).toBe(true)
    expect(isExemptLine('https://example.com/a/very/long/url')).toBe(true)
    expect(isExemptLine('这是一句很长的普通正文，不该被豁免。')).toBe(false)
  })
})

describe('findLongLines：超长行检出（旧实录的典型指纹）', () => {
  it('超限普通行命中、含行号与长度；表内超长行不误报', () => {
    const content = ['短行', '| ' + 'x'.repeat(500) + ' |', 'y'.repeat(300)].join('\n')
    const hits = findLongLines(content, 200)
    expect(hits).toHaveLength(1)
    expect(hits[0].line).toBe(3)
    expect(hits[0].length).toBe(300)
  })

  it('代码块内的超长行不误报（命令块天然长）', () => {
    const content = ['```bash', 'npm run x -- ' + 'a'.repeat(300), '```', 'z'.repeat(300)].join('\n')
    const hits = findLongLines(content, 200)
    expect(hits.map((h: { line: number }) => h.line)).toEqual([4])
  })
})

describe('forbiddenPhrasesIn：实录链签名捕获', () => {
  it('命中旧实录语料并带回 why 与行号', () => {
    const content = '正常开头\n前锚 **2026-09-18 win 实机重锚 64→68**：…'
    const hits = forbiddenPhrasesIn(content)
    expect(hits).toHaveLength(1)
    expect(hits[0].phrase).toBe('前锚 **')
    expect(hits[0].line).toBe(2)
    expect(hits[0].why).toContain('git 历史')
  })

  it('退役口径句「过数实测差 68 恒定」不触禁表（静态口径批后仅沿革扩展形态禁）', () => {
    expect(forbiddenPhrasesIn('win 实测 = 声称值 − 差值，**过数实测差 68 恒定**；')).toHaveLength(0)
    // 沿革扩展形态（重锚明细语料）照旧即红
    expect(forbiddenPhrasesIn('过数实测差 68 恒定〔73 既有 + …〕')).toHaveLength(1)
  })
})

describe('checkDocsIndex vs checkIntroDoc：索引面与介绍面口径不同', () => {
  const spec = { label: 'T', maxLine: 200, maxBytes: 500 }

  it('索引面放行产品义「拍板」，介绍面亦放行（仅禁「作者拍板」治理义）', () => {
    const line = 'AI 出初稿，你负责审稿和拍板。' + 'x'.repeat(10)
    expect(checkDocsIndex(line, spec)).toEqual([])
    expect(checkIntroDoc(line, spec)).toEqual([])
  })

  it('介绍面禁「作者拍板」等进展语料；索引面表不额外收该类词（口径分面）', () => {
    const content = '作者拍板入库。'
    expect(checkIntroDoc(content, spec).length).toBeGreaterThan(0)
    // 索引面表 = FORBIDDEN_PHRASES（实录链签名），「作者拍板」属介绍面加档
    expect(FORBIDDEN_INTRO_PHRASES.some((e: { phrase: string }) => e.phrase === '作者拍板')).toBe(true)
    expect(FORBIDDEN_PHRASES.some((e: { phrase: string }) => e.phrase === '作者拍板')).toBe(false)
  })

  it('介绍面独有禁档生效：批/轮/锚语料', () => {
    for (const bad of ['亲跑实录', '九门', '修复批', '差值锚', 'git show abc']) {
      const problems = checkIntroDoc(`正文含${bad}。`, spec)
      expect(problems.length).toBeGreaterThan(0)
    }
  })

  it('体积超限即报（索引面 500 字节上限）', () => {
    const problems = checkDocsIndex('a'.repeat(600), spec)
    expect(problems.some((p: string) => p.includes('体积'))).toBe(true)
  })
})

describe('findDateAnnotations：括号修订日期标注（规则文档禁）', () => {
  const spec = { label: 'T', maxLine: 500, maxBytes: 5000 }

  it('命中「（2026-09-19 …）」「（2026-09-19）」挂条日期标注', () => {
    expect(findDateAnnotations('- **篇幅纪律（2026-09-19 作者指令「…」）**：…')[0].text).toBe(
      '（2026-09-19 作者指令「…」）',
    )
    expect(findDateAnnotations('- **计划治理**（2026-08-23）：…')[0].text).toBe('（2026-08-23）')
    expect(findDateAnnotations('- 维护日期：2026-09-19。')).toHaveLength(0) // 非括号形态
  })

  it('文件名内日期放行（命名要素，非修订标注）', () => {
    const line = '| `03-设计/五大数据子系统归类规则-现行规范-2026-08-15.md` | 现行规范 |'
    expect(findDateAnnotations(line)).toHaveLength(0)
  })

  it('索引面禁日期标注；介绍面与索引面口径差异体现在 dateAnnotations 开关', () => {
    const content = '- **三拍板实施（2026-09-18）**：…'
    expect(checkDocsIndex(content, spec).length).toBeGreaterThan(0)
    expect(checkIntroDoc(content, spec).length).toBe(0) // 介绍面未开日期档
  })
})

describe('清单与直跑可执行性', () => {
  it('索引面三件 + 介绍面一件，无重复路径', () => {
    const paths = [...INDEX_FILES, ...INTRO_FILES].map((f: { path: string }) => f.path)
    expect(paths).toHaveLength(4)
    expect(new Set(paths).size).toBe(4)
    // 根 README 属介绍面，不得出现在索引面（作者指令：它只是项目介绍）
    expect(INDEX_FILES.some((f: { path: string }) => f.path === 'README.md')).toBe(false)
  })

  it('禁止短语表非空且每条带 why', () => {
    for (const list of [FORBIDDEN_PHRASES, FORBIDDEN_INTRO_PHRASES]) {
      expect(list.length).toBeGreaterThan(0)
      for (const e of list) expect(typeof e.why).toBe('string')
      expect(list.every((e: { why: string }) => e.why.length > 0)).toBe(true)
    }
  })

  it('npm run check:docs 直跑真执行 main()（曾因裸拼 file:// 判据静默不执行）', () => {
    // 门必须真跑——否则形同虚设。当前树合规时应 exit 0 且打印通过语。
    const out = execFileSync('node', [join(root, 'scripts', 'check-docs.mjs')], { encoding: 'utf8' })
    expect(out).toContain('check:docs 通过')
  })
})