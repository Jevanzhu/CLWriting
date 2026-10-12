/**
 * R63-15：check-knowledge 反向扫描（R62-53 新逻辑）纯函数直测。
 *
 * scanUnregisteredKnowledgeAssets 此前 export 无测试——豁免规则（草稿/README 白名单）
 * 改动只能偶然暴露。本文件锚定：未登记必报、登记不报、两类豁免、知识层目录缺失
 * 返回空、manifest 对象与 entries 数组两种入参形状同口径、rootDir 覆写隔离。
 * R27-135（二十七轮）：扫描面扩到任意扩展名（登记面对非 .md 放行，只认 .md 会让
 * 未登记非 .md 资产两向失明）+ _manifest.json/隐藏文件豁免，导出更名
 * scanUnregisteredKnowledgeAssets（下文既有用例名保留 R63-15 历史称呼）。
 * （check-knowledge.ts 已加直跑守卫，import 无校验/exit 副作用。）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import {
  scanUnregisteredKnowledgeAssets,
  scanBundledCorpusMismatches,
  scanBundledMissingAttribution,
  scanSkillReferenceMismatches,
  scanGenreCardAliasGaps,
} from '../../scripts/check-knowledge.js'
import { BUNDLED_CATALOG } from '../../src/knowledge/catalog.js'
import type { KnowledgeManifest } from '../../src/knowledge/manifest.js'

let dir: string

beforeEach(() => {
  dir = mkdtempTracked(join(tmpdir(), 'clw-know-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// entries 形状直接用最小对象（target 字段是唯一被读的键）
const entries = [{ target: '知识层/正式条目.md' }] as never

describe('R63-15：scanUnregisteredKnowledgeAssets 反向扫描直测', () => {
  it('盘上 .md 未登记 → 报相对路径；已登记 → 不报', () => {
    mkdirSync(join(dir, '知识层'), { recursive: true })
    writeFileSync(join(dir, '知识层', '正式条目.md'), '# 已登记')
    writeFileSync(join(dir, '知识层', '野文件.md'), '# 未登记')
    expect(scanUnregisteredKnowledgeAssets(dir, entries)).toEqual(['知识层/野文件.md'])
  })

  it('豁免白名单：文件名含「草稿」或为 README.md 不报（草稿不经版本化、README 为导航）', () => {
    mkdirSync(join(dir, '知识层', '子目录'), { recursive: true })
    writeFileSync(join(dir, '知识层', '机检误报-草稿-2026-08-24.md'), '# 草稿')
    writeFileSync(join(dir, '知识层', 'README.md'), '# 导航')
    writeFileSync(join(dir, '知识层', '子目录', '深层草稿.md'), '# 嵌套豁免')
    expect(scanUnregisteredKnowledgeAssets(dir, entries)).toEqual([])
  })

  it('递归子目录全树扫描——嵌套未登记文件以项目根相对路径上报', () => {
    mkdirSync(join(dir, '知识层', 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, '知识层', 'a', 'b', '深处.md'), '# 未登记')
    expect(scanUnregisteredKnowledgeAssets(dir, [])).toEqual(['知识层/a/b/深处.md'])
  })

  it('知识层目录不存在 → 空数组（新仓/净仓不误报）', () => {
    expect(scanUnregisteredKnowledgeAssets(dir, entries)).toEqual([])
  })

  it('manifest 对象与 entries 数组两种入参形状同口径（调用点传 report.manifest）', () => {
    mkdirSync(join(dir, '知识层'), { recursive: true })
    writeFileSync(join(dir, '知识层', '野文件.md'), '# 未登记')
    const manifest = { entries: [{ target: '知识层/正式条目.md' }] } as never
    const viaManifest = scanUnregisteredKnowledgeAssets(dir, manifest)
    const viaEntries = scanUnregisteredKnowledgeAssets(dir, entries)
    expect(viaManifest).toEqual(viaEntries)
  })

  it('rootDir 可覆写（默认知识层；直测用它隔离到临时目录——此处验证覆写生效）', () => {
    mkdirSync(join(dir, '其他层'), { recursive: true })
    writeFileSync(join(dir, '其他层', '野文件.md'), '# 未登记')
    expect(scanUnregisteredKnowledgeAssets(dir, [], '其他层')).toEqual(['其他层/野文件.md'])
  })

  // R27-135（二十七轮）：扫描面扩到任意扩展名——登记面（isSafeKnowledgeTarget/
  // validateEntry）对非 .md 放行（只跳过 fm 校验），反向扫描只认 .md 时未登记非 .md
  // 资产两向失明（正向 sha256 有条件、反向捡拾无条件盲区）。豁免：对账单本体
  // _manifest.json、隐藏文件（.DS_Store 等系统/工具噪音）。
  it('R27-135: 非 .md 资产同入反向对账——未登记上报、登记后不报；_manifest.json 与隐藏文件豁免', () => {
    mkdirSync(join(dir, '知识层', '资料包'), { recursive: true })
    writeFileSync(join(dir, '知识层', '图谱.json'), '{}')
    writeFileSync(join(dir, '知识层', '资料包', '图.png'), 'bin')
    writeFileSync(join(dir, '知识层', '_manifest.json'), '{}')
    writeFileSync(join(dir, '知识层', '.DS_Store'), 'bin')
    // 未登记非 .md 资产上报（修复前只捡 .md，两文件双向隐身）；readdir 序不保证，排序后比对
    expect(scanUnregisteredKnowledgeAssets(dir, entries).sort()).toEqual(['知识层/图谱.json', '知识层/资料包/图.png'])
    // 登记后不报（非 .md target 是合法登记面）
    const registered = [{ target: '知识层/图谱.json' }, { target: '知识层/资料包/图.png' }] as never
    expect(scanUnregisteredKnowledgeAssets(dir, registered)).toEqual([])
  })

  // R0912-3（2026-09-12 全量重评 #40）：登记面比对收敛 caseFoldKey 单源 + NFC（同
  // docJoinKey 次序：先 NFC 后折叠）。修复前精确字符串比对——大小写漂移（win/APFS
  // 同物理文件）与 NFD 文件名（mac APFS 惯存分解形）下已登记文件误报未登记（CI 假红）。
  // 折叠仅 darwin/win32 生效（platformCaseFold 口径），以 platform mock 钉折叠臂；
  // 真不同名仍须上报（归一收敛 ≠ 模糊匹配）。
  // R71-39（十九轮，并入档；原 r71-check-knowledge-symlink.test.ts）：反向扫描对
  // symlink fail-closed——修复前 Dirent.isDirectory() 对 symlink 恒 false，指向目录的
  // symlink 被静默跳过（目录内资产整树逃 R62-53 反向门）；修复后资产收集遇 symlink→
  // 目录即抛（collectKnowledgeAssetFiles，经 scanUnregisteredKnowledgeAssets 传播，
  // main 转人话报错 + exit(1)）。symlink→文件按普通资产参与反向扫描（R27-135 起不限
  // .md）：未登记即 unmatched（不豁免、不误跳）。Windows 建 symlink 需开发者模式
  //（symlinkSync 直建 EPERM），该守卫语义由 macOS/Linux CI 腿覆盖。
  it.skipIf(process.platform === 'win32')('R71-39: symlink→目录 → fail-closed 抛错（不再静默跳过整树）', () => {
    const outside = join(dir, '外部目录')
    mkdirSync(join(dir, '知识层'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, '逃逸.md'), '未登记内容', 'utf8')
    symlinkSync(outside, join(dir, '知识层', '目录链接'))

    // 修复前：isDirectory() 对 symlink 恒 false → 静默跳过（反向门被绕过）
    expect(() => scanUnregisteredKnowledgeAssets(dir, [])).toThrowError(/指向目录的 symlink/)
  })

  it.skipIf(process.platform === 'win32')('R71-39: symlink→文件 按普通资产参与反向扫描（未登记即 unmatched）', () => {
    const knowledgeRoot = join(dir, '知识层')
    const outside = join(dir, '外部文件.md')
    mkdirSync(knowledgeRoot, { recursive: true })
    writeFileSync(outside, '未登记内容', 'utf8')
    symlinkSync(outside, join(knowledgeRoot, '文件链接.md'))

    const unmatched = scanUnregisteredKnowledgeAssets(dir, [])
    expect(unmatched).toContain('知识层/文件链接.md')
  })

  it('R0912-3: 大小写漂移/NFD 文件名形态不再误报未登记；精确不匹配仍报', () => {
    const ORIG_PLATFORM = process.platform
    mkdirSync(join(dir, '知识层'), { recursive: true })
    writeFileSync(join(dir, '知识层', '条目.MD'), '# 大小写漂移形态')
    const nfcName = '阐明.md'
    const nfdName = nfcName.normalize('NFD')
    writeFileSync(join(dir, '知识层', nfdName), '# NFD 形态')
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      const registered = [{ target: '知识层/条目.md' }, { target: `知识层/${nfcName}` }] as never
      expect(scanUnregisteredKnowledgeAssets(dir, registered)).toEqual([])
      // 真不同名（登记面查无）仍报——上报磁盘原形态（不折叠不 NFC 改写）
      expect(scanUnregisteredKnowledgeAssets(dir, [{ target: '知识层/另一个.md' }] as never).sort()).toEqual(
        ['知识层/条目.MD', `知识层/${nfdName}`].sort(),
      )
    } finally {
      Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
    }
  })
})

describe('R63-15：真实仓库反向扫描——门禁口径锚定（当前全登记/全豁免）', () => {
  it('仓库根实跑（读真实 _manifest.json）：无未登记 .md（与 npm run check:knowledge 同口径）', () => {
    const rootPath = fileURLToPath(new URL('../../', import.meta.url))
    const manifest = JSON.parse(readFileSync(join(rootPath, '知识层', '_manifest.json'), 'utf8')) as KnowledgeManifest
    // R27-135 扩面后仍须空：仓库 知识层/ 的非 .md 只有 _manifest.json（豁免）与
    // .DS_Store（隐藏豁免）——扩面不得把真实仓门禁打红
    expect(scanUnregisteredKnowledgeAssets(rootPath, manifest)).toEqual([])
  })
})

// ── 知识层接入批：随包语料对账（resources/knowledge/ ↔ 知识层/ 逐字节 + 选材篇目在位）──
// 红线条：随包件漏同步 / 无原稿 / 声明注入面篇目缺位 / 目录缺失 四类必报；真实仓实跑须空。
// 语料重建批复核：篇目判据从「四常量硬编码」改 **catalog 驱动**（`faces` 非空 ⇒ 必须随包在位），
// 故 fixture 也按 catalog 造——硬编码表会在篇目增删时与门口径分叉，测不出真实判据。
describe('知识层接入批：scanBundledCorpusMismatches 随包语料对账', () => {
  /** 声明「会下发」的篇目（门判它必须在位） */
  const INJECTED_RELS = BUNDLED_CATALOG.filter((e) => e.faces.length > 0).map((e) => e.rel)
  /** 造 mini 仓：catalog 声明注入面的篇目逐字节一致 + 署名键 + README 说明（豁免） */
  function makeAlignedRepo(): void {
    for (const rel of INJECTED_RELS) {
      const body = ['---', 'source: fixture-source', 'license: MIT', '---', '', `# ${rel}`, '正文', ''].join('\n')
      const origin = join(dir, '知识层', ...rel.split('/'))
      const shipped = join(dir, 'resources', 'knowledge', ...rel.split('/'))
      mkdirSync(join(origin, '..'), { recursive: true })
      mkdirSync(join(shipped, '..'), { recursive: true })
      writeFileSync(origin, body)
      writeFileSync(shipped, body)
    }
    writeFileSync(join(dir, 'resources', 'knowledge', 'README.md'), '# 说明（非语料副本）')
  }

  it('对齐仓 → 无问题；README.md 豁免（非语料副本不比对）', () => {
    makeAlignedRepo()
    expect(scanBundledCorpusMismatches(dir)).toEqual([])
  })

  it('随包件被改一个字节 → 报不一致（改语料须两处同步）', () => {
    makeAlignedRepo()
    const rel = INJECTED_RELS[0]!
    writeFileSync(join(dir, 'resources', 'knowledge', ...rel.split('/')), '# 被改过\n正文')
    expect(scanBundledCorpusMismatches(dir).join('\n')).toContain('不一致')
  })

  it('随包件在知识层无对应原稿 → 报（随包件必须来自正式知识层）', () => {
    makeAlignedRepo()
    writeFileSync(join(dir, 'resources', 'knowledge', '野件.md'), '无原稿')
    expect(scanBundledCorpusMismatches(dir).join('\n')).toContain('知识层/ 无对应原稿')
  })

  it('catalog 声明注入面但随包缺件 → 报（该面会静默降级）', () => {
    makeAlignedRepo()
    const dropped = INJECTED_RELS[0]!
    rmSync(join(dir, 'resources', 'knowledge', ...dropped.split('/')))
    const problems = scanBundledCorpusMismatches(dir).join('\n')
    expect(problems).toContain(`resources/knowledge/${dropped}`)
    expect(problems).toContain('随包缺件')
    // 断言这判定来自声明面而非「文件不存在」——不下发的篇目缺件不报
    expect(INJECTED_RELS.length).toBeGreaterThan(0)
  })

  it('随包语料目录缺失 → 报（缺目录即写稿面降级为零注入）', () => {
    expect(scanBundledCorpusMismatches(dir).join('\n')).toContain('随包语料目录缺失')
  })

  it('真实仓库实跑：resources/knowledge 与 知识层/ 逐字节一致（与 npm run check:knowledge 同口径）', () => {
    const rootPath = fileURLToPath(new URL('../../', import.meta.url))
    expect(scanBundledCorpusMismatches(rootPath)).toEqual([])
  })
})

