/**
 * 写章文件名净化（R-10，第十六轮；win 适配批 2 升格单一真相源，2026-08-27）。
 *
 * AI 产出标题（不可信）可超长（ENAMETOOLONG）或含控制字符/换行（块标量多行标题），
 * 直接拼文件名会在写盘时炸或产生含换行的非法名。对齐导出侧 X-P2-4 口径
 * （src/export/index.ts：码位 + 字节双封顶），但正文文件名拼接点更长
 * （卷目录 + 4 位章号前缀 + 原子写 tmp 名 +49B 余量），取更紧的常数：
 * 码位 ≤60 / 字节 ≤120，超长截断且不切多字节字符。
 *
 * win 适配批 2（2026-08-27）：本模块升格为全库非法字符净化的单一真相源——
 * 新增 Windows 保留设备名规避（mac 上也是合法目录名，但拷至 win 会被拒）与
 * 尾部点/空格剥离（win 落盘被自动剖，读写名不一致歧义）。mac 同样执行，
 * 保持数据面跨平台一致。既有调用方（style-entry/scene 名、foreshadow、tree、
 * export）逐一收敛至此。
 */

/** 码位封顶（对齐导出侧 FILENAME_MAX_CP 口径但更紧：正文文件名拼接点更长） */
const CHAPTER_TITLE_MAX_CP = 60
/** 字节封顶（255B - 原子写 tmp 余量 52B - 前缀/后缀余量，留足 120B） */
const CHAPTER_TITLE_MAX_BYTES = 120

/** 码位 + 字节双封顶截断（不切多字节字符）。非法字符净化后单独调用。
 *  预算可按拼接点覆写（export 用更强的 80/255-52 后缀感知预算）。 */
function truncateTitle(input: string, maxCp = CHAPTER_TITLE_MAX_CP, maxBytes = CHAPTER_TITLE_MAX_BYTES): string {
  const cps = Array.from(input)
  let out = ''
  let used = 0
  for (let i = 0; i < cps.length; i++) {
    if (i >= maxCp) break
    const b = Buffer.byteLength(cps[i]!, 'utf8')
    if (used + b > maxBytes) break
    out += cps[i]!
    used += b
  }
  return out
}

/** Windows HTTP 保留设备名前缀（win 适配批 2）。这些名字本身是合法目录名，但
 *  拷到 Windows 会被文件系统拒绝；新写入数据面预留规避（加 `_` 前缀）。 */
export const RESERVED_WIN = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CLOCK$',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/** 对已净化标题做 Windows 兼容再处理：尾点/尾空格剥离 + 保留设备名避让。
 *  同名存储路径语义（尾点自动被剥会读写名不一致）在 mac 上也一致执行。 */
function winCompatNamePart(name: string): string {
  const stripped = name.replace(/[. ]+$/, '')
  if (stripped === '') return stripped
  const base = stripped.split('.')[0]!.toUpperCase()
  return RESERVED_WIN.has(base) ? '_' + stripped : stripped
}

/**
 * 单一真相源：净化文件名的标题段——剥控制字符 → 替换非法文件名字符 →
 * [[ ]] 转义 → 尾点/尾空格剥离 + 保留设备名避让 → 码位 + 字节双封顶 →
 * 非空兜底（`未命名`）。供正文/风格库/伏笔/树工具/导出等所有拼文件名点收敛。
 */
export function sanitizeFileNamePart(title: string, maxCp?: number, maxBytes?: number): string {
  // R31-17（三十一轮）备案：本函数不做 NFC/NFD 归一与大小写折叠——macOS NFD 与
  // 「ABC/abc」碰撞由调用方章号前缀（数字段区分）与 O_EXCL 序号兜底，未观察到实害；
  // 收敛归一须同步存量文件迁移，超出本轮。

  const cleaned = title
    // 控制字符（含换行/回车/制表，块标量多行标题会带出）一律剥除
    // （R32-41：此处历史 eslint-disable no-control-regex 指令已清——规则未启用，指令失效）
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // 非法文件名字符：路径分隔符（防 ../ 越出 bookRoot）等
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    // X-P2-9：转义 [[ ]] 防止文件名解析成链接文本
    .replace(/\[\[/g, '（')
    .replace(/\]\]/g, '）')
  const out = winCompatNamePart(truncateTitle(cleaned, maxCp, maxBytes))
  return out === '' ? '未命名' : out
}

/** 写章文件名的标题段净化（保留原 firma 单源名字便于既有调用方 diff 收敛）。 */
export function sanitizeChapterTitle(title: string): string {
  return sanitizeFileNamePart(title)
}

/**
 * R33-9（三十三轮）：完整文件名段净化（rename/copy 目标名专用）——同一套非法字符/
 * 控制字符/[[ ]] 转义/尾点尾空格/保留设备名纪律，但**不做长度封顶**（长度预算是各
 * 拼接点组合时的责任：updateChapterMeta 等已按 sanitizeChapterTitle 封顶；此处对
 * 「前缀+标题+扩展名」整体再封顶会把前缀/扩展名算进预算产生二次截断 mangle），
 * 且扩展名感知：保留名判定与尾点剥离作用于词干，扩展名保留。
 */
export function sanitizeFullFileName(name: string): string {
  // 先整体剥尾点/尾空格（win 落盘自动剥；防下方 ext 捕获组把尾点吞进扩展名）
  const pre = name.replace(/[. ]+$/, '')
  const m = /^([\s\S]*?)(\.[^./\\]*)?$/.exec(pre)
  const rawStem = m?.[1] ?? pre
  const ext = (m?.[2] ?? '').replace(/[\\/]/g, '_')
  const stem = (rawStem
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .replace(/\[\[/g, '（')
    .replace(/\]\]/g, '）'))
  const compat = winCompatNamePart(stem)
  return (compat === '' ? '未命名' : compat) + ext
}
