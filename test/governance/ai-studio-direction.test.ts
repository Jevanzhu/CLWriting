/**
 * R0916-5c（⑤③ ai↔studio 解环·守门固化批，2026-09-16）：ai→studio 方向锁 + studio→ai 组合根形状锁。
 *
 * R0916 波1 全量边表侦察结论：ai→studio 静态 import = 0 条——最后一条反向边
 * （orchestrate/chat/turns.ts → studio/server/api/task-gate）已由 R0912 以
 * task-gate-port 端口化解，r0912-task-gate-port 仅锚两文件源；studio→ai = 64 条，
 * 全部落在组合根面（server/index.ts、server/http.ts、server/api/**）。
 * 本测试把现状钉成常驻门防回潮：
 *  - 方向锁（模块级全量）：src/ai/** 零 studio import。AI 层需要 studio 侧能力时
 *    走端口注入（先例 src/ai/orchestrate/task-gate-port.ts + stream.ts 组合根注册、
 *    src/document/structure.ts StructureRagPort），不得直连；本门吸收并超越 r0912
 *    的两文件源锚。
 *  - 形状锁：src/studio/**（含 web-next）凡 import ai 必须落在组合根白名单面——
 *    web-next 永远零 ai 直连（经 HTTP 访问 server）；api 层以外新文件确需 ai 能力
 *    时应上移组合根或端口化，评审确需例外才登记 SHAPE_KNOWN。
 *  与 G5（dependency-direction.test.ts：编辑器/底座 → AI 生成层）正交不重叠；
 *  r0912 两文件源锚为本门子集，语义保留不动。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// R62-58 同款：仓库根按 import.meta.url 解析——非根目录跑不误判
const root = fileURLToPath(new URL('../../', import.meta.url))

/**
 * R0916-6-P3-11（2026-09-16 全库源码重评五轮修复批）：扫描口径加固——原 AI_RE/STUDIO_RE
 * 逐行（或整文）只测静态 `from` 单正则，有两处逃逸面：①多行 import（from 与路径被
 * 换行空白错开时，逐行窗口失配）②动态 `import()`（无 from 关键字，正则天然不捕）。
 * 修法：整文读 → 空白归一（/\s+/g → 单空格，跨行与同行等价）→ 静态同族正则 + 动态
 * import 正则联测。动态正则口径与静态逐字同族：AI 侧保持 `(?:\.\.\/)+ai\/` 相对限定
 * （放宽为 `[^'"]*ai\/` 会误捕 openai/ 等含 ai 段的 bare 包名）；STUDIO 侧保持
 * `[^'"]*\/studio\/` 任意路径含段即捕（与原口径一致）。
 * 已知残余面（与原口径相同、不因归一扩大）：注释/字符串字面量里恰好写有 import 字样
 * 会误报——原形状锁本就对整文 test，此面非本批新增；src 现状零命中（门绿），如出现
 * 再引入 scripts/check-counts.mjs 的 stripComments 剥离口径。
 */
const STUDIO_RES = [
  /from\s+['"][^'"]*\/studio\//, // 静态 import / export-from（原口径）
  /import\(\s*['"][^'"]*\/studio\//, // 动态 import()（P3-11 增补）
]
/** src/studio/** 的 ai import 匹配（任意相对深度；静态 + 动态，见 P3-11 注）。 */
const AI_RES = [
  /from\s+['"](?:\.\.\/)+ai\//,
  /import\(\s*['"](?:\.\.\/)+ai\//,
]

/** P3-11：整文空白归一后跑正则组，返回命中的匹配片段（供违规行输出定位）。 */
function hitsAny(content: string, res: RegExp[]): string[] {
  const flat = content.replace(/\s+/g, ' ')
  const out: string[] = []
  for (const re of res) {
    const m = flat.match(re)
    if (m) out.push(m[0])
  }
  return out
}

/** 组合根白名单面：studio→ai 只准落在这些文件/目录前缀（相对仓库根，正斜杠）。 */
const COMB_ROOT_FILES = ['src/studio/server/index.ts', 'src/studio/server/http.ts']
const COMB_ROOT_PREFIXES = ['src/studio/server/api/']

/**
 * 形状锁已知例外（待治理）：组合根面以外、经评审登记的 studio→ai 依赖。
 * 治理后移除；僵尸用例会校验对应 import 是否真消失。
 */
const SHAPE_KNOWN = new Set<string>()

/** 递归收集目录下所有 .ts 文件（排除 .d.ts 与 macOS ._ 垃圾；G5 同款）。 */
function listTs(dir: string): string[] {
  let out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._')) continue
    const fp = join(dir, name)
    if (statSync(fp).isDirectory()) out = out.concat(listTs(fp))
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(fp)
  }
  return out
}

describe('R0916-5c ai↔studio 依赖方向守护', () => {
  it('方向锁：src/ai/** 无 studio import（模块级全量，静态 + 动态 import()）', () => {
    const violations: string[] = []
    for (const file of listTs(join(root, 'src', 'ai'))) {
      const rel = relative(root, file).replaceAll('\\', '/')
      for (const hit of hitsAny(readFileSync(file, 'utf-8'), STUDIO_RES)) {
        violations.push(`${rel}  ←  ${hit}`)
      }
    }
    expect(
      violations,
      'AI 层出现 studio 直连。若为合理依赖，走端口注入先例' +
        '（src/ai/orchestrate/task-gate-port.ts + stream.ts 组合根注册 / ' +
        'src/document/structure.ts StructureRagPort），不得直连:\n' +
        violations.join('\n'),
    ).toEqual([])
  })

  it('形状锁：studio→ai 只准落在组合根面（api/**、index、http；SHAPE_KNOWN 除外）', () => {
    const violations: string[] = []
    for (const file of listTs(join(root, 'src', 'studio'))) {
      const rel = relative(root, file).replaceAll('\\', '/')
      if (hitsAny(readFileSync(file, 'utf-8'), AI_RES).length === 0) continue
      if (COMB_ROOT_FILES.includes(rel) || COMB_ROOT_PREFIXES.some((p) => rel.startsWith(p))) continue
      if (SHAPE_KNOWN.has(rel)) continue
      violations.push(rel)
    }
    expect(
      violations,
      '组合根面以外出现 studio→ai import。新文件应上移 api 层或端口化；' +
        '评审确需例外才登记 SHAPE_KNOWN:\n' +
        violations.join('\n'),
    ).toEqual([])
  })

  it('SHAPE_KNOWN 白名单条目仍实际存在（防止白名单变僵尸）', () => {
    const stale: string[] = []
    for (const rel of SHAPE_KNOWN) {
      const fp = join(root, rel)
      if (!existsSync(fp)) {
        stale.push(`${rel}  ← 文件已不存在`)
        continue
      }
      if (hitsAny(readFileSync(fp, 'utf-8'), AI_RES).length === 0) {
        stale.push(`${rel}  ← ai import 已消失，可从白名单移除（视为已治理）`)
      }
    }
    expect(stale, 'SHAPE_KNOWN 有条目已过时:\n' + stale.join('\n')).toEqual([])
  })
})
