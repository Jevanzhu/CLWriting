#!/usr/bin/env node
/**
 * 知识层 manifest 对账门——「CI 只相信正式知识层」落成门禁。
 *
 * 背景：src/knowledge/manifest.ts 的 validateKnowledgeManifest 已完整实现（target 路径
 * 安全 + sha256 与磁盘对账 + 重复检测 + 元数据校验），但全仓零调用方——注释宣称的
 * 「CI 只相信正式知识层」名存实亡。本脚本接线该校验为 CI 门：
 * 知识层/_manifest.json 与实际文件任一失配（改名漏登记 / 改内容漏更新 / 路径越界）即红。
 *
 * 反向扫描（manifest→磁盘 之外再扫描 磁盘→manifest）——盘上 `.md` 文件未在 manifest
 * 登记且非豁免的，告警红（防「往知识层丢个 .md 就以为进了 CI」漂移）。
 * 豁免白名单：文件名含「草稿」或为 README.md（草稿/导航性文件不经版本化登记）。
 *
 * 随包语料对账：`resources/knowledge/` 是 知识层/ 的随包子集（写稿面
 * 运行时按章选材读它）——逐字节对账 + 选材篇目在位（scanBundledCorpusMismatches）；
 * 随包件与正式知识层漂移即红，防「包里的语料和仓里的原稿不是一回事」。
 * 反向扫描覆盖全部资产（非仅 .md）——登记面（isSafeKnowledgeTarget/validateEntry）
 * 对任意扩展名放行（非 .md 只跳过 fm 校验），只认 .md 会让盘上未登记非 .md 资产
 * 两向失明（正向 sha256 对账有条件、反向捡拾无条件盲区）；隐藏文件（.DS_Store 等）
 * 与对账单本体 _manifest.json 豁免。导出名即 scanUnregisteredKnowledgeAssets。
 *
 * 用法：npm run check:knowledge（退出码 1 = 失配，并列出问题）
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent, type Stats } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  caseFoldKey,
  validateKnowledgeManifest,
  KNOWLEDGE_DIR,
  type KnowledgeManifest,
} from '../src/knowledge/manifest.js'
import { BUNDLED_CATALOG } from '../src/knowledge/catalog.js'
import { readFile, parseFlat } from '../src/format/frontmatter.js'
import { parseReferences } from '../src/process/skills.js'
import { toNfcName } from '../src/fs/text-canonical.js'

// 仓库根（工作区路径可能含 ^ 等特殊字符，fileURLToPath 解码，与 check-packaging 同口径）
const root = fileURLToPath(new URL('..', import.meta.url))

/** 递归收集 dir 下全部资产文件（不限 .md——登记面对任意扩展名放行，反向扫描只认
 *  .md 会让未登记非 .md 资产两向失明）。
 *  指向目录的 symlink 须 fail-closed 拒绝：Dirent.isDirectory() 对 symlink 恒 false，
 *  若静默跳过则目录内资产整树逃反向门（未登记可绕过 CI 登记）。故知识层内出现指向
 *  目录的 symlink 即抛错（main 转 console.error + exit(1)），作者改实体目录或删除后
 *  再跑；symlink→文件按普通资产参与扫描（未登记即 unmatched；越界登记由正向
 *  isSafeKnowledgeTarget 挡）。
 *  隐藏文件/目录（.DS_Store、临时残留等）不入对账面——系统/工具噪音，非知识资产
 * （同迁移链「.DS_Store 等照旧忽略，不制造噪音」口径）。 */
function collectKnowledgeAssetFiles(dir: string): string[] {
  const out: string[] = []
  let dirents: Dirent[]
  try {
    dirents = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    // TOCTOU 容错，对齐 check-counts.mjs 的同类口径——父目录 Dirent 判型后、递归
    // readdir 前目录被并发移走（ENOENT）或路径段被换成文件（ENOTDIR）→ console.warn
    // 留痕后跳过（失败方向 fail-closed 不变：跳过只损诊断面）；其余错误照抛
    //（不吞真故障、不假绿）。
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      console.warn(`check:knowledge 反向扫描跳过不可读目录（${code}）：${dir}`)
      return out
    }
    throw e
  }
  for (const en of dirents) {
    if (en.name.startsWith('.')) continue // 隐藏文件/目录：非知识资产（噪音豁免）
    const p = join(dir, en.name)
    if (en.isDirectory()) {
      out.push(...collectKnowledgeAssetFiles(p))
    } else if (en.isSymbolicLink()) {
      let st: Stats
      try {
        st = statSync(p)
      } catch (e) {
        // 同上 TOCTOU 容错——readdir 后条目被并发移走/路径段被换（永久断链
        // symlink 同为 ENOENT 形态，随消失口径 warn 跳过留痕）；其余错误照抛
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          console.warn(`check:knowledge 反向扫描跳过消失条目（${code}）：${p}`)
          continue
        }
        throw e
      }
      if (st.isDirectory()) {
        // 指向目录的 symlink：反向扫描无法保证其子树资产可见（且环路/越界不可判）——
        // fail-closed 拒绝
        throw new Error(`知识层内发现指向目录的 symlink：${p}（反向扫描 fail-closed：请改为实体目录或删除后重跑）`)
      }
      out.push(p)
    } else {
      out.push(p)
    }
  }
  return out
}

