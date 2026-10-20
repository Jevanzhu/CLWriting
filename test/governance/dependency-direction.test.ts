/**
 * G5 依赖方向守护（M10 §2）—— 编辑器/底座源码不得 import AI 生成层。
 *
 * 防回潮：G1/G2 已清 document 的死代码违规；本测试常驻，断言不新增反向依赖。
 * 已知业务依赖（非死代码，待后续接口反转/下沉治理）入 KNOWN 白名单；
 * 某条治理后从白名单移除，第二个用例会提醒清理。
 * 扫描面为 .ts + .vue（SFC 只取 <script> 块）；并锚 web-next 跨包面：只许
 * src/shared/** 与包内相对 import（见下方 scanWebnextEscapes）。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// R62-58：仓库根按 import.meta.url 解析——此前 cwd 相对（join('src',...)），非根目录跑即错

const root = fileURLToPath(new URL('../../', import.meta.url)) // R62-58

/** 编辑器/底座模块（禁止 import AI 生成层）。review 归编辑器辅助，同守。 */
const EDITOR_BASE = [
  'document',
  'fs',
  'format',
  'cache',
  'git',
  'export',
  'import',
  'install',
  'metrics',
  'impact',
  'check',
  'review',
]
/** AI 生成层模块（被禁目标）。 */
const AI_LAYER = [
  'ai',
  'auto',
  'driver',
  'finalize',
  'gate',
  'knowledge',
  'learn',
  'process',
  'rag',
  'reconcile',
  'session',
  'state',
]

/**
 * 编辑器/底座模块禁止 import 的方向：AI 生成层 + `studio/`。
 *
 * 为什么 `studio/` 也要禁：`studio/server` 是**组合根**（把所有模块接起来的那一层），
 * 底座层反过来依赖它就等于「下层决定上层的形状」——组合根再也无法整体替换，而这类边
 * 在方向锁原先只锁「底座 → AI」时完全不会被发现（7 个底座文件同时 import
 * `studio/server/cache-registry` 即此形态，长期无人察觉）。
 *
 * 底座模块确实需要共享的零依赖件，一律落 `src/shared/`（本仓的最低共享层）：
 * 那是「底座之间横向共享」的合法位置，不构成上下反转。
 * 判据分两条（AI 向走 KNOWN 白名单、studio 向零白名单），故此处只留说明，不再合成单表。
 */

/**
 * 已知例外（待治理）：编辑器/底座 → AI 的现存业务依赖。
 * 从白名单移除即视为已治理（第二个用例会校验 import 是否真消失）。
 */
// E2 白名单已清零：readAiCallBudget 下沉 format/ai-calls（E2.1）+ shells 搬 install（E2.2，roles 屠除名）
const KNOWN = new Set<string>()

const AI_RE = new RegExp(`from\\s+['"](?:\\.\\./)+(${AI_LAYER.join('|')})/`)

/** 底座 → studio 的 import（组合根反向依赖；判据与 AI_RE 同构，只是目标集不同）。 */
const STUDIO_RE = /from\s+['"](?:\.\.\/)+(studio)\//

/** 递归收集目录下源码（.ts 排除 .d.ts + .vue SFC；排除 macOS ._ 垃圾）。 */
function listSource(dir: string): string[] {
  let out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._')) continue
    const fp = join(dir, name)
    if (statSync(fp).isDirectory()) out = out.concat(listSource(fp))
    else if ((name.endsWith('.ts') && !name.endsWith('.d.ts')) || name.endsWith('.vue')) out.push(fp)
  }
  return out
}

/** 门只判脚本面 import：.vue 取 <script> 块正文（template/style 里的字样不算，防误报）。 */
function scriptBlocks(name: string, content: string): string {
  if (!name.endsWith('.vue')) return content
  return [...content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '').join('\n')
}

