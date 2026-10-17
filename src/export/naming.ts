/**
 * 导出产物命名与旧产物归档（含导出目录内相对路径文案口径 relPosixIn）。
 *
 * 不变量：产物名一律经 sanitizeFileName 净化并受码位 + UTF-8 字节双预算约束
 * （预算含 atomic 临时名余量）；旧产物只归档不删除，归档失败保留原位并回退序号兜底名
 * （覆盖保护优先于命名稳定）。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { renameWithRetry } from '../fs/atomic.js'
import { sanitizeFileNamePart } from '../format/filename.js'
import { errMsg } from '../log/index.js'
/** 净化文件名：替换路径分隔符为 _，杜绝 ../ 越出导出目录；超长截断（码位 + FF- 字节双封顶）。
 *  书名/章标题来自 book.yaml 与 frontmatter（不可信），拼文件名前须净化——
 *  AI 产出标题可任意长，超 255 字节文件名在 macOS/NTFS 直接写失败，整本导出被一章拖垮。
 *  FF-：APFS/ext4/NTFS 单段上限一律按 255 **UTF-8 字节**判（-mac适配
 *  勘误：原注「APFS 按码位判，本地恒绿会掩盖 CI 红」失实——APFS 同为 255 字节上限、
 *  无码位豁免；当前字节封顶 = 203B 名字预算 + 52B tmp 余量 = 255B，恰好贴线安全，行为不动）——
 *  码位封顶挡不住 4 字节字符（emoji 类 AI 标题 × 80 码位 = 320 字节），须再按字节截断；
 *  字节预算按各拼接点实际前后缀计算（分章序号 / 全本- / 投稿视图-平台后缀 长度不一），截断不切多字节字符。
 *  预算还须为原子写临时名让路：src/fs/atomic.ts 在同目录写 `.{名}.{pid}.{uuid}.tmp`
 *  （42B 固定 + pid 位数，Linux 上限 7 位 = 49B）——最终名贴着 255B 截断则临时名必超限，
 *  三平台均直接 ENAMETOOLONG，故预留 52B。预算含 tmp 后缀余量，未来放宽上限勿按码点算，
 *  须连 tmp 余量一并重新核账。 */
export const FILENAME_MAX_CP = 80
export const FILENAME_MAX_BYTES = 255 - 52

/** 导出目录内旧版归档子目录。 */
export const OLD_EXPORT_DIR = '.旧版'

/** txt 产物的隔离子目录——md 面的清旧/归档/覆盖保护语义按目录作用域判断
 *  （同前缀 .md/.txt 混扫会互相互删对方的稿），两种输出各自目录内自成一套。 */
export const TXT_EXPORT_SUBDIR = '纯文本'

/** 导出目录内同名前缀的序号兜底名（扩展名前插 -N，撞名递推）——归档失败时本次产物
 *  改写入它，与分章目录的「分章-N」不覆写口径同族。 */
export function nextFreeName(exportDir: string, name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let n = 2
  while (existsSync(join(exportDir, `${stem}-${n}${ext}`))) n++
  return `${stem}-${n}${ext}`
}

/** 旧产物归档而非删除——移入 导出/.旧版/（不存在则创建），
 *  同名冲突追加序号后缀；任一步失败保留原文件不动（宁可残留不可销毁：作者手改过
 *  的导出稿（改书名/换平台后再导出）被 rmSync 静默销毁不可挽回）+ warnings 留痕。
 *  返回是否归档成功——调用方据此决定本次产物写原名还是序号兜底名（原名被占且归档
 *  不下时直接覆写即销毁手改稿，与「已保留原位」警告自相矛盾）。 */
export function archiveOldExport(exportDir: string, oldName: string, warnings: string[]): boolean {
  try {
    const archiveDir = join(exportDir, OLD_EXPORT_DIR)
    mkdirSync(archiveDir, { recursive: true })
    // 同名冲突序号后缀插在扩展名前（全本-x.md → 全本-x-2.md）
    const dot = oldName.lastIndexOf('.')
    const stem = dot > 0 ? oldName.slice(0, dot) : oldName
    const ext = dot > 0 ? oldName.slice(dot) : ''
    let dstName = oldName
    let n = 2
    while (existsSync(join(archiveDir, dstName))) dstName = `${stem}-${n++}${ext}`
    // 归档 rename 收编 renameWithRetry——win 杀软/索引器
    // 瞬时锁（EPERM/EBUSY）不再直接滑进 warning 分支（3×50ms 退避；确定性错误仍走
    // catch 保留原位 + 提示手动移入，语义不变）
    renameWithRetry(join(exportDir, oldName), join(archiveDir, dstName))
    return true
  } catch (e) {
    // 通用-1：留痕补病因（e.message）——通用文案让作者无从判断
    // 失败原因（EACCES/EBUSY/…）；对齐本文件其余 catch 的 message 口径，语义不变
    warnings.push(`旧产物 ${oldName} 归档失败（${errMsg(e)}；已保留原位，请手动移入 ${OLD_EXPORT_DIR}/）`)
    return false
  }
}

export function sanitizeFileName(name: string, maxBytes: number): string {
  // 删除 sanitizeFileNamePart 之后的重复截断循环——后者已是单一
  // 真相源（非法字符 + win 尾点/保留名 + 码位/字节双预算后缀感知截断），外层逐字符
  // 循环行为恒等却构成漂移风险死码（改预算只改其一必分叉）。
  return sanitizeFileNamePart(name, FILENAME_MAX_CP, maxBytes) || '未命名'
}
/** 相对书根的 posix 路径（win 的 relative() 产反斜杠，警告文案按 / 单源——）。 */
export function relPosixIn(bookRoot: string, p: string): string {
  return relative(bookRoot, p).replace(/\\/g, '/')
}