/**
 * 反向扫描（覆盖全部资产）：
 * 盘上文件未登记且非豁免 → 返回相对路径（项目根 → 知识层全树）。
 * 豁免：对账单本体 _manifest.json、文件名含「草稿」（草稿不经版本化）、README.md
 * （导航性文件）；隐藏文件在收集层即豁免。
 */
export function scanUnregisteredKnowledgeAssets(
  projectRoot: string,
  manifestOrEntries: KnowledgeManifest | KnowledgeManifest['entries'] | undefined,
  rootDir: string = KNOWLEDGE_DIR,
): string[] {
  // 登记面比对收敛 caseFoldKey 单源（校验器/登记侧判重同源），NFC 先于折叠
  // （platformCaseFold 硬性不变量「不含 NFC」，同 docJoinKey 管线次序）——精确字符串
  // 比对会在大小写漂移（win/APFS 同物理文件）与 NFD 文件名形态（mac APFS 惯存分解形）
  // 下把已登记文件误报未登记（CI 假红）。非字符串 target（坏形状行）维持原行为：
  // 不折叠、恒不匹配（报未登记，交由正向校验器上报）。
  const registered = new Set(
    (Array.isArray(manifestOrEntries) ? manifestOrEntries : (manifestOrEntries?.entries ?? [])).map((e) =>
      typeof e.target === 'string' ? caseFoldKey(toNfcName(e.target)) : e.target,
    ),
  )
  const knowledgeRoot = join(projectRoot, rootDir)
  if (!existsSync(knowledgeRoot)) return []
  const unmatched = []
  for (const fp of collectKnowledgeAssetFiles(knowledgeRoot)) {
    const rel = relative(projectRoot, fp).split(sep).join('/')
    const base = fp.split(sep).pop() ?? ''
    const exempt = base === '_manifest.json' || base.includes('草稿') || base === 'README.md'
    if (!registered.has(caseFoldKey(toNfcName(rel))) && !exempt) unmatched.push(rel)
  }
  return unmatched
}

/** 随包语料相对目录（写稿面运行时读取；目录结构镜像 知识层/） */
export const BUNDLED_KNOWLEDGE_DIR = 'resources/knowledge'

/** 随包作业包目录（作业包 frontmatter 的 references 声明面） */
export const BUNDLED_SKILLS_DIR = 'resources/skills'

/** 随包语料目录说明文件名（非语料副本，豁免逐字节对账） */
const BUNDLED_README = 'README.md'

/** 随包语料历史哈希表(播种/升级判据本身,非语料副本,豁免逐字节对账) */
const BUNDLED_VERSIONS = 'versions.json'

/** 递归收集目录下全部文件（跳过隐藏项；symlink 按文件参与——对不上字节即报） */
function collectBundledFiles(dir: string): string[] {
  const out: string[] = []
  for (const en of readdirSync(dir, { withFileTypes: true })) {
    if (en.name.startsWith('.')) continue
    const p = join(dir, en.name)
    if (en.isDirectory()) out.push(...collectBundledFiles(p))
    else out.push(p)
  }
  return out
}

/**
 * 随包语料对账（写稿面接入批）：`resources/knowledge/` 是 `知识层/` 正式语料的随包子集——
 * 每个文件必须与 `知识层/<rel>` **逐字节相等**（改语料 = 改原稿 + 同步随包件，漏一处即红），
 * 且 catalog 中声明了注入面（`faces` 非空）的篇目必须在位（缺篇 = 该面静默降级）。
 * 豁免：`README.md`（目录说明，非语料副本）。
 */