/** 扫描编辑器/底座 → AI 生成层的 import；返回非白名单违规。 */
function scanViolations(): string[] {
  const violations: string[] = []
  for (const mod of EDITOR_BASE) {
    const dir = join(root, 'src', mod)
    if (!existsSync(dir)) continue
    for (const file of listSource(dir)) {
      const rel = relative(root, file).replaceAll('\\', '/')
      const lines = scriptBlocks(rel, readFileSync(file, 'utf-8')).split('\n')
      for (const line of lines) {
        const m = line.match(AI_RE)
        if (!m) continue
        const aiModule = m[1]
        if (!aiModule) continue
        if (!KNOWN.has(`${rel}:${aiModule}`)) {
          violations.push(`${rel}:${aiModule}  ←  ${line.trim()}`)
        }
      }
    }
  }
  return violations
}

/**
 * 扫描「底座 → studio 组合根」的 import。与 AI 向**分开判**：两类边的治理路径不同
 * （AI 向靠端口反转/下沉，studio 向一律搬 `src/shared/`），混在一个违规列表里读者
 * 分不出该按哪种改法处理。零白名单——这条边没有正当形态。
 */
function scanStudioViolations(): string[] {
  const violations: string[] = []
  for (const mod of EDITOR_BASE) {
    const dir = join(root, 'src', mod)
    if (!existsSync(dir)) continue
    for (const file of listSource(dir)) {
      const rel = relative(root, file).replaceAll('\\', '/')
      const lines = scriptBlocks(rel, readFileSync(file, 'utf-8')).split('\n')
      for (const line of lines) {
        if (STUDIO_RE.test(line)) violations.push(`${rel}  ←  ${line.trim()}`)
      }
    }
  }
  return violations
}

// ── web-next 跨包 import 锁（含 .vue）──────────────────────────────────────────
// web-next 经 HTTP 访问 server：前端唯一允许的跨包面是共享契约底座 src/shared/**
// （浏览器安全、零 Node 依赖）；落到其余任何后端目录（ai/document/format/check/
// process/state/studio/server 等）即违规——后端整图会被拖进前端打包与类型程序。
// 包内相对 import（src/studio/web-next/src/** 内）不受限。共享代码需要新家时，
// 先在 src/shared/** 落实现，再改指（re-export 兼容桥先例见 src/format/words.ts）。

/** web-next 包内前缀 + 唯一允许的跨包底座（相对仓库根，正斜杠）。 */
const WEBNEXT_ROOT = 'src/studio/web-next/src/'
const SHARED_ROOT = 'src/shared/'

/** 文件里的相对 import 说明符（静态/export-from、动态 import()、副作用 import）。 */
const SPEC_RES = [
  /from\s*['"](\.[^'"]+)['"]/g,
  /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  /(?:^|\n)[ \t]*import\s+['"](\.[^'"]+)['"]/g,
]

/** 扫 web-next 跨包逃逸：相对说明符解析到包内与 src/shared/** 之外即违规。 */
function scanWebnextEscapes(files: Array<{ rel: string; content: string }>): string[] {
  const violations: string[] = []
  for (const { rel, content } of files) {
    const body = scriptBlocks(rel, content)
    for (const re of SPEC_RES) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(body))) {
        const spec = m[1]!
        const target = relative(root, resolve(dirname(join(root, rel)), spec)).replaceAll('\\', '/')
        if (target.startsWith(WEBNEXT_ROOT) || target.startsWith(SHARED_ROOT)) continue
        violations.push(`${rel}  ←  ${spec}（解析到 ${target}）`)
      }
    }
  }
  return violations
}