// ── 语料重建批：署名门（MIT 再分发义务——随包语料篇篇带 source/license；许可件含版权行）──
describe('语料重建批：scanBundledMissingAttribution 署名门', () => {
  const REL = '通用/情节推演速查.md'
  function writeBundled(content: string): void {
    const shipped = join(dir, 'resources', 'knowledge', ...REL.split('/'))
    mkdirSync(join(shipped, '..'), { recursive: true })
    writeFileSync(shipped, content)
  }

  it('缺 source/license front matter → 报两键名（按 fm 块内顶层键判，正文里出现不算）', () => {
    writeBundled(['---', 'category: 通用', '---', '', 'source: 正文里出现该词不算署名', ''].join('\n'))
    const problems = scanBundledMissingAttribution(dir).join('\n')
    expect(problems).toContain('source/license')
    expect(problems).toContain('resources/knowledge/' + REL)
  })

  it('无 front matter 块（裸 md）→ 报缺两键', () => {
    writeBundled('# 裸篇\n无 fm。')
    expect(scanBundledMissingAttribution(dir).join('\n')).toContain('缺 front matter 署名键 source/license')
  })

  it('两键在位 → 不报（README/versions 豁免不参与本门）', () => {
    writeBundled(['---', 'source: skills/x.md', 'license: MIT', '---', '', '# 篇', ''].join('\n'))
    expect(scanBundledMissingAttribution(dir)).toEqual([])
  })

  it('许可件缺版权行 → 报（MIT 署名义务）', () => {
    const lic = join(dir, 'resources', 'knowledge', '许可', 'oh-story-claudecode-MIT.md')
    mkdirSync(join(dir, 'resources', 'knowledge', '许可'), { recursive: true })
    writeFileSync(lic, '# 某许可\n无版权行。')
    expect(scanBundledMissingAttribution(dir).join('\n')).toContain('缺版权行')
  })

  it('真实仓库实跑：随包语料全体署名键在位', () => {
    const rootPath = fileURLToPath(new URL('../../', import.meta.url))
    expect(scanBundledMissingAttribution(rootPath)).toEqual([])
  })
})

