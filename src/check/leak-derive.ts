/**
 * B4（批 6，P6-①）：信息差关键词从布线账本自动派生。
 *
 * 秘密本来就声明在 布线/<类>/*.md 的账本 front matter 里（「账本即真相」既有口径），
 * 逐书手填 book.yaml checks.leak_keywords 易漏——账本 fm 新增可选键 leak_keywords: [..]
 * （加性），派生即递归扫描账本 fm 收集键值。未声明任何键 → 空数组（维持现状静默
 * 跳过，X-P2-22 语义不变）。
 */
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { splitInlineArray } from '../format/frontmatter.js'
import { isMdFileName } from '../format/filename.js'
import { splitFrontMatter, stripInlineComment } from '../format/frontmatter-core.js'

/**
 * 扫描 布线/ 全部 md 账本的 front matter，收集 leak_keywords 数组值（去重、去空）。
 * fm 解析容错：坏文件/无 fm 跳过（派生是增强，不做故障源）。
 * 简单 YAML 单行数组（`leak_keywords: [甲, 乙]`）与逐行列表（`- 甲`）都收。
 *
 * R47-26（四十七轮）：进程级指纹缓存——runAllChecks 每章在入参/书级都没给
 * leak_keywords 时都会调到本函数（runner.ts 三级供给的末级），此前每次调用都
 * 全量重扫 布线/（递归 walk + 每文件 readFileSync 解析 fm），数百章书一次树
 * 红点聚合是 O(章数×布线文件数) 的重复 IO。套用 readIronRules 的 R73-31
 * （二十一轮）范式：(mtimeNs,size) bigint 指纹 + 目录 stat 摘要 + FIFO 上限
 * ——结果只随布线 md 文件集变化，指纹失配自动重算；命中返回拷贝防调用方
 * mutate 污染缓存（R27-27 口径）。
 */
export function deriveLeakKeywords(bookRoot: string): string[] {
  const wiringDir = join(bookRoot, '布线')
  const fp = wiringDirFp(wiringDir)
  const hit = leakKeywordsCache.get(bookRoot)
  if (hit && hit.fp === fp) return [...hit.keywords]
  const keywords = scanLeakKeywords(wiringDir)
  leakKeywordsCache.set(bookRoot, { fp, keywords })
  // 容量纪律（R73-31 同款）：超上限 FIFO 修剪最旧书目录（Map 插入序）
  while (leakKeywordsCache.size > LEAK_KEYWORDS_CACHE_MAX) {
    const oldest = leakKeywordsCache.keys().next().value
    if (oldest === undefined) break
    leakKeywordsCache.delete(oldest)
  }
  return [...keywords]
}

/** R47-26：deriveLeakKeywords 进程级指纹缓存（bookRoot → 条目）。容量对齐
 *  ironRulesCache 的 64 书目录纪律（R70-21/R73-31 同款）；指纹见 wiringDirFp。 */
const LEAK_KEYWORDS_CACHE_MAX = 64
const leakKeywordsCache = new Map<string, { fp: string; keywords: string[] }>()

/**
 * R47-26：布线目录树 stat 指纹 "count:size:maxMtimeNs:相对路径FNV"（递归 md 文件，
 * 跳过 ._ 资源文件——与扫描面一致）。派生输出只由「全部 md 文件的 fm 内容」决定
 * （文件名不入输出），但路径入 hash 对齐 tree-issues dirFp 口径（改名会多一次
 * 重算，过度失效方向安全）；.md → 非 md 改名动 count（该文件本就移出扫描面）。
 * 目录未装 = 'absent'（确定性空结果，仍缓存——ironRulesFp 同款）。指纹与实际
 * 扫描之间的竞态（TOCTOU）由下轮指纹自然变化自愈，方向安全。
 */