export function scanBundledCorpusMismatches(projectRoot: string, bundledDir: string = BUNDLED_KNOWLEDGE_DIR): string[] {
  const bundledRoot = join(projectRoot, bundledDir)
  if (!existsSync(bundledRoot)) {
    return [`${bundledDir}: 随包语料目录缺失（写稿面方法选材读取它，缺目录即降级为零注入）`]
  }
  const problems: string[] = []
  const rels = collectBundledFiles(bundledRoot)
    .map((p) => relative(bundledRoot, p).split(sep).join('/'))
    .sort()
  for (const rel of rels) {
    if (rel === BUNDLED_README || rel === BUNDLED_VERSIONS) continue
    const origin = join(projectRoot, KNOWLEDGE_DIR, rel)
    if (!existsSync(origin)) {
      problems.push(`${bundledDir}/${rel}: 知识层/ 无对应原稿（随包件必须来自正式知识层）`)
      continue
    }
    try {
      if (!readFileSync(origin).equals(readFileSync(join(bundledRoot, rel)))) {
        problems.push(
          `${bundledDir}/${rel}: 与 ${KNOWLEDGE_DIR}/${rel} 不一致（改语料须两处同步，逐字节相等是本门红线）`,
        )
      }
    } catch (e) {
      problems.push(`${bundledDir}/${rel}: 读取失败（${e instanceof Error ? e.message : String(e)}）`)
    }
  }
  // 选材篇目在位判据改 **catalog 驱动**：条目声明「会下发」（faces 非空）⇒ 该篇必须随包在位。
  // 硬编码篇名表会在篇目增删时与 catalog 口径分叉——声明即门：faces 是各面实际消费面的事实陈述。
  const shipped = new Set(rels)
  for (const entry of BUNDLED_CATALOG) {
    if (entry.faces.length === 0) continue
    if (!shipped.has(entry.rel)) {
      problems.push(
        `${bundledDir}/${entry.rel}: catalog 声明注入面 [${entry.faces.join(',')}] 但随包缺件（该面会静默降级）`,
      )
    }
  }
  return problems
}

/**
 * 署名门（语料重建批）：每篇**随包语料**必须带 `source`/`license` front matter，
 * 且 MIT 来源篇在 `许可/` 有对应版权行——这是 MIT 再分发义务，缺即红。
 *
 * 与 manifest 校验的分工：manifest 校验管已登记篇「fm 与条目是否一致」；本门管
 * **随包面全体**「署名键是否在位」（含尚未登记进 manifest 的新篇，覆盖面更靠前）。
 */
export function scanBundledMissingAttribution(
  projectRoot: string,
  bundledDir: string = BUNDLED_KNOWLEDGE_DIR,
): string[] {
  const bundledRoot = join(projectRoot, bundledDir)
  if (!existsSync(bundledRoot)) return []
  const problems: string[] = []
  for (const rel of collectBundledFiles(bundledRoot)
    .map((p) => relative(bundledRoot, p).split(sep).join('/'))
    .sort()) {
    if (rel === BUNDLED_README || rel === BUNDLED_VERSIONS) continue
    if (!rel.toLowerCase().endsWith('.md')) continue
    let text: string
    try {
      text = readFileSync(join(bundledRoot, rel), 'utf-8')
    } catch (e) {
      problems.push(`${bundledDir}/${rel}: 读取失败（${e instanceof Error ? e.message : String(e)}）`)
      continue
    }
    const missing = (['source', 'license'] as const).filter((key) => !hasFmKey(text, key))
    if (missing.length > 0) {
      problems.push(`${bundledDir}/${rel}: 缺 front matter 署名键 ${missing.join('/')}（MIT 再分发义务）`)
    }
  }
  // 许可件本体须含版权行（MIT 正文的署名要件；许可件缺失由对账门报，此处只判内容）
  const licenseRel = '许可/oh-story-claudecode-MIT.md'
  if (existsSync(join(bundledRoot, ...licenseRel.split('/')))) {
    const licenseText = readFileSync(join(bundledRoot, ...licenseRel.split('/')), 'utf-8')
    if (!/Copyright \(c\)/i.test(licenseText)) {
      problems.push(`${bundledDir}/${licenseRel}: 缺版权行（MIT 署名义务）`)
    }
  }
  return problems
}

/**
 * 作业包引用门：`resources/skills/*.md` 的 `references` 声明的每篇，
 * 必须在随包语料里在位。
 *
 * 判据同 catalog 的「声明即门」：`references` 是「取该包时会附上哪些篇」的事实陈述，
 * 声明了却缺件 = 该包静默少一块（引用篇是增强面，缺件不报错，故只有门能拦住）。
 * 档位分派（长篇/短篇同名篇）由消费侧按书档过滤，两档都可能取到，故两档都得在位。
 */