describe('作业包升级批：scanSkillReferenceMismatches 作业包引用门', () => {
  const REF_REL = '通用/对话技法速查.md'
  /** 造「包 + 目标篇」两侧；origin/shipped 传 false = 该侧不落件 */
  function arrange(opts: { refs: string; origin: boolean; shipped: boolean }): void {
    const pack = join(dir, 'resources', 'skills', '对话节奏.md')
    mkdirSync(join(pack, '..'), { recursive: true })
    writeFileSync(pack, ['---', 'name: 对话节奏', `references: ${opts.refs}`, '---', '', '包正文', ''].join('\n'))
    if (opts.origin) {
      const p = join(dir, '知识层', ...REF_REL.split('/'))
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, '# 篇')
    }
    if (opts.shipped) {
      const p = join(dir, 'resources', 'knowledge', ...REF_REL.split('/'))
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, '# 篇')
    }
  }

  it('声明 + 知识层在位 + 随包在位 → 不报', () => {
    arrange({ refs: `[${REF_REL}]`, origin: true, shipped: true })
    expect(scanSkillReferenceMismatches(dir)).toEqual([])
  })

  it('声明但知识层无此篇 → 报（rel 写错 / 篇被改名）', () => {
    arrange({ refs: `[${REF_REL}]`, origin: false, shipped: false })
    expect(scanSkillReferenceMismatches(dir).join('\n')).toContain('知识层/ 无此篇')
  })

  it('知识层在位但随包缺件 → 报（取包时该引用静默不附）', () => {
    arrange({ refs: `[${REF_REL}]`, origin: true, shipped: false })
    expect(scanSkillReferenceMismatches(dir).join('\n')).toContain('随包缺件')
  })

  it('未声明 references 的包不参与本门（含裸 md 无 fm 形态）', () => {
    const pack = join(dir, 'resources', 'skills', '无引用.md')
    mkdirSync(join(pack, '..'), { recursive: true })
    writeFileSync(pack, '---\nname: 无引用\n---\n正文')
    writeFileSync(join(dir, 'resources', 'skills', '裸包.md'), '没有 fm 的正文')
    expect(scanSkillReferenceMismatches(dir)).toEqual([])
  })

  it('真实仓库实跑：随包三包的 references 目标全部在位（与 npm run check:knowledge 同口径）', () => {
    const rootPath = fileURLToPath(new URL('../../', import.meta.url))
    expect(scanSkillReferenceMismatches(rootPath)).toEqual([])
  })
})

