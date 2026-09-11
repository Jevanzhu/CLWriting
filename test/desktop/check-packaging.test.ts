/**
 * P3（打包修复批）：check-packaging 的 package.json files 断言口径直测。
 *
 * 原实现用「两空格缩进 + 精确通配文本」正则锚定 files 块——格式微调（缩进/引号/
 * 顺序/成员后缀）即静默失效。修复后改为 JSON.parse + 数组成员断言（顺序/格式无关），
 * 本文件锚定：成员缺失必红、顺序/格式变化不误报、非数组形状必红、真实脚本对账绿。
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error —— .mjs 直跑脚本无类型声明（不为其维护 d.ts；断言口径靠用例锚定）
import { problemsForPackageFiles, parseBuilderFiles, problemsForElectronBuilderFiles, parseBuilderAsarUnpack, problemsForElectronBuilderAsarUnpack, problemsForDistFontList } from '../../scripts/check-packaging.mjs'

const scriptPath = fileURLToPath(new URL('../../scripts/check-packaging.mjs', import.meta.url))
const root = fileURLToPath(new URL('../../', import.meta.url))

describe('P3：package.json files 断言（JSON.parse 口径，顺序/格式无关）', () => {
  it('含 dist 与 resources → 无问题（顺序颠倒亦然）', () => {
    expect(problemsForPackageFiles(['dist', 'resources'])).toEqual([])
    expect(problemsForPackageFiles(['resources', 'dist'])).toEqual([])
  })

  it('缺 dist 或缺 resources → 各自一条问题（防回潮门不静默）', () => {
    expect(problemsForPackageFiles(['dist'])).toEqual([
      'package.json files 未包含 resources——npm 打包内容缺整目录（CC-P1-7 回潮）',
    ])
    expect(problemsForPackageFiles(['resources'])).toEqual([
      'package.json files 未包含 dist——npm 打包内容缺整目录（CC-P1-7 回潮）',
    ])
    expect(problemsForPackageFiles([])).toHaveLength(2)
  })

  it('格式微调不误报：成员带通配后缀/多余成员/嵌套空白', () => {
    expect(problemsForPackageFiles(['dist/**/*', 'resources/**/*', 'package.json'])).toEqual([])
  })

  it('files 非数组（被删/形状变了）→ 必红', () => {
    expect(problemsForPackageFiles(undefined)).toHaveLength(1)
    expect(problemsForPackageFiles('dist')).toHaveLength(1)
    expect(problemsForPackageFiles({})).toHaveLength(1)
  })

  it('真实仓库脚本直跑：退出码 0（versions.json 对账等整链不回归）', () => {
    const out = execFileSync('node', [scriptPath], { cwd: root, encoding: 'utf8' })
    expect(out).toContain('check:packaging 通过')
  })
})

describe('R62-22：electron-builder.yml files 断言（asar 实际打包面，勿正则钉格式）', () => {
  const YML = 'files:\n  - dist/**/*\n  - resources/**/*\n  - package.json\nasar: true\n'
  it('parseBuilderFiles：解析顶层 files 序列（容忍缩进/空行/注释）', () => {
    expect(parseBuilderFiles(YML)).toEqual(['dist/**/*', 'resources/**/*', 'package.json'])
    const messy = '# 注释\nfiles:\n    - dist/**/*\n\n  - resources/**/*\nasar: true\n'
    expect(parseBuilderFiles(messy)).toEqual(['dist/**/*', 'resources/**/*'])
    // R64-39（十二轮）：引号形态（YAML 合法）——此前原样入列（含引号）致成员资格误报
    const quoted = 'files:\n  - "dist/**/*"\n  - \'resources/**/*\'\nasar: true\n'
    expect(parseBuilderFiles(quoted)).toEqual(['dist/**/*', 'resources/**/*'])
  })
  it('含 dist 与 resources → 无问题；顺序颠倒亦然', () => {
    expect(problemsForElectronBuilderFiles(['dist/**/*', 'resources/**/*'])).toEqual([])
    expect(problemsForElectronBuilderFiles(['resources/**/*', 'dist/**/*'])).toEqual([])
  })
  it('缺 dist 或缺 resources → 各自一条（asar 打包面防回潮）', () => {
    expect(problemsForElectronBuilderFiles(['dist/**/*'])).toEqual([
      'electron-builder.yml files 未包含 resources——asar 打包缺整目录（CC-P1-7 回潮）',
    ])
    expect(problemsForElectronBuilderFiles(['resources/**/*'])).toEqual([
      'electron-builder.yml files 未包含 dist——asar 打包缺整目录（CC-P1-7 回潮）',
    ])
  })
  it('files 缺失/空 → 必红（视为配置缺失）', () => {
    expect(problemsForElectronBuilderFiles(null)).toEqual([
      'electron-builder.yml files 不可解析或为空——asar 打包内容清单没了/形状变了',
    ])
    expect(problemsForElectronBuilderFiles([])).toHaveLength(1)
  })
  it('真实 electron-builder.yml 经 parseBuilderFiles 后断言绿', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    expect(problemsForElectronBuilderFiles(parseBuilderFiles(yml))).toEqual([])
  })
})

