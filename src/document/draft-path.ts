/**
 * 正文区草稿路径定位/定稿覆盖守卫族 —— R0916-6-P2-2（2026-09-16 五轮全库重评修复批）
 * 自 format/draft.ts 整体上移 document 域（resolveDraftPath / ensureChapterNotFinalized /
 * extractTitleFromContent / inferVolumeDir / cnVolumeNum / slashRelative 逐字节随迁，
 * 块内 R-编号锚注原样随迁）。
 * 动机：resolveDraftPath 内嵌定稿覆盖守卫（ensureChapterNotFinalized）须读项目清单
 * （document 域单源），原 format → document 反向边是域分层倒挂（底座 format 依赖
 * 上层 document 的环风险边）；守卫与路径定位强耦合（W-P1-5 契约：写路径
 * resolveDraftPath 抛 = 拒绝覆盖定稿，migrate-layout-v3 W-P1-5 与 4 处钉测试依赖），
 * 不可拆回调用方——整体上移后 format/draft.ts 残核（readDraft/draftParseReason）
 * 零 document 依赖，document → format 单向边保持（document/draft-path 只 import
 * format/{frontmatter,chapters,words,filename} 与 fs/log）。
 * 消费面 import 改道随本批完成（src 6 + test 11）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { splitFrontMatter, parseFlat } from '../format/frontmatter.js'
import { readChapterDir } from '../format/chapters.js'
import { chapterFilePrefix } from '../format/words.js'
import { sanitizeChapterTitle, isMdFileName, chapterNoFromName } from '../format/filename.js'
import { normalizeWinSeparators } from '../fs/safe-path.js'
import { readManifest } from './manifest.js'
// R37-9：正文目录卷扫描 readdirSync 容错降级留痕（同 run.ts/runner.ts 口径）
import { log } from '../log/index.js'

// ── 正文区草稿路径定位（草稿目录取消后，草稿直接写正文区）──────────────

/**
 * 定位正文区草稿落盘路径（draft/final 同路径，靠 git 状态区分）。
 * - 已有同章号文件 → 覆盖写（返回该路径）
 * - 新章 → 从 content frontmatter 解析标题，推断卷目录，生成正式文件路径
 * - opts.forRead（R68-1）：只读定位口径——跳过定稿覆盖守卫。对话上下文注入 /
 *   check_chapter / read_chapter 等纯读消费方定位定稿章属合法（定稿章是长篇创作
 *   占比最高的存量），误挂写防线会让「带着定稿章上下文对话/机检」整体失败且文案
 *   误导（「拒绝覆盖写」）。写路径（saveDraft/rewrite/self-heal/迁移）不传——守卫不变。
 */
export function resolveDraftPath(
  bookRoot: string,
  chapter: number,
  content?: string,
  opts?: { forRead?: boolean },
): { relPath: string; existed: boolean } {
  const bodyDir = join(bookRoot, '写作', '正文')

  // 1. 已有同章号 → 覆盖（V-P1-3：已定稿章除外——覆盖定稿 = 静默摧毁作者已确认内容）
  if (existsSync(bodyDir)) {
    const { chapters, errors } = readChapterDir(bodyDir)
    const hit = chapters.find((c) => c.章号 === chapter)
    if (hit?._path) {
      const relPath = slashRelative(bookRoot, hit._path)
      if (!opts?.forRead) ensureChapterNotFinalized(bookRoot, relPath, chapter)
      return { relPath, existed: true }
    }
    // R72-8（二十轮 C-4）：同章号旧文件 fm **损坏**（fm 在但字段解析失败）时不再静默
    // 新建第二份并存——后续 readdir 序定位可能命中坏版本，写路径写错文件。fail-loud
    // 让作者先修复 fm。「缺少 front matter」豁免：无 fm 旧稿（手写/迁移存量）是合法
    // 形态（覆写链有 isUtf8Bytes+留底守卫处置，R66-1），不在此拦。forRead 只读定位
    // 不建文件，维持未命中原语义。
    if (!opts?.forRead) {
      const broken = errors.find((e) => {
        if (/缺少 front matter/.test(e.message)) return false
        // R34D-11（三十四轮）：`i` 标志——win 手工改名 `.MD` 旧文件 fm 损坏时此前
        // 不被认作同章号旧文件，fail-loud 守卫失守、静默新建第二份并存
        const m = /(\d+)[^/\\]*\.md$/i.exec(e.file)
        return m !== null && Number(m[1]) === chapter
      })
      if (broken) {
        throw new Error(
          `第 ${chapter} 章旧文件 front matter 损坏（${broken.file}：${broken.message}），请先修复后再保存，避免同章号出现双份文件`,
        )
      }
    }
  }

  // 2. 新章 → 生成正式文件路径（标题净化路径分隔符，防 AI 产出含 ../ 的标题越出 bookRoot）
  const title = extractTitleFromContent(content) ?? `第${chapter}章`
  // M-4（第十一轮）：补零走 chapterFilePrefix 单源（长篇 4 位）——原 3 位与 service 改名
  // （4 位）写侧分裂，靠读侧 chapterNamePrefixes 三口径兜底；统一后新章与改名同口径，
  // 存量 3 位文件读侧仍全口径兼容
  // R-10（第十六轮）：标题净化收口到 sanitizeChapterTitle（对齐导出侧 X-P2-4 口径：
  // 剥控制字符/换行 + 替换非法文件名字符 + 码位+字节双封顶）——原先只替换 \\/\0，
  // 超长 emoji 标题直接 ENAMETOOLONG、块标量多行标题把 \n 带进文件名
  const fileName = `${chapterFilePrefix(chapter, 'chapter')}${sanitizeChapterTitle(title)}.md`

  // 推断卷目录（上一章所在卷 > 最新卷 > 第一卷）
  return { relPath: `写作/正文/${inferVolumeDir(bookRoot, chapter)}/${fileName}`, existed: false }
}