export function scanSkillReferenceMismatches(
  projectRoot: string,
  skillsDir: string = BUNDLED_SKILLS_DIR,
  bundledDir: string = BUNDLED_KNOWLEDGE_DIR,
): string[] {
  const skillsRoot = join(projectRoot, skillsDir)
  if (!existsSync(skillsRoot)) return []
  const bundledRoot = join(projectRoot, bundledDir)
  const problems: string[] = []
  for (const en of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!en.isFile() || en.name.startsWith('.') || !en.name.toLowerCase().endsWith('.md')) continue
    const fp = join(skillsRoot, en.name)
    let text: string
    try {
      text = readFileSync(fp, 'utf-8')
    } catch (e) {
      problems.push(`${skillsDir}/${en.name}: 读取失败（${e instanceof Error ? e.message : String(e)}）`)
      continue
    }
    const r = readFile(fp, text)
    if (!r.ok) continue // 无 fm 的裸 md（用户自持形态）不声明引用，无判据可查
    const refs = parseReferences(parseFlat(r.fmRaw).get('references'))
    if (refs === undefined) continue
    for (const rel of refs) {
      if (!existsSync(join(projectRoot, KNOWLEDGE_DIR, ...rel.split('/')))) {
        problems.push(`${skillsDir}/${en.name}: references 声明 ${rel}，但 ${KNOWLEDGE_DIR}/ 无此篇`)
      } else if (!existsSync(join(bundledRoot, ...rel.split('/')))) {
        problems.push(`${skillsDir}/${en.name}: references 声明 ${rel}，但随包缺件（取包时该引用静默不附）`)
      }
    }
  }
  return problems
}

/** fm 块内是否含顶层标量键（与 manifest.fmScalar 同口径：逐行前缀匹配，只认 fm 块内） */
function hasFmKey(text: string, key: string): boolean {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m || m[1] === undefined) return false
  const prefix = `${key}:`
  return m[1].split('\n').some((line) => line.trim().startsWith(prefix))
}

// 门禁主体收进 main() + 直跑守卫：npm run check:knowledge（node 直跑本文件）时执行；
// 被测试 import（直测 scanUnregisteredKnowledgeAssets）时不触发校验/exit 副作用
function main(): void {
  const report = validateKnowledgeManifest(root)
  if (!report.ok) {
    console.error('check:knowledge 失配（知识层 manifest 与磁盘不一致，修复后再提交）：')
    for (const issue of report.issues) console.error(`  - ${issue.path}: ${issue.message}`)
    process.exit(1)
  }

  const manifest = report.manifest
  // 反向扫描的 fail-closed 抛错（symlink→目录等）转人话报错 + 非零退出，
  // 不裸栈崩（脚本门禁口径与上方失配报告一致）
  let unidentified: string[] = []
  try {
    unidentified = scanUnregisteredKnowledgeAssets(root, manifest)
  } catch (e) {
    console.error(`check:knowledge 反向扫描失败（${e instanceof Error ? e.message : String(e)}）`)
    process.exit(1)
  }
  if (unidentified.length > 0) {
    console.error('check:knowledge 反向扫描发现盘上未登记资产（非草稿/非 README/非隐藏，进 CI 需登记 manifest）：')
    for (const p of unidentified) console.error(`  - ${p}`)
    process.exit(1)
  }

  // 随包语料对账（写稿面接入批）：resources/knowledge/ 与 知识层/ 逐字节相等 + catalog 声明面在位
  const bundledProblems = scanBundledCorpusMismatches(root)
  if (bundledProblems.length > 0) {
    console.error('check:knowledge 随包语料对账失败（resources/knowledge 必须与 知识层/ 逐字节一致）：')
    for (const p of bundledProblems) console.error(`  - ${p}`)
    process.exit(1)
  }

  // 署名门（语料重建批）：随包篇 source/license frontmatter + 许可件版权行
  const attributionProblems = scanBundledMissingAttribution(root)
  if (attributionProblems.length > 0) {
    console.error('check:knowledge 署名门失败（MIT 再分发义务：每篇须带 source/license，许可件须含版权行）：')
    for (const p of attributionProblems) console.error(`  - ${p}`)
    process.exit(1)
  }

  // 作业包引用门：references 声明的篇须在 知识层/ 且随包在位
  const referenceProblems = scanSkillReferenceMismatches(root)
  if (referenceProblems.length > 0) {
    console.error('check:knowledge 作业包引用门失败（references 声明的篇必须随包在位，否则取包时静默不附）：')
    for (const p of referenceProblems) console.error(`  - ${p}`)
    process.exit(1)
  }

  const count = manifest?.entries?.length ?? 0
  const declared = BUNDLED_CATALOG.filter((e) => e.faces.length > 0).length
  console.log(
    `check:knowledge 通过：知识层 ${count} 条 manifest 条目与磁盘一致；反向扫描无未登记资产；随包语料与 知识层/ 原稿逐字节一致（catalog 声明注入面 ${declared} 篇在位）；署名门与作业包引用门通过。`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