// ── R0911-A-P2-1（2026-09-11 全量重评 GLM-5.3 修复批）：mac 字体二进制分发门直测 ──
describe('R0911-A-P2-1：electron-builder.yml asarUnpack 断言（spawn 不解 asar 的外置门）', () => {
  it('parseBuilderAsarUnpack：解析顶层序列（容忍缩进/空行/注释/引号，与 parseBuilderFiles 同口径）', () => {
    const yml = 'asar: true\nasarUnpack:\n  - desktop/fontlist\nfiles:\n  - dist/**/*\n'
    expect(parseBuilderAsarUnpack(yml)).toEqual(['desktop/fontlist'])
    const messy = '# 注释\nasarUnpack:\n    - "desktop/fontlist"\n\n  - ' + "'other'\n" + 'asar: true\n'
    expect(parseBuilderAsarUnpack(messy)).toEqual(['desktop/fontlist', 'other'])
    expect(parseBuilderAsarUnpack('asar: true\nfiles:\n  - dist/**/*\n')).toBe(null)
  })
  it('含 desktop/fontlist → 无问题；通配/多余成员不误报', () => {
    expect(problemsForElectronBuilderAsarUnpack(['desktop/fontlist'])).toEqual([])
    expect(problemsForElectronBuilderAsarUnpack(['other/dir/**', 'desktop/fontlist'])).toEqual([])
  })
  it('缺 desktop/fontlist / 序列缺失为空 → 必红（A-P2-1 半修回潮形态）', () => {
    expect(problemsForElectronBuilderAsarUnpack(['other/**'])).toHaveLength(1)
    expect(problemsForElectronBuilderAsarUnpack(null)).toHaveLength(1)
    expect(problemsForElectronBuilderAsarUnpack([])).toHaveLength(1)
  })
  it('真实 electron-builder.yml 经 parseBuilderAsarUnpack 后断言绿', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    expect(problemsForElectronBuilderAsarUnpack(parseBuilderAsarUnpack(yml))).toEqual([])
  })
})

describe('R0911-A-P2-1：problemsForDistFontList（darwin dist 实存门，注入平台不依赖宿主）', () => {
  it('非 darwin 平台恒过（win/linux 腿 dist 无二进制属预期）', () => {
    expect(problemsForDistFontList('/whatever/dist/desktop', 'win32')).toEqual([])
    expect(problemsForDistFontList('/whatever/dist/desktop', 'linux')).toEqual([])
  })
  it('darwin 但 dist 未构建（无 main.js）→ 跳过不误报（纯本地 check 不 build 场景）', () => {
    expect(problemsForDistFontList(join(tmpdir(), 'clw-no-such-dist-' + Date.now()), 'darwin')).toEqual([])
  })
  it('darwin dist 已构建（有 main.js）缺 fontlist → 必红（tsup onSuccess 拷贝失效回潮）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clw-pkg-gate-'))
    writeFileSync(join(dir, 'main.js'), '// built')
    const problems = problemsForDistFontList(dir, 'darwin')
    expect(problems).toHaveLength(1)
    expect(String(problems[0])).toContain('fontlist')
  })
})
