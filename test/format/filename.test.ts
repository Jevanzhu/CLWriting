/**
 * sanitizeFileNamePart 纯函数直测（P2——win 适配批 2 升格单一真相源后此前仅靠
 * 调用方间接覆盖：style-entry/foreshadow/tree/export 各测各的路径，净化本体行为
 * 无直测锚定）。纯字符串进出零落盘，跨平台直跑（win 语义——保留名/尾点——按
 * 「mac 同样执行，保持数据面跨平台一致」口径在所有平台生效）。
 */
import { describe, expect, it } from 'vitest'
import { RESERVED_WIN, sanitizeChapterTitle, sanitizeFileNamePart } from '../../src/format/filename.js'

describe('非法字符与穿越', () => {
  it('win 非法字符集全替换 _（含路径分隔符，防 ../ 越出 bookRoot）', () => {
    expect(sanitizeFileNamePart('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
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
