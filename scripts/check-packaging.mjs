#!/usr/bin/env node
/**
 * CC-P1-7 打包资源门——resources/ 必须进 asar + 捆绑资源自洽。
 *
 * 背景：electron-builder files 长期只含 dist（通配），resources/（内置 prompt/技巧包）
 * 缺席时打包态 resourcesRoot() 必抛错、AI 链路全挂——dev 形态无此问题，只有打包
 * 冒烟才能暴露（cc 轮评审 P1-7）。真打包校验（asar 清单 + 解包冒烟）靠发布前
 * build:desktop:dir 手动跑；本门做两层廉价的静态防回潮，CI 每跑必核：
 *   1. package.json files 数组必须含 dist 与 resources（P3 修复：原正则按两空格
 *      缩进 + 精确通配文本锚定 electron-builder.yml，格式微调即静默失效——改为
 *      JSON.parse 后直接断言，顺序/格式无关）
 *   2. resources/prompts/versions.json 与实际 .md 文件互相对账（改名单不改表即红）
 *
 * 用法：npm run check:packaging（退出码 1 = 失配，并列出问题）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// fileURLToPath 解码百分号编码（工作区路径含 ^ 时 pathname 会带 %5E，scandir 直接 ENOENT）
const root = fileURLToPath(new URL('..', import.meta.url))
const problems = []

// ── 1. package.json：files 数组必须含 dist 与 resources（P3：正则 → JSON.parse）──
// 导出纯函数供 test/desktop/check-packaging.test.ts 直测断言口径（脚本本体只在
// 直跑时执行校验/退出，import 不产生副作用）。
export function problemsForPackageFiles(files) {
  const found = []
  if (!Array.isArray(files)) {
    found.push('package.json files 不是数组——npm 打包内容清单没了/形状变了')
    return found
  }
  // 直接断言成员资格（顺序/缩进无关；成员允许带 /**/* 等通配后缀——同一目录的
  // 不同写法均算覆盖，格式微调不再静默失效）
  for (const need of ['dist', 'resources']) {
    const covers = (entry) => entry === need || entry.startsWith(need + '/')
    if (!files.some((entry) => typeof entry === 'string' && covers(entry))) {
      found.push(`package.json files 未包含 ${need}——npm 打包内容缺整目录（CC-P1-7 回潮）`)
    }
  }
  return found
}

// ── 第三层（R62-22）：electron-builder.yml files 断言（asar 实际打包面）────
// DMG 打包走 electron-builder.yml 的 files（非 package.json）——resources/ 缺席时
// 用「删掉 resources 仍全绿」的自欺门（CC-P1-7 场景的另一半）。以下两个纯函数导出
// 供 test/desktop/check-packaging.test.ts 锚定（承 P3「勿正则钉格式」——只做行级
// 序列解析 + 成员资格断言，不锚定 glob 文本/缩进）。
/** 解析 electron-builder.yml 顶层 files: 序列（行扫描）。返回 string[]；找不到 files
 *  键或序列为空 → null（视为配置缺失）。容忍成员缩进/引号/空行/注释变化。 */
export function parseBuilderFiles(yamlText) {
  const items = []
  let inFiles = false
  for (const raw of String(yamlText || '').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (!inFiles) {
      if (/^files:\s*$/.test(line)) { inFiles = true; continue }
      continue
    }
    if (line.startsWith('- ')) {
      // R64-39（十二轮）：头注称容忍引号但 slice(2).trim() 实不剥——YAML 合法形态
      // `- "dist"` 此前原样入列（含引号），成员资格断言 mismatch 误报缺目录（fail-closed
      // 不破绿但注释与实现相悖）。剥成对的引号后入列。
      let v = line.slice(2).trim()
      if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
        v = v.slice(1, -1)
      }
      if (v) items.push(v)
      continue
    }
    break // files 块结束（下一个顶层键，如 asar/mac）
  }
  return items.length > 0 ? items : null
}

