/**
 * P3（打包修复批）：check-packaging 的 package.json files 断言口径直测。
 *
 * 原实现用「两空格缩进 + 精确通配文本」正则锚定 files 块——格式微调（缩进/引号/
 * 顺序/成员后缀）即静默失效。修复后改为 JSON.parse + 数组成员断言（顺序/格式无关），
 * 本文件锚定：成员缺失必红、顺序/格式变化不误报、非数组形状必红、真实脚本对账绿。
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error —— .mjs 直跑脚本无类型声明（不为其维护 d.ts；断言口径靠用例锚定）
import { problemsForPackageFiles, parseBuilderFiles, problemsForElectronBuilderFiles } from '../../scripts/check-packaging.mjs'

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