/** 从 content frontmatter 提取标题（无 frontmatter/无标题 → null）。 */
function extractTitleFromContent(content?: string): string | null {
  if (!content) return null
  const split = splitFrontMatter(content)
  if (!split) return null
  const title = parseFlat(split.fmRaw).get('标题')
  return typeof title === 'string' && title.trim() ? title.trim() : null
}

/** V-P1-3：目标章已定稿（manifest finalizedRevision 基线在位）→ 拒绝覆盖写。
 *  态 4 续写/对话 agent/自动连写的章号一旦指向已定稿章（如坏 fm 副本文件抢章号），
 *  无条件覆盖会静默摧毁定稿内容；fail-closed，由调用方提示作者走回滚或另立章号。
 *  清单缺失/不可读（legacy 书）无定稿信息可依 → 维持旧行为不阻断。
 *  W-P2-2：除精确 path 外，同章号定稿条目一并拦截——定稿章被作者/外部工具改名后
 *  清单仍挂旧 path，只按 path 匹配会让覆盖分支命中改名后的新文件而绕过防线。
 *  RB-KN-P1-2：章号匹配改数值口径（^(\d+)- 提取后 Number 比对）——原先按 3 位补零
 *  前缀匹配，而 service 重命名生成 4 位补零（0005- 不匹配 005-），防线在改名书上失守。 */
function ensureChapterNotFinalized(bookRoot: string, relPath: string, chapter?: number): void {
  let manifest: ReturnType<typeof readManifest>
  try {
    manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  } catch {
    return
  }
  for (const e of manifest.entries.values()) {
    if (e.nodeType !== 'document' || !e.finalizedRevision) continue
    if (e.path === relPath) {
      throw new Error(`第 ${relPath} 章已定稿，拒绝覆盖写；如需重写请先回滚该章定稿或另立章号`)
    }
    if (chapter !== undefined) {
      // R51-F-2（五十一轮）：章号数值匹配限正文路径——finalizedRevision 是全文档通用
      // 语义（章纲/设定等非正文文档也可定稿，其文件名同样数字开头，如
      // 大纲/章纲/0012-x.md）；不限路径时定稿章纲 0012 会把正文第 12 章的续写/连写
      // 全量误拦「已定稿」。精确 path 分支（上方）不设限：对既定目标路径的覆盖拦截
      // 与文档类型无关。清单 path 为 slash 形 rel（与上方 relPath 构造同源）。
      if (!e.path.startsWith('写作/正文/')) continue
      // 七轮重评-4（2026-09-19 源码独立重评七轮修复批）：内联窄正则 `^(\d+)-` 收编
      // chapterNoFromName 单源（finalize.ts inferChapterFromName / summary.ts 同款
      // callshape：带全名含 .md 直传；宽集 `-`/`—`/空白/裸尾均认）——定稿章被外部
      // 工具改名成 `5—标题.md`/`5 标题.md` 后本分支此前不命中，与精确 path 分支
      // （清单挂旧 path 同样不中）双双失守，覆盖写放行。裸数字 `0012.md` 形态维持
      // R1010c-EN-P2-1 在案口径不扩集（三处消费方同不识别，扩集系台账待拍板项）。
      const no = chapterNoFromName(e.path.split('/').pop() ?? '')
      if (no !== null && no === chapter) {
        throw new Error(`第 ${chapter} 章已定稿（${e.path}），拒绝覆盖写；如需重写请先回滚该章定稿或另立章号`)
      }
    }
  }
}