/** 断言 files 序列覆盖 dist 与 resources。files 非数组/空 → 配置缺失必红。 */
export function problemsForElectronBuilderFiles(files) {
  const found = []
  if (!Array.isArray(files) || files.length === 0) {
    found.push('electron-builder.yml files 不可解析或为空——asar 打包内容清单没了/形状变了')
    return found
  }
  for (const need of ['dist', 'resources']) {
    const covers = (entry) => entry === need || entry.startsWith(need + '/')
    if (!files.some((entry) => typeof entry === 'string' && covers(entry))) {
      found.push(`electron-builder.yml files 未包含 ${need}——asar 打包缺整目录（CC-P1-7 回潮）`)
    }
  }
  return found
}

// ── 全库重评-0914（P3-10）：AppleDouble 排除项锚定 ─────────────────────────
// electron-builder.yml files 补否定模式 '!**/._*'——外置/网络构建卷上 macOS 为每个
// 文件生成 ._ 伴生文件（资源叉），白名单 `dist/**/*` 通配把它们一并打进 asar。本门
// 锁定排除项存在（防回潮）。独立函数而非并入 problemsForElectronBuilderFiles：后者
// 既有直测夹具（dist/resources 成员资格形态）不含否定模式，并臂会打红存量锚定；
// 主流程两门并跑。精确钉 '!**/._*'（parseBuilderFiles 已剥引号）——排除模式单一
// 正本在本仓配置内，钉死形态即 fail-closed：模式被删/收窄（如 '!._*' 漏嵌套层）即红。
// 断言 files 序列含 AppleDouble 否定模式 '!**/._*'（行注释书写——块注释内该字面量
// 含 */ 会提前终止注释）。导出供直测锚定。
export function problemsForElectronBuilderAppleDouble(files) {
  const found = []
  if (!Array.isArray(files) || files.length === 0) {
    found.push('electron-builder.yml files 不可解析或为空——AppleDouble 排除项无法校验（全库重评-0914 P3-10）')
    return found
  }
  if (!files.some((entry) => entry === '!**/._*')) {
    found.push('electron-builder.yml files 缺 AppleDouble 否定模式（!**/._*）——外置卷 ._ 伴生文件会进 asar（全库重评-0914 P3-10 回潮）')
  }
  return found
}

// ── 单立清账批（2026-09-17）：node_modules 全排除项锚定 ─────────────────────
// 0917清库修复批给 electron-builder.yml files 增补 '!node_modules/**'——tsup 全量
// bundle（external 仅 electron）后运行时零裸包解析，3 个生产依赖（@anthropic-ai/sdk、
// font-list、openai）已内联进 chunk、fontlist 二进制走 dist/desktop/fontlist +
// asarUnpack，收集器再装 node_modules 纯属冗余（旧 asar 98.5% 条目是 node_modules，
// 排除后装机体 −27M）。该排除行此前无任何静态门——被误删只有 packaged-app-smoke/
// CI 冒烟能拦（迟面），本门静态锁存在。精确钉 '!node_modules/**'（parseBuilderFiles
// 已剥引号）——排除模式单一正本在配置内，钉死形态即 fail-closed：被删/收窄（如
// '!node_modules' 漏子层）即红。独立函数不并入 problemsForElectronBuilderFiles
// （同 AppleDouble 先例：并臂会打红存量直测夹具）。导出供直测锚定。
export function problemsForElectronBuilderNodeModulesExclusion(files) {
  const found = []
  if (!Array.isArray(files) || files.length === 0) {
    found.push('electron-builder.yml files 不可解析或为空——node_modules 排除项无法校验（单立清账批 2026-09-17）')
    return found
  }
  if (!files.some((entry) => entry === '!node_modules/**')) {
    found.push('electron-builder.yml files 缺 node_modules 全排除模式（!node_modules/**）——冗余依赖整树回装 asar、装机体回涨（0917清库修复批回潮）')
  }
  return found
}

