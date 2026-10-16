/**
 * 路径脱敏——把本机绝对路径替换成占位符，供「文本出本机」的两处消费面共用：诊断包
 * （日志逐行 + 环境/配置段）与 studio API 错误出口（replyError 信封的 error 文本）。
 *
 * 为何同源：两处都是文本出本机前的最后一道替换，词表与定序分两份就必然漂移——入口补的
 * 路径形态、出口漏补时，同一条 fs 错误经信封原样出到前端。故占位符口径与替换次序在
 * 本模块单源，消费面只注入各自的目录、不自持词表。
 *
 * 三层替换，按「先具体后一般」定序：
 * 1. 调用方登记的具体目录（书库根 / 应用数据）→ 带名占位符——保留「哪一类目录」这一
 *    排查信息（这三类之外的目录一律不带名）；
 * 2. 家目录形态兜底（`/Users/<名>`、`/home/<名>`、`C:\Users\<名>`）——覆盖未登记的具体
 *    目录、以及换机后用户名不同的形态；
 * 3. 其余绝对路径（`/Volumes/…`、`/tmp/…`）——Node fs 错误消息原样内嵌路径
 *    （`ENOENT: no such file or directory, open '/x/y/book.yaml'`），外接卷与临时卷不在
 *    用户目录下，只靠第 2 层会整段漏出。
 *
 * 判定面只认「带前导分隔符的绝对路径」：相对路径（书稿的 `写作/正文/0001-开篇.md`）与
 * 斜杠分句（`甲/乙`）不入射程——它们不含本机信息，替掉反而丢可读性。占位符自身的
 * 相对尾巴（`<用户目录>/文档/书库`）同样保留：替换只消掉本机前缀。
 */
import { homedir } from 'node:os'

/** 待替换的具体目录；缺省、空串与根目录（长度 ≤1）不参与替换。 */
export interface PathScrubDirs {
  workDir?: string | null
  userDataPath?: string | null
}

// 家目录形态（win 反斜杠允许成对转义形——日志里的 JSON 值会写 `C:\\Users\\x`）
const HOME_WIN_RE = /[A-Za-z]:\\+Users\\+[^\\/\s"']+/g
const HOME_POSIX_RE = /\/(?:Users|home)\/[^/\s"']+/g

/** 其余绝对路径：首段须是拉丁段（`/Users`、`/var`、`/Volumes`）——**首段判据是防误伤
 *  的主闸**：书稿相对路径的首段一律是汉字（`写作/正文/0001-开篇.md`），其间的斜杠不是
 *  路径起点，靠左视挡不住（斜杠左邻是汉字，不属词字符）。第二道是左视四类：`:`（URL 的
 *  `//`）、词字符（相对路径中段的斜杠）、`>`（本模块替出的占位符——其相对尾巴要留住）、
 *  `/`（落点在前一段之后，取其起头会把 host 段一起吃成 `/host/seg`）。尾段遇中文标点即
 *  止（`/a/b，见上` 这类行文直贴路径时不吃标点后的正文），汉字段名照收（`/Users/x/书库`）。
 *  单段形（`/api`、`/tmp`）不收：与路由串撞形概率高于其信息量。 */
const ABS_POSIX_RE = /(?<![:\w/>])\/[A-Za-z0-9._-]+\/(?:[^\s"'/\\]+\/)*[^\s"'/\\，。：；、！？（）]*/g
// win 盘符形：`D:\a\b`（同样至少两段）。左视挡 URL scheme 与标识符点号。
const ABS_WIN_RE = /(?<![:.\w])[A-Za-z]:\\+(?:[^\s"'\\]+\\)*[^\s"'\\]*/g

/**
 * 造一个脱敏器（替换为纯函数，一次构造多次调用——批量文本逐行过时省去逐行算命）。
 * 目录登记只影响带名占位符的覆盖范围：未登记的具体目录落到家目录/绝对路径两层，仍被消掉。
 */
export function createPathScrubber(dirs: PathScrubDirs = {}): (text: string) => string {
  const subs: Array<[string, string]> = []
  const workDir = dirs.workDir ?? ''
  const userDataPath = dirs.userDataPath ?? ''
  if (workDir.length > 1) subs.push([workDir, '<书库根>'])
  if (userDataPath.length > 1) subs.push([userDataPath, '<应用数据>'])
  const home = homedir()
  if (home.length > 1) subs.push([home, '<用户目录>'])
  return (text: string): string => {
    let out = text
    for (const [dir, ph] of subs) out = out.split(dir).join(ph)
    out = out.replace(HOME_WIN_RE, '<用户目录>').replace(HOME_POSIX_RE, '<用户目录>')
    return out.replace(ABS_WIN_RE, '<路径>').replace(ABS_POSIX_RE, '<路径>')
  }
}
