/**
 * P3（打包修复批）：check-packaging 的 package.json files 断言口径直测。
 *
 * 原实现用「两空格缩进 + 精确通配文本」正则锚定 files 块——格式微调（缩进/引号/
 * 顺序/成员后缀）即静默失效。修复后改为 JSON.parse + 数组成员断言（顺序/格式无关），
 * 本文件锚定：成员缺失必红、顺序/格式变化不误报、非数组形状必红、真实脚本对账绿。
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import {
  problemsForPackageFiles,
  parseBuilderFiles,
  problemsForElectronBuilderFiles,
  parseBuilderAsarUnpack,
  problemsForElectronBuilderAsarUnpack,
  problemsForElectronBuilderNodeModulesExclusion,
  problemsForDistFontList,
  parseTsupNoExternal,
  problemsForDepsNoExternal,
  problemsForDepsVersionSync,
  // @ts-expect-error —— .mjs 直跑脚本无类型声明（不为其维护 d.ts；断言口径靠用例锚定）。
  // 注记须紧贴 `} from` 行（TS 把 TS7016 报在模块说明符所在行），故放字面量末项之后。
} from '../../scripts/check-packaging.mjs'

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
    // R0912（重评-0911c P2）：单测不把不受控的本地 dist 构建产物状态当断言对象——
    // dist 半新态（main.js 在而 fontlist 缺）曾使本用例红、全量单测单点红。置
    // CLW_CHECK_PACKAGING_SKIP_DIST_GATE=1 跳过 dist 实存门，只锁配置面与资源对账面；
    // dist 门自身语义由 problemsForDistFontList 直测锚定（下方 describe），CI 不设
    // 此变量、门照常生效。
    const out = execFileSync('node', [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CLW_CHECK_PACKAGING_SKIP_DIST_GATE: '1' },
    })
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
// R0912-A-P2-1（2026-09-12 独立重评修复批）：覆盖形态修正为 dist/desktop/fontlist——
// files 规则 `dist/**/*` 下 asar 内路径带 dist/ 段（app-builder-lib FileMatcher 以
// appDir 相对路径做 minimatch），裸 desktop/fontlist 零命中 = 无效外置（假绿）。
describe('R0911-A-P2-1：electron-builder.yml asarUnpack 断言（spawn 不解 asar 的外置门）', () => {
  it('parseBuilderAsarUnpack：解析顶层序列（容忍缩进/空行/注释/引号，与 parseBuilderFiles 同口径）', () => {
    const yml = 'asar: true\nasarUnpack:\n  - dist/desktop/fontlist\nfiles:\n  - dist/**/*\n'
    expect(parseBuilderAsarUnpack(yml)).toEqual(['dist/desktop/fontlist'])
    const messy = '# 注释\nasarUnpack:\n    - "dist/desktop/fontlist"\n\n  - ' + "'other'\n" + 'asar: true\n'
    expect(parseBuilderAsarUnpack(messy)).toEqual(['dist/desktop/fontlist', 'other'])
    expect(parseBuilderAsarUnpack('asar: true\nfiles:\n  - dist/**/*\n')).toBe(null)
  })
  it('可命中 dist/desktop/fontlist 的模式 → 无问题（R0912 两线模式族并集；通配/多余成员不误报）', () => {
    expect(problemsForElectronBuilderAsarUnpack(['**/desktop/fontlist'])).toEqual([])
    expect(problemsForElectronBuilderAsarUnpack(['dist/desktop/fontlist'])).toEqual([])
    expect(problemsForElectronBuilderAsarUnpack(['other/dir/**', '**/desktop/fontlist'])).toEqual([])
    expect(problemsForElectronBuilderAsarUnpack(['other/dir/**', 'dist/desktop/fontlist'])).toEqual([])
  })
  it('R0912 反向钉：旧错误形态裸 desktop/fontlist（R0911 首修形态——漏 dist/ 前缀，asar 内零命中的无效外置）→ 必红', () => {
    const problems = problemsForElectronBuilderAsarUnpack(['desktop/fontlist'])
    expect(problems).toHaveLength(1)
    expect(String(problems[0])).toContain('R0912')
    expect(String(problems[0])).toContain('dist/desktop/fontlist')
  })
  it('缺 dist/desktop/fontlist / 序列缺失为空 → 必红（A-P2-1 半修回潮形态）', () => {
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
    const dir = mkdtempTracked(join(tmpdir(), 'clw-pkg-gate-'))
    writeFileSync(join(dir, 'main.js'), '// built')
    const problems = problemsForDistFontList(dir, 'darwin')
    expect(problems).toHaveLength(1)
    expect(String(problems[0])).toContain('fontlist')
  })
})

// ── 单立清账批（2026-09-17）：node_modules 全排除项锚定门直测 ──
// 0917清库修复批的排除行此前无静态门（误删只能靠 packaged-app-smoke/CI 冒烟迟面拦截），
// 本门锁 files 含 '!node_modules/**'（精确钉形态：收窄形态漏子层即红）。
describe('单立清账批：electron-builder.yml node_modules 全排除项断言', () => {
  it('含 !node_modules/** → 无问题（多余成员/其他否定模式不误报）', () => {
    expect(
      problemsForElectronBuilderNodeModulesExclusion(['dist/**/*', 'resources/**/*', '!**/._*', '!node_modules/**']),
    ).toEqual([])
  })
  it('排除项缺失 / 被收窄（漏子层形态）→ 必红（0917清库修复批回潮）', () => {
    expect(problemsForElectronBuilderNodeModulesExclusion(['dist/**/*', 'resources/**/*'])).toHaveLength(1)
    expect(problemsForElectronBuilderNodeModulesExclusion(['dist/**/*', '!node_modules'])).toHaveLength(1)
  })
  it('files 缺失/空 → 必红（视为配置缺失）', () => {
    expect(problemsForElectronBuilderNodeModulesExclusion(null)).toHaveLength(1)
    expect(problemsForElectronBuilderNodeModulesExclusion([])).toHaveLength(1)
  })
  it('真实 electron-builder.yml 经 parseBuilderFiles 后断言绿（引号已剥）', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    expect(problemsForElectronBuilderNodeModulesExclusion(parseBuilderFiles(yml))).toEqual([])
  })
})

// ── RC 全项目重审（GLM-5.3，2026-09-20）P2-2：裸包外置回潮静态门直测 ──
// rc.0 假绿链根因形态（dependencies 裸包漏收 noExternal × asar 排除 node_modules）此前
// 无 PR 级门——本门 dependencies ⊆ tsup noExternal 的断言口径锚定。
describe('RC 重审 P2-2：parseTsupNoExternal / problemsForDepsNoExternal', () => {
  it('行内数组解析：引号剥除、多段并集、双引号/单引号皆可', () => {
    expect(parseTsupNoExternal(`noExternal: ['a', "b"],`)).toEqual(['a', 'b'])
    expect(parseTsupNoExternal("noExternal: ['a']\n// 注释\nnoExternal: ['b', 'c']")).toEqual(['a', 'b', 'c'])
    expect(parseTsupNoExternal('noExternal: [ ]')).toEqual([])
  })
  it('解析不到任何段 / 表达式形态成员 → 空并集（由断言函数按 fail-closed 判红）', () => {
    expect(parseTsupNoExternal('')).toEqual([])
    expect(parseTsupNoExternal('noExternal: DEPS // 表达式形态')).toEqual([])
  })
  it('deps ⊆ noExternal → 无问题；漏收一个 → 红且点名', () => {
    expect(
      problemsForDepsNoExternal({ '@anthropic-ai/sdk': '^1', openai: '^2' }, [
        '@anthropic-ai/sdk',
        'openai',
        'font-list',
      ]),
    ).toEqual([])
    const problems = problemsForDepsNoExternal({ '@anthropic-ai/sdk': '^1', 'new-dep': '^3' }, [
      '@anthropic-ai/sdk',
      'openai',
    ])
    expect(problems).toHaveLength(1)
    expect(String(problems[0])).toContain('new-dep')
    expect(String(problems[0])).toContain('noExternal')
  })
  it('deps 非空而 noExternal 空 → 红（配置形状变了不许静默过）；deps 空 → 恒绿', () => {
    expect(problemsForDepsNoExternal({ openai: '^2' }, [])).toHaveLength(1)
    expect(problemsForDepsNoExternal({}, [])).toEqual([])
  })
  it('真实仓库面：package.json dependencies 三件 ⊆ tsup.config.ts noExternal', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const tsup = readFileSync(join(root, 'tsup.config.ts'), 'utf8')
    expect(problemsForDepsNoExternal(pkg.dependencies, parseTsupNoExternal(tsup))).toEqual([])
  })
})

// ── RC 全项目重审（GLM-5.3，2026-09-20）P3-15：根/子包重复依赖版本同步门直测 ──
describe('RC 重审 P3-15：problemsForDepsVersionSync（双包同名依赖声明一致性）', () => {
  it('同名同声明 → 无问题；单侧独有 → 无问题（只辖交集）', () => {
    expect(problemsForDepsVersionSync({ vue: '^3.5.42' }, { vue: '^3.5.42', vite: '^8.0.16' })).toEqual([])
    expect(problemsForDepsVersionSync({ typescript: '^5.5.0' }, {})).toEqual([])
  })
  it('同名异声明 → 红且点名两侧区间', () => {
    const problems = problemsForDepsVersionSync({ typescript: '^5.5.0' }, { typescript: '^5.6.0' })
    expect(problems).toHaveLength(1)
    expect(String(problems[0])).toContain('typescript')
    expect(String(problems[0])).toContain('^5.5.0')
    expect(String(problems[0])).toContain('^5.6.0')
  })
  it('真实仓库面：根包与 web-next 子包交集声明一致（typescript 漂移已随批对齐）', () => {
    const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const subPkg = JSON.parse(readFileSync(join(root, 'src/studio/web-next/package.json'), 'utf8'))
    const merge = (p: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }) => ({
      ...(p.dependencies ?? {}),
      ...(p.devDependencies ?? {}),
    })
    expect(problemsForDepsVersionSync(merge(rootPkg), merge(subPkg))).toEqual([])
  })
})