function wiringDirFp(dir: string): string {
  if (!existsSync(dir)) return 'absent'
  let count = 0
  let size = 0n
  let maxMtime = 0n
  let nameHash = 0x811c9dc5
  const walk = (d: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('._')) continue
      const fp = join(d, e.name)
      if (e.isDirectory()) walk(fp, `${prefix}${e.name}/`)
      else if (e.isFile() && isMdFileName(e.name)) {
        try {
          const st = statSync(fp, { bigint: true })
          count++
          size += st.size
          if (st.mtimeNs > maxMtime) maxMtime = st.mtimeNs
          const rel = `${prefix}${e.name}`
          for (let i = 0; i < rel.length; i++) {
            nameHash ^= rel.charCodeAt(i)
            nameHash = Math.imul(nameHash, 0x01000193) >>> 0
          }
        } catch {
          /* 竞态消失：下轮指纹自然变化 */
        }
      }
    }
  }
  walk(dir, '')
  return `${count}:${size}:${maxMtime}:${nameHash.toString(16)}`
}

/** R47-26：原扫描实现（逐字保留——坏文件/无 fm 跳过的降级语义不变），仅从
 *  deriveLeakKeywords 拆出供 miss 路径调用。 */
function scanLeakKeywords(wiringDir: string): string[] {
  if (!existsSync(wiringDir)) return []
  const out = new Set<string>()
  const collect = (kw: unknown): void => {
    if (typeof kw === 'string') {
      const t = kw.trim()
      if (t) out.add(t)
    } else if (Array.isArray(kw)) {
      for (const k of kw) collect(k)
    }
  }
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('._')) continue
      const fp = join(dir, e.name)
      if (e.isDirectory()) {
        walk(fp)
      } else if (e.isFile() && isMdFileName(e.name)) { // R38-9：.MD 账本 fm 不再漏收
        try {
          const raw = readFileSync(fp, 'utf8')
          // Q-14（第十五轮）：改走 frontmatter-core 统一提取——手写正则不处理 BOM/CRLF，
          // 带毛边的账本 fm 整段丢失 → info-leak 机检静默失效
          const fm = splitFrontMatter(raw)?.fmRaw
          if (!fm) continue
          // 逐行解析（正则块匹配在缩进/行尾组合下反直觉，线扫确定性好推理）：
          // ① 单行数组：leak_keywords: [甲, 乙]
          // ② 逐行列表：leak_keywords: 后续连续的「  - 条目」行
          // R73-24（二十一轮）：先行内注释剥离——单行数组正则要求行尾 `]`，
          // `leak_keywords: [甲, 乙]  # 灵脉秘密` 带行尾注释此前整条静默失明
          //（fm 其他键的解析均有 stripInlineComment，此处对齐同款）
          const lines = fm.split('\n')
          for (let i = 0; i < lines.length; i++) {
            const line = stripInlineComment(lines[i]!)
            // R35-21（三十五轮）：键位冒号双认 `:`/`：`（R31-2/R34D-10 同族纪律）——
            // 此前只认半角冒号，手写全角冒号的 leak_keywords 整条静默漏收（假绿）
            const inline = /^leak_keywords[:：]\s*\[(.*)\]\s*$/.exec(line)
            if (inline) {
              // ① 单行数组：leak_keywords: [甲, 乙]——引号内逗号不劈（复用 frontmatter
              //    splitInlineArray，K17 同构：["玉佩,旧案", 乙] 的「玉佩,旧案」是一个词）
              for (const item of splitInlineArray(inline[1]!)) collect(item.trim().replace(/^['"]|['"]$/g, ''))
              break
            }
            if (/^leak_keywords[:：]\s*$/.test(line)) {
              for (let j = i + 1; j < lines.length; j++) {
                const m = /^\s+-\s*(.+?)\s*$/.exec(stripInlineComment(lines[j]!))
                if (!m) break
                collect(m[1]!.replace(/^['"]|['"]$/g, ''))
              }
              break
            }
          }
        } catch {
          /* 坏文件跳过 */
        }
      }
    }
  }
  walk(wiringDir)
  return [...out]
}