describe('G5 依赖方向守护', () => {
  it('编辑器/底座源码无 AI 生成层 import（KNOWN 白名单除外）', () => {
    const violations = scanViolations()
    expect(
      violations,
      '编辑器/底座出现新的 AI 生成层 import。若为合理依赖，登记入 KNOWN 白名单并注明后续治理:\n' +
        violations.join('\n'),
    ).toEqual([])
  })

  it('KNOWN 白名单条目仍实际存在（防止白名单变僵尸）', () => {
    const stale: string[] = []
    for (const key of KNOWN) {
      const idx = key.indexOf(':')
      const file = key.slice(0, idx)
      const aiModule = key.slice(idx + 1)
      if (!existsSync(file)) {
        stale.push(`${key}  ← 文件已不存在`)
        continue
      }
      const re = new RegExp(`from\\s+['"](?:\\.\\./)+${aiModule}/`)
      if (!re.test(readFileSync(file, 'utf-8'))) {
        stale.push(`${key}  ← import 已消失，可从白名单移除（视为已治理）`)
      }
    }
    expect(stale, 'KNOWN 白名单有条目已过时（对应 import 已治理，应移除以反映现状）:\n' + stale.join('\n')).toEqual([])
  })

  it('底座源码不 import studio/ 组合根（共享件一律落 src/shared/，不走上下反转）', () => {
    const violations = scanStudioViolations()
    expect(
      violations,
      '底座层出现 import studio/ 的边——studio/server 是组合根，底座反向依赖它会让组合根无法整体替换。' +
        '确实需要共享的零依赖件请搬到 src/shared/（底座之间横向共享的合法位置）:\n' +
        violations.join('\n'),
    ).toEqual([])
  })

  it('studio 向判据自证：命中底座→studio 的边，且不误伤 src/shared/ 与同层相对引用', () => {
    // 判据若写成「从底座能不能找到到 studio 的路径」就会把 shared 也判进来；
    // 这里钉的是说明符层面的判据，故三个对照样本必须给出不同结论。
    const probe = (spec: string): boolean => STUDIO_RE.test(`import { x } from '${spec}'`)
    expect(probe('../studio/server/cache-registry.js')).toBe(true)
    expect(probe('../../studio/server/api/books.js')).toBe(true)
    // 搬去 shared 之后不再是违规（这正是本条的治理出口）
    expect(probe('../shared/cache-registry.js')).toBe(false)
    // 同层/下层相对引用不受影响
    expect(probe('./chapters.js')).toBe(false)
    expect(probe('../format/words.js')).toBe(false)
  })

  it('web-next 跨包 import 只准落 src/shared/**（含 .vue；其余后端目录一律禁）', () => {
    const files = listSource(join(root, 'src/studio/web-next/src')).map((fp) => ({
      rel: relative(root, fp).replaceAll('\\', '/'),
      content: readFileSync(fp, 'utf-8'),
    }))
    const violations = scanWebnextEscapes(files)
    expect(
      violations,
      'web-next 直引后端目录（前端只经 HTTP 访问 server）。共享代码应先落 src/shared/** ' +
        '（浏览器安全、零 Node 依赖）再改指，不得从 ai/format/document 等后端目录跨包取值:\n' +
        violations.join('\n'),
    ).toEqual([])
  })

  it('扫描口径自证：.vue 的 script 块违规必命中，template/style 内字样不误报', () => {
    // 两个 fixture 用同一违规说明符：①放 script 块（必须判命中）②放 template/style
    // 的等价文本（必须不判）——剥离逻辑一旦失效或整文直扫，必有一条断言红。
    // 说明符自 components/ 下 4 级上溯即 src/ai（越出包内与 src/shared/**，命中禁向）。
    const spec = '../../../../ai/contract/tool-meta'
    const planted = `<script setup lang="ts">\nimport { toolLabel } from '${spec}'\n</script>\n<template><div /></template>`
    const decoy =
      `<script setup lang="ts">\nimport { countWords } from '../shared/words'\n</script>\n` +
      `<template><pre>import { toolLabel } from '${spec}'</pre></template>\n` +
      `<style>/* source: '${spec}' */</style>`
    expect(
      scanWebnextEscapes([{ rel: 'src/studio/web-next/src/components/Probe.vue', content: planted }]),
      '.vue 的 script 块内违规未被判命中——扫描面扩展空转',
    ).toHaveLength(1)
    expect(
      scanWebnextEscapes([{ rel: 'src/studio/web-next/src/components/Probe.vue', content: decoy }]),
      'template/style 内的 import 字样被误判为脚本面 import',
    ).toEqual([])
  })
})
