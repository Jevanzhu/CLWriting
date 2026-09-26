// 全库重评-0914（P3-10）：electron-builder.yml files 的 AppleDouble 排除项门直测。
//
// 背景：外置/网络构建卷上 macOS 为每个文件生成 ._ 伴生文件（资源叉），files 白名单
// `dist/**/*` 通配会把它们一并打进 asar。修复 = files 补否定模式 '!**/._*'（引号防
// YAML 把开头 ! 当 tag）；本文件锚定 check-packaging.mjs 新增的
// problemsForElectronBuilderAppleDouble 纯函数 + 真实 yml 的排除项存在性。
// 独立函数而非并入 problemsForElectronBuilderFiles 的缘由见该函数头注（不破存量锚定）。
// 注：全文件头注用行注释——块注释内书写 '!**/._*' 字面量时其中的 */ 会提前终止注释。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error —— .mjs 直跑脚本无类型声明（同 check-packaging.test.ts 口径）
import { parseBuilderFiles, problemsForElectronBuilderAppleDouble } from '../../scripts/check-packaging.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

describe('全库重评-0914 P3-10：electron-builder.yml AppleDouble 排除项门', () => {
  it('parseBuilderFiles：剥引号后否定模式原样入列（YAML 合法的引号形态）', () => {
    const yml = "files:\n  - dist/**/*\n  - '!**/._*'\nasar: true\n"
    expect(parseBuilderFiles(yml)).toEqual(['dist/**/*', '!**/._*'])
  })

  it('含 !**/._* → 无问题；缺之 → 一条问题点名排除模式', () => {
    expect(problemsForElectronBuilderAppleDouble(['dist/**/*', 'resources/**/*', 'package.json', '!**/._*'])).toEqual(
      [],
    )
    const problems = problemsForElectronBuilderAppleDouble(['dist/**/*', 'resources/**/*', 'package.json'])
    expect(problems).toHaveLength(1)
    expect(String(problems[0])).toContain('!**/._*')
    expect(String(problems[0])).toContain('P3-10')
  })

  it('files 缺失/空 → 必红（排除项无从校验）', () => {
    expect(problemsForElectronBuilderAppleDouble(null)).toHaveLength(1)
    expect(problemsForElectronBuilderAppleDouble([])).toHaveLength(1)
  })

  it('真实 electron-builder.yml 含排除项：经 parseBuilderFiles 后断言绿（防回潮）', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const files = parseBuilderFiles(yml)
    expect(files).toContain('!**/._*')
    expect(problemsForElectronBuilderAppleDouble(files)).toEqual([])
  })
})