// ── 题材卡批：scanGenreCardAliasGaps 别名门 ──────────────────────────────────
// 卡靠 aliases 命中书题材被召回；别名缺失时召回静默退化为「只有卡名能命中」（作者按
// 题材别名写的书召不到且无报错）——声明即门是唯一能拦的形态。别名数据随卡文件走。
describe('题材卡批：scanGenreCardAliasGaps 题材卡别名门', () => {
  /** 按 catalog 条目的 rel 造随包卡（fm 由调用方给，覆盖别名在/不在两态） */
  function writeCard(rel: string, fm: string): void {
    const p = join(dir, 'resources', 'knowledge', ...rel.split('/'))
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, `---\n${fm}---\n\n# 卡\n\n正文。\n`)
  }

  it('别名在位 → 不报', async () => {
    const { GENRE_CATALOG } = await import('../../src/knowledge/catalog.js')
    const first = GENRE_CATALOG[0]!
    writeCard(first.rel, 'aliases: [甲, 乙]\nlicense: MIT\n')
    // 其余卡缺件由随包对账门报，本门只判在位卡的别名
    expect(scanGenreCardAliasGaps(dir)).toEqual([])
  })

  it('卡在随包但缺 aliases → 报（召回只剩卡名能命中）', async () => {
    const { GENRE_CATALOG } = await import('../../src/knowledge/catalog.js')
    const first = GENRE_CATALOG[0]!
    writeCard(first.rel, 'license: MIT\n')
    expect(scanGenreCardAliasGaps(dir).join('\n')).toContain('缺 aliases')
  })

  it('aliases 为空数组/裸 md 无 fm → 报（空声明与缺声明同判）', async () => {
    const { GENRE_CATALOG } = await import('../../src/knowledge/catalog.js')
    const [a, b] = GENRE_CATALOG
    writeCard(a!.rel, 'aliases: []\nlicense: MIT\n')
    const p = join(dir, 'resources', 'knowledge', ...b!.rel.split('/'))
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, '裸 md 无 fm')
    const problems = scanGenreCardAliasGaps(dir)
    expect(problems.length).toBe(2)
  })

  it('真实仓库实跑：32 张卡的 aliases 全部非空（与 npm run check:knowledge 同口径）', () => {
    const rootPath = fileURLToPath(new URL('../../', import.meta.url))
    expect(scanGenreCardAliasGaps(rootPath)).toEqual([])
  })
})
