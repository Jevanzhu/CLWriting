/**
 * sanitizeFileNamePart 纯函数直测（P2——win 适配批 2 升格单一真相源后此前仅靠
 * 调用方间接覆盖：style-entry/foreshadow/tree/export 各测各的路径，净化本体行为
 * 无直测锚定）。纯字符串进出零落盘，跨平台直跑（win 语义——保留名/尾点——按
 * 「mac 同样执行，保持数据面跨平台一致」口径在所有平台生效）。
 */
import { describe, expect, it } from 'vitest'
import { RESERVED_WIN, sanitizeChapterTitle, sanitizeFileNamePart, sanitizeFullFileName, chapterNoFromName } from '../../src/format/filename.js'

describe('非法字符与穿越', () => {
  it('win 非法字符集全替换 _（含路径分隔符，防 ../ 越出 bookRoot）', () => {
    expect(sanitizeFileNamePart('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
  })

  // R1010c-EN-P3-x（2026-09-10 全量独立复审修复批）核查销项：ASCII 非法字符
  // ：" < > | ? *（含分隔符 \ /）在 sanitizeFileNamePart / sanitizeFullFileName 两入口
  // 均已被 `[\\/:*?"<>|]` 字符类替换 _（filename.ts 消毒正则既有），无缺口——补全角
  // 冒号不受影响的对照断言 + 既有合法命名不回归，钉住边界防未来过加宽误伤中文排印
  it('全角冒号（：U+FF1A）不在非法集，原样保留；既有合法命名不回归（R1010c-EN-P3-x 对照）', () => {
    expect(sanitizeFileNamePart('雨夜：追杀')).toBe('雨夜：追杀')
    expect(sanitizeFullFileName('雨夜：追杀.md')).toBe('雨夜：追杀.md')
    expect(sanitizeFileNamePart('第一章：风起')).toBe('第一章：风起')
  })

  it('控制字符剥除（含换行/回车/制表/空字符/DEL——块标量多行标题会带出）', () => {
    expect(sanitizeFileNamePart('标\u0000题\n换行\r回车\t制表\u007f')).toBe('标题换行回车制表')
  })

  it('穿越不变式：任意组合输入产出不含分隔符/冒号/控制字符', () => {
    const out = sanitizeFileNamePart('../../..\\..:CON\u0000x[[y]].md \t\n')
    expect(out).not.toMatch(/[/\\:]/)
    expect(out).not.toMatch(/[\u0000-\u001f\u007f]/)
  })
})

describe('[[ ]] 转义（X-P2-9，防文件名解析成链接文本）', () => {
  it('[[ ]] 成对替换全角括号', () => {
    expect(sanitizeFileNamePart('伏笔[[暗线]]标记')).toBe('伏笔（暗线）标记')
  })
})

describe('win 兼容再处理（尾点/保留名，mac 同样执行）', () => {
  it('尾点/尾空格剥离（win 落盘自动剖名导致读写名不一致）', () => {
    expect(sanitizeFileNamePart('终章...  ')).toBe('终章')
  })

  it('全点/全空格/空串 → 空兜底「未命名」', () => {
    expect(sanitizeFileNamePart('...')).toBe('未命名')
    expect(sanitizeFileNamePart('   ')).toBe('未命名')
    expect(sanitizeFileNamePart('')).toBe('未命名')
  })

  it('保留设备名避让：裸名/带扩展名/大小写不敏感/多级扩展均加 _ 前缀；普通含点名不误伤', () => {
    expect(sanitizeFileNamePart('CON')).toBe('_CON')
    expect(sanitizeFileNamePart('con.md')).toBe('_con.md')
    expect(sanitizeFileNamePart('LPT1.tar.gz')).toBe('_LPT1.tar.gz')
    expect(sanitizeFileNamePart('CLOCK$')).toBe('_CLOCK$')
    expect(sanitizeFileNamePart('第一章.序')).toBe('第一章.序')
  })
})

describe('码位 + 字节双封顶（不切多字节字符）', () => {
  it('默认 60 码位截断（2B 字符 60 字恰达 120B 字节预算，码位上限为约束边）', () => {
    expect(sanitizeFileNamePart('а'.repeat(80))).toBe('а'.repeat(60))
  })

  it('字节预算先行收口（3B 汉字 120B 预算 = 40 字，未达码位上限）', () => {
    expect(sanitizeFileNamePart('一'.repeat(59) + '😀')).toBe('一'.repeat(40))
  })

  it('预算参数可覆写（export 侧 80 码位 / 后缀感知字节口径）', () => {
    expect(sanitizeFileNamePart('一'.repeat(100), 80, 200)).toBe('一'.repeat(66))
  })
})

describe('RESERVED_WIN 契约锚定', () => {
  it('保留设备名全集（CON/PRN/AUX/NUL/CLOCK$ + COM1-9 + LPT1-9，共 23 项）', () => {
    expect([...RESERVED_WIN].sort()).toEqual(
      [
        'CON', 'PRN', 'AUX', 'NUL', 'CLOCK$',
        ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
        ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
      ].sort(),
    )
    expect(RESERVED_WIN.size).toBe(23)
  })
})

describe('sanitizeChapterTitle：单源委托等值', () => {
  it('保留原名单源收敛——委托 sanitizeFileNamePart 等值', () => {
    for (const s of ['雨夜:追杀', 'CON', '终章...  ', '一'.repeat(80), '[[伏笔]]']) {
      expect(sanitizeChapterTitle(s)).toBe(sanitizeFileNamePart(s))
    }
  })
})

describe('NFC 归一（平台规范化批一 C）', () => {
  it('NFD 文件名段入口即归一 NFC（创建面生而规范；兼容字符保留不越权改内容）', () => {
    const nfc = '가'
    const nfd = nfc.normalize('NFD')
    expect(nfd).not.toBe(nfc)
    expect(sanitizeFileNamePart(`1-${nfd}`)).toBe(`1-${nfc}`)
    expect(sanitizeFileNamePart(`1-${nfc}`)).toBe(`1-${nfc}`)
    // 兼容分解字符（ﷺ U+FDFA 等）NFC 不分解——归一只做 NFC，不做 NFKC（防越权改义）
    expect(sanitizeFileNamePart('ﷺ')).toBe('ﷺ')
  })

  it('sanitizeFullFileName 同口径 NFC + 尾点清理次序（NFC 在前，清理不受影响）', () => {
    const nfc = '가'
    const nfd = nfc.normalize('NFD')
    expect(sanitizeFullFileName(`章${nfd}.md`)).toBe(`章${nfc}.md`)
    expect(sanitizeFullFileName(`章${nfc}..`)).toBe(`章${nfc}`)
  })
})

describe('sanitizeFullFileName：纯点文件（R49-14）', () => {
  it('纯点名（.gitignore）按「无扩展名的完整名」处理——原样通过，不再产出 未命名.gitignore', () => {
    expect(sanitizeFullFileName('.gitignore')).toBe('.gitignore')
    expect(sanitizeFullFileName('.md')).toBe('.md')
  })

  it('常规多点/带扩展名/兜底行为不回退（stem 非空时扩展名照常保留）', () => {
    expect(sanitizeFullFileName('.foo.bar')).toBe('.foo.bar')
    expect(sanitizeFullFileName('章.md')).toBe('章.md')
    expect(sanitizeFullFileName('第一章.序')).toBe('第一章.序')
    expect(sanitizeFullFileName('终章...')).toBe('终章')
    // 全点/空串仍走「未命名」兜底（pre 已剥成空串，不在纯点豁免之列）
    expect(sanitizeFullFileName('')).toBe('未命名')
    expect(sanitizeFullFileName('...')).toBe('未命名')
  })
})

// R1010-P3（2026-09-10 全量重评 GLM-5.3 修复批）：文件名前导章号提取单一真相源直测——
// 此前 tree/leads/foreshadow/summary 四处正则漂移（宽容集 vs 仅 -），`5—标题.md` 树排序
// 认得、伏笔足迹/线索核验/摘要自愈静默缺章；单源后钉住宽容集防再漂移
describe('chapterNoFromName 章号提取（单一真相源）', () => {
  it('宽容分隔集：短横/长划/空白分隔均认（与 tree 排序口径一致）', () => {
    expect(chapterNoFromName('0001-开篇.md')).toBe(1)
    expect(chapterNoFromName('1-标题.md')).toBe(1)
    expect(chapterNoFromName('5—标题.md')).toBe(5)
    expect(chapterNoFromName('5 标题.md')).toBe(5)
    // `$` 备选只对裸数字名（无扩展名）成立；`5.md` 数字后是 `.` 非分隔符 → null
    //（tree 原口径一致——正文文件恒带 .md，裸数字名现实不存在，防误读钉住该边界）
    expect(chapterNoFromName('5.md')).toBeNull()
    expect(chapterNoFromName('5')).toBe(5)
  })

  it('非数字前缀/数字后无分隔符 → null（副本/设定类不误判）', () => {
    expect(chapterNoFromName('副本-001.md')).toBeNull()
    expect(chapterNoFromName('设定-x.md')).toBeNull()
    expect(chapterNoFromName('2023年度盘点-备份.md')).toBeNull() // 数字后直接接汉字非分隔符
  })
})
