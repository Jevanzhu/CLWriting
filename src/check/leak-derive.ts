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
 * R46-10（四十六轮）：派生结果按「布线树 stat 指纹」缓存——runAllChecks 每章调用，
 * 此前每章递归扫 布线/ 并**整读**每个账本 md（成熟书数百账本 × 数百章 = 数万次重复
 * 文件读；runner.ts 旧注「布线目录小、md 数十级」与实况漂移）。指纹 = 递归
 * readdir+stat（count:sizeSum:maxMtimeNs:文件名FNV，不读文件内容），命中只付树级
 * stat（ironRulesFp 同款范式，mtimeNs 精度无陈旧窗口）；指纹 walk 任一目录 stat/
 * readdir 失败（瞬态竞态）→ 本轮直接走全量派生且不落缓存（下轮重试）。
 * FIFO 上限对齐章节元数据缓存 32 书纪律。
 */
const LEAK_DERIVE_CACHE_MAX = 32
const leakDeriveCache = new Map<string, { fp: string; keywords: string[] }>()

/** R46-10：布线树 stat 指纹（递归；任一环节读失败 → null = 本轮不走缓存）。 */
function wiringFingerprint(dir: string): string | null {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  let size = 0n
  let maxMtime = 0n
  let nameHash = 0x811c9dc5
  const subParts: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('._')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      const sub = wiringFingerprint(full)
      if (sub === null) return null
      subParts.push(sub)
    } else if (e.isFile() && isMdFileName(e.name)) {
      // 文件名入 hash 防「改名不改 stat」（ironRulesFp 同款纪律）
      for (let i = 0; i < e.name.length; i++) {
        nameHash ^= e.name.charCodeAt(i)
        nameHash = Math.imul(nameHash, 0x01000193) >>> 0
      }
      try {
        const st = statSync(full, { bigint: true })
        size += st.size
        if (st.mtimeNs > maxMtime) maxMtime = st.mtimeNs
      } catch {
        return null
      }
    }
  }
  return `${subParts.length}:${size}:${maxMtime}:${nameHash.toString(16)}${subParts.length > 0 ? '|' + subParts.join('|') : ''}`
}

/**
 * 扫描 布线/ 全部 md 账本的 front matter，收集 leak_keywords 数组值（去重、去空）。
 * fm 解析容错：坏文件/无 fm 跳过（派生是增强，不做故障源）。
 * 简单 YAML 单行数组（`leak_keywords: [甲, 乙]`）与逐行列表（`- 甲`）都收。
 */
export function deriveLeakKeywords(bookRoot: string): string[] {
  const wiringDir = join(bookRoot, '布线')
  if (!existsSync(wiringDir)) return []
  // R46-10：指纹命中直接回缓存结果（调用方拿到的是共享数组——机检消费面只读比对，
  // 无 mutate 面；保持共享零拷贝）
  const fp = wiringFingerprint(wiringDir)
  if (fp !== null) {
    const hit = leakDeriveCache.get(bookRoot)
    if (hit && hit.fp === fp) return hit.keywords
  }
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
  const keywords = [...out]
  // R46-10：指纹 walk 成功才落缓存（失败路径零缓存，下轮重试——不缓存不确定态）
  if (fp !== null) {
    if (leakDeriveCache.size >= LEAK_DERIVE_CACHE_MAX) {
      const oldest = leakDeriveCache.keys().next().value
      if (oldest !== undefined) leakDeriveCache.delete(oldest)
    }
    leakDeriveCache.set(bookRoot, { fp, keywords })
  }
  return keywords
}