// ── RC 全项目重审（GLM-5.3，2026-09-20）P2-2：裸包外置回潮静态门 ──────────────
// 背景：rc.0 假绿链的根因形态——package.json dependencies 新增裸包而 tsup noExternal
// 漏收时，ESM 产物留裸 import × electron-builder '!node_modules/**' 排除 → 打包态链接期
// ERR_MODULE_NOT_FOUND 秒崩。此前无任何 PR 级门：ci.yml release-smoke 在工作区内直跑、
// 裸包解析沿路径向上摸到仓库 node_modules（假绿），asar 清单断言只查 node_modules 不混入、
// 查不出「产物 js 残留裸 import」——回潮要到 tag 发布出工作区冒烟才红（发布周期浪费）。
// 本门把发现提前到 PR：断言 package.json dependencies ⊆ tsup.config.ts 全部 noExternal
// 清单之并集（多 config/多段均可）。新增依赖须同步 noExternal（或显式改走 electron
// external 语义并在 tsup 注明），否则本门红。fail-closed：deps 非空而 noExternal 解析
// 不到任何段 → 红（配置形状变了不许静默过）。导出纯函数供直测锚定。

/** 解析 tsup.config.ts 全文所有 `noExternal: [...]` 数组字面量（行内/多行皆可），返回
 *  引号剥除后的成员并集；一个都解析不到 → 空数组（由断言函数按 fail-closed 判红）。
 *  只认成对引号成员（tsup 配置实态），容忍空白/尾逗号；不递归求值——配置里放表达式
 *  本门即红，逼配置保持字面量（静态可查性即本门存在前提）。 */
export function parseTsupNoExternal(tsText) {
  const out = new Set()
  const text = String(tsText || '')
  const re = /noExternal\s*:\s*\[([^\]]*)\]/g
  let m
  while ((m = re.exec(text)) !== null) {
    for (const raw of m[1].split(',')) {
      const v = raw.trim()
      if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
        out.add(v.slice(1, -1))
      }
    }
  }
  return [...out]
}

/** 断言 dependencies 键集 ⊆ noExternal 清单——漏收即红（rc.0 发布修复批前提
 *  「tsup 全量 bundle、运行时零裸包解析」的机器化）。 */
export function problemsForDepsNoExternal(dependencies, noExternal) {
  const found = []
  const deps = dependencies && typeof dependencies === 'object' ? Object.keys(dependencies) : []
  const list = Array.isArray(noExternal) ? noExternal : []
  if (deps.length > 0 && list.length === 0) {
    found.push('tsup.config.ts 解析不到任何 noExternal 数组——裸包外置门无法校验（配置形状变了或清空即红，不许静默过）')
    return found
  }
  for (const dep of deps) {
    if (!list.includes(dep)) {
      found.push(`package.json dependencies 的 ${dep} 不在 tsup noExternal 清单——asar 已排除 node_modules，打包态该裸 import 必炸 ERR_MODULE_NOT_FOUND（rc.0 假绿链回潮；补 noExternal 或显式 external 并注明）`)
    }
  }
  return found
}

// ── RC 全项目重审（GLM-5.3，2026-09-20）P3-15：根/子包重复依赖版本同步门 ──────
// 背景：vue/pinia/@vitejs/plugin-vue/typescript 在根与 web-next 子包双侧手抄（根侧钉根
// 副本供 vitest alias 用、子包供构建用——双 package.json 结构的固有形态），此前无同步门：
// typescript 声明区间已漂移（根 ^5.5.0 / 子 ^5.6.0，实测同落 5.9.3 未爆），测试面与构建面
// 静默分叉。本门断言：同一包名在两 package.json 出现（依赖区不限）时版本声明必须一致。
export function problemsForDepsVersionSync(rootDeps, subDeps) {
  const found = []
  const a = rootDeps && typeof rootDeps === 'object' ? rootDeps : {}
  const b = subDeps && typeof subDeps === 'object' ? subDeps : {}
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  for (const name of names) {
    const va = a[name]
    const vb = b[name]
    if (va !== undefined && vb !== undefined && va !== vb) {
      found.push(`根包与 web-next 子包的 ${name} 版本声明分叉（根 ${va} / 子 ${vb}）——测试面（钉根副本）与构建面（子包副本）静默分叉（RC 全项目重审 P3-15）`)
    }
  }
  return found
}

