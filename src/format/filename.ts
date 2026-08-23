/**
 * 写章文件名净化（R-10，第十六轮）。
 *
 * AI 产出标题（不可信）可超长（ENAMETOOLONG）或含控制字符/换行（块标量多行标题），
 * 直接拼文件名会在写盘时炸或产生含换行的非法名。对齐导出侧 X-P2-4 口径
 * （src/export/index.ts：码位 + 字节双封顶），但正文文件名拼接点更长
 * （卷目录 + 4 位章号前缀 + 原子写 tmp 名 +49B 余量），取更紧的常数：
 * 码位 ≤60 / 字节 ≤120，超长截断且不切多字节字符。
 */

/** 码位封顶（对齐导出侧 FILENAME_MAX_CP 口径但更紧：正文文件名拼接点更长） */
const CHAPTER_TITLE_MAX_CP = 60
/** 字节封顶（255B - 原子写 tmp 余量 52B - 前缀/后缀余量，留足 120B） */
const CHAPTER_TITLE_MAX_BYTES = 120

/**
 * 净化写章文件名的标题段：剥控制字符（含 \n\r\t）→ 替换非法文件名字符 →
 * 码位 + 字节双封顶截断（不切多字节字符）。
 */
export function sanitizeChapterTitle(title: string): string {
  // R-10：控制字符（含换行/回车/制表，块标量多行标题会带出）一律剥除
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // 非法文件名字符：路径分隔符（防 ../ 越出 bookRoot）等
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
  // 码位 + 字节双封顶（X-P2-4 同款：码位挡不住 4 字节 emoji，字节截断不切多字节字符）
  const cps = Array.from(cleaned)
  let out = ''
  let used = 0
  for (let i = 0; i < cps.length; i++) {
    if (i >= CHAPTER_TITLE_MAX_CP) break
    const b = Buffer.byteLength(cps[i]!, 'utf8')
    if (used + b > CHAPTER_TITLE_MAX_BYTES) break
    out += cps[i]!
    used += b
  }
  return out
}
