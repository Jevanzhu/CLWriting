/**
 * 字数与章名解析 —— 纯函数，零 Node 依赖（T2.1 抽离）。
 *
 * 从 format/chapters.ts 下沉，与服务端共用同一份口径；供 web-next 浏览器端 import
 * （chapters.ts 因 import node:fs 不可跨入浏览器）。chapters.ts re-export 本文件以保 API 不变。
 */

/** 计算正文字数（中文按字符计，#7 第 2 节）：剥 markdown 标记后按字符计。frontmatter 由调用方先剥。
 *  R31-11（三十一轮）口径备案：剥除集不含标点——对白密集章计数值系统性高于「汉字感」
 *  口径（实测可 +38%），但 _wordCount/短篇字数/字数曲线全链同源自洽，targetWords 为
 *  AI 语义给数（阈值留有弹性），维持现状不改口径（改口径需全链联动与存量曲线迁移）。
 *
 *  PM-2（性能与内存专项·2026-09-05）：改单遍零分配计数——原 `[...body.replace(...)].length`
 *  两步全量分配（剥标记副本 + 码点数组；中文每字符独立 SeqTwoByteString，200 万字单次
 *  调用瞬时垃圾 ≈70-90MB，服务端保存链 ×2/次 + 前端每击键防抖后 1 次，为全链最高频
 *  内存抖动源）。口径逐位不变：剥除集 `[#>*_`~\-\[\]()!\s]` 全部为 BMP 字符（\s 按
 *  ECMAScript 白名单全集展开为下方码点集），代理对按 1 码点计（原 `[...]` 码点迭代
 *  语义，含「高代理越过剥除字符与低代理拼对」的先剥后迭代并档行为与孤立代理各计 1
 *  的 ill-formed 行为）。等价性由 test/format/pm2-count-words-equivalence.test.ts 内嵌
 *  旧实现逐位断言钉死（200 轮混合模糊 + 大文档冒烟）。 */
const STRIP_CODE_SET: ReadonlySet<number> = new Set<number>([
  0x23, 0x3e, 0x2a, 0x5f, 0x60, 0x7e, 0x2d, 0x5b, 0x5d, 0x28, 0x29, 0x21, // #>*_`~-[]()!
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, // \t\n\v\f\r 与空格
  0xa0, 0x1680, // \s：NBSP / OGHAM SPACE MARK
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, // \s：EN QUAD..HAIR SPACE（注意 0x200b-0x200d 零宽符不在 \s，勿混入）
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, // \s：LS / PS / NNBSP / MATHEMATICAL SPACE / IDEOGRAPHIC SPACE / BOM
])

export function countWords(body: string): number {
  let n = 0
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i)
    if (STRIP_CODE_SET.has(c)) continue
    // 代理对（含 emoji/CJK 扩展）按 1 码点计。语义精确复刻旧实现「先剥后迭代」：高代理
    // 会越过剥除字符向前找低代理（旧实现剥掉中间字符后两侧恰拼成一对即并档 1 码点），
    // 孤立高代理（前方无低代理）各计 1、不吞后继字符——ill-formed 行为由等价测试钉死。
    if (c >= 0xd800 && c <= 0xdbff) {
      let j = i + 1
      while (j < body.length && STRIP_CODE_SET.has(body.charCodeAt(j))) j++
      if (j < body.length) {
        const lo = body.charCodeAt(j)
        if (lo >= 0xdc00 && lo <= 0xdfff) i = j
      }
    }
    n++
  }
  return n
}

/** 去目录 + 去 .md 扩展（替代 node:path.basename，零 Node 依赖）。
 *  R40-10（四十轮）：扩展名剥除大小写不敏感——.MD 大写章文件名（mac 敏感卷/win 手工
 *  改名形态）此前标题派生残留 .MD 尾，parseChapterFileName 的 路径/标题 派生错位。
 *  与 filename.ts isMdFileName（R38-9 单源）同口径；本文件须零 Node 依赖供 web-next
 *  浏览器 import（filename.ts 依赖 Buffer 全局），就地 toLowerCase 判定，口径注释互指。 */
function stripMd(fileName: string): string {
  const last = fileName.split('/').pop() ?? fileName
  return last.toLowerCase().endsWith('.md') ? last.slice(0, -3) : last
}

/** 从文件名提取章号（写作/正文/152-北境的雪.md → {章号:152, 标题:'北境的雪'}）。 */
export function parseChapterFileName(
  fileName: string,
): { 章号: number; 标题: string } | null {
  const base = stripMd(fileName)
  const m = base.match(/^(\d+)-(.+)$/)
  if (!m) return null
  // R64-20（十二轮）：16+ 位数字超 2^53 精度错位——isSafeInteger 守卫，非法按无章号
  const no = Number(m[1])
  return Number.isSafeInteger(no) ? { 章号: no, 标题: m[2]! } : null
}

/**
 * M-4（第十一轮）：章号补零宽度写侧单源——长篇 chapter 4 位 / 短篇 piece 3 位。
 * 此前写侧三处分裂（draft 草稿新建 3 位 / service 改名 4 位 / 前端复制 4 位），读侧
 * chapterNamePrefixes 三口径兜底掩盖风险：新增按名定位代码漏走单源即静默 miss。
 * 写侧（草稿新建/改名/复制）一律经此取前缀；与读侧 variants（chapters.ts）同口径，
 * 消费方含 web-next（零 Node 依赖，浏览器端可 import）。
 */
export function chapterFilePrefix(章号: number, kind: 'chapter' | 'piece'): string {
  return `${String(章号).padStart(kind === 'chapter' ? 4 : 3, '0')}-`
}