/**
 * F-2（五十轮评审批）：TOCTOU 容错的目录列举——existsSync 判定后 readdir 前目录被
 * 并发移走（ENOENT）/被换成文件（ENOTDIR）时记 console.warn 返回空数组（跳过只损
 * 该侧对账诊断，失败方向 fail-closed 不变——不假绿也不吞真故障）；其余错误照抛。
 * 导出供 test/desktop/check-packaging-readdir-tolerant.test.ts 直测。
 */
export function readDirTolerant(dir) {
  try {
    return readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
      console.warn(`check:packaging 跳过不可读目录（${e.code}）：${dir}`)
      return []
    }
    throw e
  }
}

// ── 第四层（R0911-A-P2-1，2026-09-11 全量重评 GLM-5.3 修复批）：mac 字体二进制分发门 ──
// fontlist 原生二进制此前不随包分发（electron-builder files 白名单无 node_modules、
// tsup 不拷原生文件），mac 打包态字体枚举主路径恒 ENOENT 回落 system_profiler 慢路径。
// 修复链 = tsup onSuccess 拷入 dist/desktop/（darwin）+ asarUnpack 外置 + main.ts 接线；
// 本门静态锁前两环的防回潮：asarUnput 配置缺失 / darwin dist 已构建但二进制缺席/丢执行位。
// R0912-A-P2-1（2026-09-12 独立重评 GLM-5.3 修复批）：外置路径修正为 asar 内真实形态
// dist/desktop/fontlist（上批裸 desktop/fontlist 在 files `dist/**/*` 口径下零命中），
// 本门覆盖判定随配置同步收紧——门随改，旧错误形态改判红。

/** 解析 electron-builder.yml 顶层 asarUnpack: 序列（行扫描，与 parseBuilderFiles 同口径
 *  ——引号剥除、容忍缩进/空行/注释；找不到键或序列为空 → null）。导出供直测锚定。 */
export function parseBuilderAsarUnpack(yamlText) {
  const items = []
  let inBlock = false
  for (const raw of String(yamlText || '').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (!inBlock) {
      if (/^asarUnpack:\s*$/.test(line)) {
        inBlock = true
        continue
      }
      continue
    }
    if (line.startsWith('- ')) {
      let v = line.slice(2).trim()
      if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
        v = v.slice(1, -1)
      }
      if (v) items.push(v)
      continue
    }
    break // asarUnpack 块结束（下一个顶层键）
  }
  return items.length > 0 ? items : null
}

/** 断言 asarUnpack 序列覆盖 fontlist 真实产物路径 dist/desktop/fontlist——spawn 不解
 *  asar，外置缺失则打包态自管枚举恒回落（A-P2-1 只修了一半的回潮形态）。R0912（mac 线
 *  重评-0911c P2）/ R0912-A-P2-1（win 线 2026-09-12 独立重评修复批）同题并合：files 的
 *  dist 通配规则下 asar 内路径带 dist/ 段（FileMatcher 以 appDir 相对路径做 minimatch），
 *  旧口径认裸 `desktop/fontlist` 会放过「配置了也零命中」的无效外置（真打包才能暴露的
 *  假绿）——视为半修回潮必红；门接受可命中 dist/desktop/fontlist 的模式族（两星斜杠根
 *  锚定形态、显式 dist/ 前缀形态、dist 目录级通配，含目录级尾巴/子路径前缀）。导出供
 *  直测锚定。 */
export function problemsForElectronBuilderAsarUnpack(items) {
  const found = []
  if (!Array.isArray(items) || items.length === 0) {
    found.push('electron-builder.yml asarUnpack 不可解析或为空——fontlist 二进制不会外置，打包态 spawn 枚举恒不可达（R0911-A-P2-1 回潮）')
    return found
  }
  // 可命中 dist/desktop/fontlist 的模式族（R0912 两线并集：两星斜杠根锚定 / 显式 dist/
  // 前缀及其子路径 / dist 目录级通配；目录级 `/**`、`/**/*` 尾巴归一剥除后判定；纯字符串
  // 判定，不写内联 glob 正则——vite import-analysis 对复杂正则字面量解析易脆）
  const hits = (entry) => {
    if (typeof entry !== 'string') return false
    const norm = entry.replace(/\/\*\*(?:\/\*)?$/, '')
    return norm === '**/desktop/fontlist' || norm === 'dist/desktop/fontlist' || norm === 'dist'
      || entry.startsWith('dist/desktop/fontlist/')
  }
  if (!items.some(hits)) {
    found.push('electron-builder.yml asarUnpack 无可命中 dist/desktop/fontlist 的模式——打包态自管枚举 spawn 不到真二进制（R0911-A-P2-1 回潮；R0912：裸 desktop/fontlist 对 asar 内带 dist/ 前缀的实际路径零命中，为无效外置）')
  }
  return found
}