/** 长篇卷目录推断：上一章卷 > 最新卷 > 第一卷。 */
export function inferVolumeDir(bookRoot: string, chapter: number): string {
  const bodyDir = join(bookRoot, '写作', '正文')
  if (existsSync(bodyDir)) {
    const { chapters } = readChapterDir(bodyDir)
    const prev = chapters.find((c) => c.章号 === chapter - 1)
    if (prev?._path) {
      const seg = slashRelative(bodyDir, prev._path).split('/')[0]
      // R40-10（四十轮）：章文件判定走 isMdFileName（大小写不敏感）——.MD 章文件直挂
      // 正文根（无卷层）时，此前 seg='0001-x.MD' 不命中小写 endsWith('.md') 被误当
      // 卷目录返回，新章路径派生进不存在的「0001-x.MD/」目录（路径派生错位）
      if (seg && !isMdFileName(seg)) return seg
    }
    // Z-18（第五十八轮）：「第N卷」按数值序取末位——字典序会得「第十一卷 < 第四卷」
    //（汉字码位），跳章回退时新章落错卷；非数字卷名回落中文 locale 字典序
    const volNum = (name: string): number | null => {
      const m = /^第([0-9一二三四五六七八九十百]+)卷$/.exec(name)
      return m ? cnVolumeNum(m[1]!) : null
    }
    // R37-9（三十七轮）：existsSync→readdirSync 间隙目录被瞬删/异常迁移（TOCTOU，同
    // R65-16 口径）或路径被文件占用（ENOTDIR——existsSync 对文件同为 true）时 ENOENT/
    // ENOTDIR 直穿炸整条写章链路——降级空列表 + warn 留痕（回落「第一卷」缺省，与
    // bodyDir 不存在时同一出口），其余错误码照旧抛（失败可见）
    let vols: string[] = []
    try {
      vols = readdirSync(bodyDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        log.warn('draft', `正文目录卷扫描失败（${bodyDir}，${code}），卷目录按缺省回落`)
      } else {
        throw e
      }
    }
    vols = vols.sort((a, b) => {
      const na = volNum(a)
      const nb = volNum(b)
      if (na !== null && nb !== null) return na - nb
      return a.localeCompare(b, 'zh-Hans-CN')
    })
    if (vols.length > 0) return vols[vols.length - 1]!
  }
  return '第一卷'
}

/** Z-18：卷号中文数字/阿拉伯 → 数值（卷目录排序用；一~九十九覆盖现实卷数，
 *  更大数值或混合形态返回 null 走字典序回落） */
function cnVolumeNum(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s)
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  // 无「十」：纯个位（N）；有「十」：N十M / 十M / N十 / 十
  if (!s.includes('十')) return s in digits ? digits[s]! : null
  const parts = s.split('十')
  if (parts.length !== 2 || parts[0] !== '' && !(parts[0]! in digits) || parts[1] !== '' && !(parts[1]! in digits)) return null
  const tens = parts[0] === '' ? 1 : digits[parts[0]!]!
  const ones = parts[1] === '' ? 0 : digits[parts[1]!]!
  return tens * 10 + ones
}

/** 绝对路径 → 正斜杠相对路径（win 分隔符归一走 normalizeWinSeparators 单源——win32-only）。
 *  R0916-P3-8（四轮处置批）：原无条件 `.replace(/\\/g, '/')` 在 posix 上把文件名里的
 *  字面反斜杠（posix 合法文件名字符）易帜成目录段（0001-题\目.md → 0001-题/目.md），
 *  覆盖写定位/卷段推断双双错位；收编反斜杠归一族单源后 posix 保字面、win 行为不变。 */
function slashRelative(base: string, absPath: string): string {
  return normalizeWinSeparators(relative(base, absPath))
}