/** dist 侧实存门：仅 darwin 且 dist/desktop/main.js 已构建时生效（其余平台/未构建
 *  返回 []——CI linux/win 腿 dist 无二进制属预期，纯本地 check 不 build 也不误报）。
 *  断言 dist/desktop/fontlist 存在且带可执行位。导出供直测（注入路径与平台）。 */
export function problemsForDistFontList(distDesktopDir, platform) {
  if (platform !== 'darwin') return []
  if (!existsSync(join(distDesktopDir, 'main.js'))) return []
  const found = []
  const bin = join(distDesktopDir, 'fontlist')
  if (!existsSync(bin)) {
    // R0912（重评-0911c P3/G）：两态文案——本机 dist 陈旧（工作树半新态）与拷贝链
    // 失效（真回潮）此前不可区分，误导排障方向（R0911 修复后本地首跑曾因陈旧 dist
    // 伪红）。fail-closed 方向不变：两种形态都要求先重跑 build 再复检。
    found.push(`darwin dist 已构建但缺 ${bin}——dist 陈旧（先 npm run build 重新构建再复检）或 tsup onSuccess 拷贝步骤失效（回潮）`)
    return found
  }
  try {
    if ((statSync(bin).mode & 0o111) === 0) {
      found.push(`${bin} 无可执行位——拷贝链丢了 mode（重跑 npm run build）`)
    }
  } catch (e) {
    found.push(`${bin} stat 失败：${e.message}`)
  }
  return found
}

function checkPackaging() {
  const pkgPath = join(root, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (e) {
    problems.push(`package.json 不可读/不是合法 JSON：${e.message}`)
  }
  if (pkg) problems.push(...problemsForPackageFiles(pkg.files))

  // ── RC 全项目重审 P2-2：裸包外置回潮静态门（dependencies ⊆ tsup noExternal）──
  // P3-15：根/子包重复依赖版本同步门（vue/pinia/plugin-vue/typescript 双侧手抄面）
  if (pkg) {
    const tsupPath = join(root, 'tsup.config.ts')
    let tsupText = ''
    try {
      tsupText = readFileSync(tsupPath, 'utf8')
    } catch (e) {
      problems.push(`tsup.config.ts 不可读：${e.message}`)
    }
    if (tsupText !== '') {
      problems.push(...problemsForDepsNoExternal(pkg.dependencies, parseTsupNoExternal(tsupText)))
    }
    const subPkgPath = join(root, 'src', 'studio', 'web-next', 'package.json')
    let subPkg
    try {
      subPkg = JSON.parse(readFileSync(subPkgPath, 'utf8'))
    } catch (e) {
      problems.push(`web-next 子包 package.json 不可读/不是合法 JSON：${e.message}`)
    }
    if (pkg && subPkg) {
      const merge = (p) => ({ ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) })
      problems.push(...problemsForDepsVersionSync(merge(pkg), merge(subPkg)))
    }
  }

  // ── 1b. （R62-22）第三层：electron-builder.yml files 断言（asar 实际打包面）──
  // package.json files 只约束 npm pack；DMG 实际打包走 electron-builder.yml——
  // files 里缺 resources/ 时 CI 仍全绿、打包态 AI 链路全挂（CC-P1-7 另一半）。
  const ebPath = join(root, 'electron-builder.yml')
  if (!existsSync(ebPath)) {
    problems.push('缺 electron-builder.yml——桌面打包配置没了（asar 清单无法校验）')
  } else {
    const ebFiles = parseBuilderFiles(readFileSync(ebPath, 'utf8'))
    problems.push(...problemsForElectronBuilderFiles(ebFiles))
    // 全库重评-0914（P3-10）：AppleDouble 排除项锚定门（与 dist/resources 成员门并跑）
    problems.push(...problemsForElectronBuilderAppleDouble(ebFiles))
    // 单立清账批（2026-09-17）：node_modules 全排除项锚定门（与 AppleDouble 门并跑）
    problems.push(...problemsForElectronBuilderNodeModulesExclusion(ebFiles))
    // R0911-A-P2-1 第四层：fontlist asarUnpack 配置门（静态，全平台可查）
    problems.push(...problemsForElectronBuilderAsarUnpack(parseBuilderAsarUnpack(readFileSync(ebPath, 'utf8'))))
  }
  // R0911-A-P2-1 第四层：darwin dist 实存门（仅 darwin + dist 已构建时生效）。
  // R0912（重评-0911c P2/G）：CLW_CHECK_PACKAGING_SKIP_DIST_GATE=1 可跳过本门——
  // 供 test/desktop/check-packaging.test.ts 的「真实脚本直跑」用例使用：单测不应把
  // 不受控的本地工作树构建产物状态当断言对象（dist 半新态曾致全量单测单点红），
  // 用例置此变量只锁配置面与资源对账面；CI 与本地常规跑不设变量，门照常生效。
  if (process.env.CLW_CHECK_PACKAGING_SKIP_DIST_GATE !== '1') {
    problems.push(...problemsForDistFontList(join(root, 'dist', 'desktop'), process.platform))
  }

  // ── 2. 捆绑资源自洽：versions.json ↔ 实际 .md 双向对账 ────────────────────
  const promptsDir = join(root, 'resources', 'prompts')
  const skillsDir = join(root, 'resources', 'skills')
  for (const dir of [promptsDir, skillsDir]) {
    if (!existsSync(dir)) problems.push(`捆绑资源目录缺失：${dir}`)
  }
  if (existsSync(promptsDir)) {
    const versionsPath = join(promptsDir, 'versions.json')
    if (!existsSync(versionsPath)) {
      problems.push('缺 resources/prompts/versions.json——prompt 版本表没了')
    } else {
      let versions
      try {
        versions = JSON.parse(readFileSync(versionsPath, 'utf8'))
      } catch (e) {
        problems.push(`versions.json 不是合法 JSON：${e.message}`)
      }
      if (versions) {
        // 表里有名、盘上无文件 → 运行期 readBuiltin 直接 throw
        for (const name of Object.keys(versions)) {
          if (!existsSync(join(promptsDir, name))) {
            problems.push(`versions.json 登记 ${name}，但 resources/prompts/ 下无此文件`)
          }
        }
        // 盘上有文件、表里无名 → 该 prompt 永远走不到版本化链路（静默漂移）
        // F-2（五十轮评审批）：TOCTOU 容错——existsSync 后目录被并发移走（ENOENT）/
        // 被换成文件（ENOTDIR）不再裸抛炸脚本（跳过只损该侧对账诊断，失败方向不变）；
        // 其余错误照抛。导出 readDirTolerant 供直测。
        const listed = new Set(Object.keys(versions))
        for (const f of readDirTolerant(promptsDir)) {
          if (f.endsWith('.md') && !listed.has(f)) {
            problems.push(`resources/prompts/${f} 存在但 versions.json 未登记`)
          }
        }
      }
    }
  }
  if (existsSync(skillsDir)) {
    const skillFiles = readDirTolerant(skillsDir).filter((f) => f.endsWith('.md'))
    if (skillFiles.length === 0) problems.push('resources/skills/ 下无任何 .md 技巧包')
  }

  if (problems.length > 0) {
    console.error('check:packaging 失配（打包资源防回潮门，修复后再提交）：')
    for (const p of problems) console.error('  - ' + p)
    process.exit(1)
  }
  console.log('check:packaging 通过：resources/ 已入打包清单，prompt 版本表与文件对账一致。')
}

// 直跑才执行校验（import 侧只拿纯函数，测试不触发 process.exit）
const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (invoked) checkPackaging()
