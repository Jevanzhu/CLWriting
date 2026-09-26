/**
 * 结构性操作 move/rename —— （源码质量评审）自 service.ts 拆出。
 *
 * 为什么独立成模块：doMoveOrRename 有两个消费方——service.ts 的公开入口
 * （moveDocument/renameDocument 及 meta 族改名链）与 service-meta.ts 的短篇/长篇
 * 文件名联动 rename（updateChapterMetaLocked 尾部 + syncRenamePieceList）。放在
 * service.ts 里会让 service-meta.ts 必须反向 import 宿主文件（评审指出的「拆出的
 * 文件与主类双向耦合」）；本模块只依赖 DocContext 与 document 叶子件，两个消费方
 * 都是单向引入，无环。
 *
 * 依赖方向：对 service.ts 仅 `import type { MoveResult }`（verbatimModuleSyntax 下
 * 编译期擦除，运行时零回边）；共享设施一律经 `ctx: DocContext` 显式取得（
 * 起不再有类实例字段/方法可摸）。
 *
 * 行为口径：本文件是 doMoveOrRename 原样的形状改写（类方法 → 模块函数 + `this.` →
 * `ctx.`），锁序（save → 布线 → 清单）、journal move-pending 记账时机、快照留底、
 * 错误码与错误信封、返回形状逐位不变；journal 路径改经 ctx.journalPathOf 单源
 * （同一条 join+encodeDocDirName 口径）。normalizeMoveToDir 随本操作迁移（原仅此处消费）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { safeDocId, normalizeWinSeparators } from '../fs/safe-path.js'
import { linkOrRenameExclusive, renameWithRetry, rmWithRetry } from '../fs/atomic.js'
import { computeRevision, computeRevisionBytes } from './revision.js'
import { layoutOf } from './layout.js'
import { appendAborted, appendMovePending, appendSettled } from './journal.js'
import { writeVersion } from './version.js'
import { invalidateTreeIndex } from './tree.js'
import { getStructSaveLockTimeoutMs } from './service-guards.js'
import { sanitizeFileNamePart } from '../format/filename.js'
import { isSamePhysicalFile, sanitizeCreateSegment } from './service-helpers.js'
import { errMsg } from '../log/index.js'
import type { DocContext } from './doc-context.js'
// 依赖方向纪律：对公共入口模块仅 import type（编译期擦除，运行时零回边）
import type { MoveResult } from './service.js'

/** move 目标目录归一——拒绝前导 '/'（绝对路径逃逸）与归一后为空
 *  （根目录/纯斜杠），折叠连续斜杠、剥全部尾斜杠；'a/b/'、'a/b//'、'a//b' 归一到
 *  同一键 'a/b'，防畸形 toDir 直拼进 manifest 造成目录身份分裂。返回 null = 非法。
 *  ：'\' 归一在前——win32 path.resolve 视 '\' 为分隔符，含反斜杠的
 *  toDir 会被 resolveSafePath 放行并真实建目录，但混合分隔符串直拼进 manifest 后，
 *  posix 口径的树扫描/前端全链 miss（docId 身份分裂 + 保存恒 REVISION_CONFLICT，
 * 同族后果）；先归一再按 '/' 口径统一校验，'\\server\\x' 伪 UNC 也被前导斜杠拒绝。
 *  ：'..'/'.' 段拒绝——下方 safeSegs「已存在则原样
 *  保留」分支对 '..' 恒命中（existsSync(join(root,'a','..')) 即 root），'..' 原文直拼进
 *  manifest 而物理落位经 resolveSafePath 词法消解落在别处 → 登记与盘上路径分裂、docId
 *  身份分裂、保存恒 REVISION_CONFLICT（/同族；口径对齐 doCopy ）。
 *  -mac适配：`\` 归一收编 normalizeWinSeparators（win32-only）——win 侧
 * 动机（path.resolve 视 `\` 为分隔符）与历史遗留兼容不变；posix 上 `\` 是合法
 *  文件名字符，含 `\` 的 toDir 按字面单段目录处理（不再扭曲为子目录）。 */
function normalizeMoveToDir(toDir: string): string | null {
  const normalized = normalizeWinSeparators(toDir)
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
  if (normalized.startsWith('/') || normalized === '') return null
  const segs = normalized.split('/')
  if (segs.includes('..') || segs.includes('.')) return null
  return normalized
}

/** move/rename 共用：查清单 oldPath → 算 newPath → 能力校验 → snapshot → rename → 清单更新。
 *  ：类方法迁模块函数，共享设施经 ctx 显式取得（本体原样，类内部成员访问改走 ctx）。 */
// doMoveOrRename 改异步——尾部清单 path 更新走
// updateManifestPath 的异步清单锁（等待期不阻塞事件循环）。
// （c 修复批）：落位段补 per-doc save 锁——原「本方法
// 不取 save 锁，由调用方 save 锁内 await」留下双向复活窗：他进程 executeSave 过锁内
// 守卫（registered/trash 复核）后、落盘前，本方法把文件 rename 走并删源，他进程的
// atomicWriteFile/createFileExclusive 会在旧路径复活已移走文件（expectedRevision=null
// 的新建语义尤其如此：文件不在盘 ⇒ 基线校验通过 ⇒ 独占创建复活）。现取
// `<journal>.save.lock` 覆盖「pending → snapshot → 落位 → 删源 → 清单 path 更新 →
// settled」整段：本方持锁时他进程 save 在取锁处等待（锁内复核看到新世界后按
// REVISION_CONFLICT 拒绝）；他进程 save 持锁时本方等待（落位发生在其保存完成后，
// 语义为「保存后移动/删除」，无复活）。锁序严格沿用全仓「save → 布线 → 清单」：
// 本锁最先取（save），其后 journal 锁（appendMovePending）与清单锁
// （updateManifestPath/upsertManifestEntryAsync 收编链）均为既有单向嵌套，无环。
// opts.holdSaveLock：调用方已持同 docId save 锁时传 false（updateChapterMetaLocked
// ——锁基建禁同进程嵌套同路径锁，重取必 5s 超时 fail-closed）；缺省 true（安全默认，
// 新调用方漏声明时 fail-loud 而非静默无锁）。syncRenamePieceList 对章纲 docId 走
// 缺省 true：章纲 save 锁与正文 save 锁是不同路径锁，正文→章纲为单向下行
//（章纲 rename 不反带正文），无 ABBA 环。
export async function doMoveOrRename(
  ctx: DocContext,
  docId: string,
  op: { kind: 'move'; toDir: string } | { kind: 'rename'; newName: string },
  opts?: { holdSaveLock?: boolean },
): Promise<MoveResult> {
  // journal 路径含 docId，入口显式 safeDocId 校验防穿越——executeSave
  // 已有 -SEC-A 守卫，此处同型构造漏校验；manifest 是可篡改数据面，构造
  // id:"../../evil" 条目后 PATCH move/rename 可把 .jsonl 写出书仓库外。
  if (!safeDocId(docId)) return { ok: false, code: 'PATH_ESCAPE', reason: '文档 ID 非法' }
  const journalPath = ctx.journalPathOf(docId) // 文件名编码口径单源（doc-context）
  // （修复批）：取锁/释放编排单源化至 withSaveLocks
  //（holdSaveLock 防同进程嵌套自锁语义随迁：false = 调用方已持同 docId
  // save 锁；获取抛出收口随迁）。结构落位段无布线文件，不传 wiring。
  return ctx.withSaveLocks<MoveResult>({
    journalPath,
    holdSaveLock: opts?.holdSaveLock ?? true,
    saveTimeoutMs: getStructSaveLockTimeoutMs(),
    onSaveLockThrown: (e) => ({
      ok: false,
      code: 'WRITE_ERROR',
      reason: `移动/重命名保存锁获取失败（未执行操作，可重试）：${errMsg(e)}`,
    }),
    onSaveLockTimeout: () => ({
      ok: false,
      code: 'WRITE_ERROR',
      reason: '移动/重命名等待超时：另一进程正在保存或移动此文档（5 秒未让出），请重试',
    }),
    body: async () => {
      // （c 修复批）：lookup 命中读已随 lookupPathByDocIdAdoptAsync
      // 收敛 strict（口径）——瞬态读失败上抛不再落「未登记」，此处收口 WRITE_ERROR
      //（未执行操作、可重试），不裸穿 MoveResult 契约。
      let oldPath: string | null
      try {
        oldPath = await ctx.lookupPathByDocIdAdoptAsync(docId)
      } catch (e) {
        return {
          ok: false,
          code: 'WRITE_ERROR',
          reason: `移动/重命名前清单查询失败（未执行操作，可重试）：${errMsg(e)}`,
        }
      }
      if (!oldPath) return { ok: false, code: 'NOT_FOUND', reason: `文档 ${docId} 未在清单登记` }

      // rename 的 newName 直拼 `${dirname}/${newName}`——含 `/`/`\`
      // 的名字不越根也会变成跨目录移动（`../x` 越层、`a/b` 进子目录），NNN-标题 文件名
      // 解析口径随之失效。basename 单源守卫：newName 必须是纯文件名。
      if (op.kind === 'rename' && basename(op.newName) !== op.newName) {
        return { ok: false, code: 'PATH_ESCAPE', reason: '新文件名不能包含路径分隔符' }
      }
      let newPath: string
      if (op.kind === 'move') {
        // toDir 此前只剥一个尾斜杠——'写作/正文//' 会把 '写作/正文//0001-x.md'
        // 直拼记入 manifest，目录身份分裂致该文档永久 REVISION_CONFLICT（registered !==
        // relPath）且 finalizedPathSet 失配（文风重扫/导出/学习链把已定稿章当草稿）；
        // 入层归一：拒绝前导 '/'（绝对路径逃逸）与归一后为空、折叠连续斜杠、剥全部尾斜杠，
        // 让 'a/b/'、'a/b//'、'a//b' 归一到同一键。
        const toDir = normalizeMoveToDir(op.toDir)
        if (toDir === null) {
          return { ok: false, code: 'BAD_INPUT', reason: '目标目录非法（前导斜杠、空目录或「.」「..」相对段不被接受）' }
        }
        // toDir 逐段消毒（补 doCreate/updateChapterMeta 单源纪律缺口）——
        // 段已存在则保持原样（不破坏既有目录身份，mac 存量 '备注.' 类名不受影响）；
        // 不存在（本次 mkdir 将创建）过 sanitizeFileNamePart，防 win 尾点/尾空格落盘自动剥
        // 致盘上名 ≠ manifest path（REVISION_CONFLICT 族）与保留设备名/非法字符裸 errno。
        const segs = toDir.split('/')
        const safeSegs = segs.map((seg, idx) =>
          existsSync(join(ctx.bookRoot, ...segs.slice(0, idx + 1))) ? seg : sanitizeFileNamePart(seg),
        )
        newPath = `${safeSegs.join('/')}/${basename(oldPath)}`
      } else {
        // newName 消毒同 create 路径单源口径（format/filename.ts 单一
        // 真相源）——此前只挡路径分隔符，Windows 非法字符/控制字符/尾点尾空格/保留
        // 设备名/超长名直落盘（跨平台拷贝被拒或读写名不一致），与 create 的静默消毒
        // 行为漂移。分隔符仍由上方守卫显式拒绝，其余非法形态按 create 同款静默调整后
        // 落盘（落盘真实路径是唯一身份，返回 path 即消毒后路径）；整段（含 'NNNN-' 前缀）
        // 共用 120 字节预算，与 createDocument 同源（双封顶锚定）。
        //（win 线同因修复：尾点/尾空格剥离、保留设备名避让经 sanitizeFileNamePart
        // → winCompatNamePart 单源已含；其 sanitizeFullFileName 变体不做整段封顶，与本处
        // 「create 同源整段预算」口径冲突——同标题 create/rename 落名不一致属身份漂移，
        // 合并取本侧；copy 路径目标名镜像盘上既有名（预算已在原创建时付过），仍用
        // sanitizeFullFileName 扩展名感知变体。）
        // -：根级文档（如脚手架必落的 简介.md）dirname
        // 为 '.'——直拼产出 './新名.md' 清单键，而 docJoinKey/树扫描/保存守卫均不剥 './'
        // → 登记与盘面分裂：docId 退化 legacyId（.版本/.journal 关联断裂）+ 前端按树
        // 路径保存恒 REVISION_CONFLICT。move（normalizeMoveToDir 拒 '.'/'..'）与 copy
        // （doCopy 双拒 '.'/'..'）同族均已修，唯 rename 的 dirname==='.' 形态漏网。
        const dir = dirname(oldPath)
        newPath = dir === '.' ? sanitizeCreateSegment(op.newName) : `${dir}/${sanitizeCreateSegment(op.newName)}`
      }
      if (newPath === oldPath) return { ok: true, docId, path: newPath } // 无变化，幂等

      // 能力校验：source rename+move，target write（§7.2）
      const srcCaps = layoutOf(oldPath).capabilities
      if (!srcCaps.rename || !srcCaps.move) {
        return { ok: false, code: 'CAPABILITY_DENIED', reason: '该文档不可移动/重命名' }
      }
      if (!layoutOf(newPath).capabilities.write) {
        return { ok: false, code: 'CAPABILITY_DENIED', reason: '目标位置只读' }
      }

      const oldSafe = ctx.resolveSafePath(oldPath)
      const newSafe = ctx.resolveSafePath(newPath)
      if (!oldSafe || !newSafe) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
      if (!existsSync(oldSafe)) return { ok: false, code: 'NOT_FOUND', reason: '源文件不存在' }
      // （win 平台专项）：纯大小写改名在大小写不敏感 FS（win NTFS/mac APFS）
      // 上 newSafe 与 oldSafe 是**同一物理文件**——恒走 ALREADY_EXISTS，作者无法只改标题
      // 大小写。对齐书级改名口径：目标存在但与源 dev+ino 相等 → 放行（落位侧走
      // 原位 renameSync 大小写变体）；inode 不等才是真冲突，照常 409。
      if (existsSync(newSafe) && !isSamePhysicalFile(oldSafe, newSafe)) {
        return { ok: false, code: 'ALREADY_EXISTS', reason: '目标已存在' }
      }

      // journal 兜底移动/重命名的非原子窗口——pending → snapshot+rename → 清单更新 → settled。
      // 窗口内崩溃：进门 healthCheck 按磁盘现状确定性收口（new 在 old 不在 → 补清单；old 在 new 不在 → abort）。
      // （journalPath 已上提到取锁处。）
      // ee-pending 写入收进 try——appendMovePending 同步抛（磁盘满/权限）此前在 try 外
      // 裸穿，而调用方以 Promise.resolve 包裹本方法（不捕获同步 throw），拿到的是裸异常而非
      // {ok:false} 契约（save 路径同类已修，此处对齐）。pending 仍先于
      // snapshot+rename，崩溃恢复语义不变。
      // （c 修复批）：settled 复用移动前单读派生的 baseRev——
      // 移动/重命名内容不变（同 inode 落位），newSafe 的盘上指纹与 oldContent 恒等，原
      // computeRevision(newSafe) 在 settled 处再整读全文属重复 IO（单读派生同族
      // 收口）。行为零变更。防御回落仅在「readFileSync(oldSafe) 未执行即失败」的不可达
      // 路径兜底（此刻早已走上方 catch 返回，到不了 settled）。
      let opId: string | undefined
      let baseRev: `sha256:${string}` | undefined
      try {
        opId = await appendMovePending(journalPath, docId, oldPath, newPath)
        // snapshot 留底（移动/重命名前，§7）
        // 留底读原始字节——utf-8 文本读入会把 GBK 等非 UTF-8 源变
        // U+FFFD 失真快照（假留底：移动覆盖后原字节任何形式不可恢复）。writeVersion 支持
        // 原字节直存（front matter utf-8 + 原字节拼接），快照即字节档。
        // baseRev 单读派生——快照反正要整读原字节，rev 从同份
        // 字节派生（computeRevision(oldSafe) 此前独立再读一遍全文）
        const oldContent = readFileSync(oldSafe)
        baseRev = computeRevisionBytes(oldContent) // 单读派生（同份字节，免独立重读）；：settled 复用
        // 留底补传 policy（ctx.snapshotPolicy）——此前缺省走
        // DEFAULT_VERSION_POLICY（14 天/30 个），global.json 的 snapMax* 覆盖对移动/重命名
        // 前留底不生效，与同文件 maybeSnapshot/updateChapterMeta/updateDocMeta 写法漂移；
        // 留底是"必须留"时刻，force 与既有缺省（true）一致，显式写明。
        writeVersion(
          ctx.snapshotsDir,
          docId,
          oldContent,
          {
            origin: 'manual',
            reason: op.kind === 'move' ? '移动前留底' : '重命名前留底',
            baseRevision: baseRev,
          },
          { policy: ctx.snapshotPolicy(), force: true },
        )
        mkdirSync(dirname(newSafe), { recursive: true })
        // existsSync→renameSync 的 TOCTOU 窗口内目标位被跨进程并发落位
        // → POSIX rename / win MOVEFILE(REPLACE_EXISTING) 均静默覆盖（双方调用都返回成功，
        // 先到者正文从工作区消失，仅存快照留底）。文件改 linkSync 原子探测（回收站
        // 还原同款）：EEXIST → ALREADY_EXISTS（link 失败即占用，无窗口）；成功 → 内容已借
        // 硬链接落位，再删源（同一 inode，无复制窗口）。删源失败 → 旧位仍在、清单未动，
        // 按失败收口（新位成孤儿副本，语义同下方「清单更新失败」：不丢数据）。本方法只
        // 处理文档文件；目录结构性操作走 books.ts，无目录分支。
        // EEXIST 判定只认 link 这一步（转成哨兵码再统一收口）——journal/snapshot 的
        // mkdirSync 撞同名文件同样抛 EEXIST，混入外层 catch 会把 WRITE_ERROR 误判成
        // 「目标已存在」（ee- 用例：.journal 槽位被普通文件占用）。
        // 接入 linkOrRenameExclusive——EPERM/ENOSYS/EACCES（exFAT/
        // FAT32/部分 SMB 不支持硬链接）降级 rename 落位（'exists' 判定语义不变），非
        // NTFS 卷上移动/重命名不再全线失败。
        // 目标位已有文件时——预检已放行「同一物理文件」（纯大小写变体），此处
        // 复核防 TOCTOU 窗内被换成语义不同的他文件（inode 不等 → 与 link-EEXIST 同语义
        // 收口）；原位 renameSync 落大小写变体（win MoveFileEx/mac APFS 均支持；posix 上
        // 同 dev+ino 仅硬链接形态可达，rename 合并同名链接同数据无损）。
        if (existsSync(newSafe)) {
          if (!isSamePhysicalFile(oldSafe, newSafe)) {
            throw Object.assign(new Error('目标已存在'), { code: 'ALREADY_EXISTS' })
          }
          renameWithRetry(oldSafe, newSafe)
        } else {
          const placed = linkOrRenameExclusive(oldSafe, newSafe)
          if (placed === 'exists') {
            throw Object.assign(new Error('目标已存在'), { code: 'ALREADY_EXISTS' })
          }
          // 删源撞 EBUSY（win 文件被占用）时回收已落位的新位硬链接，
          // 恢复「源在旧位、目标位空」的预操作状态——否则本次按 WRITE_ERROR 收口后重试
          // 恒 ALREADY_EXISTS，需手工清理。回收失败仍留孤儿副本（硬链接同数据，无丢失）。
          // 删源收编 rmWithRetry（fs/atomic.ts ，trash.ts :287
          // 先例）——瞬时锁退避后仍失败才走既有回收+报错链，语义不变（默认 rm 即
          // rmSync(p,{force:true})，与原裸调逐位同源）。
          try {
            rmWithRetry(oldSafe)
          } catch (rmErr) {
            try {
              // （全库代码审）：回滚删新位硬链接收编 rmWithRetry
              //（同上 :1137 处）——瞬时锁退避自愈，退避后仍失败照旧吞错留孤儿副本
              rmWithRetry(newSafe)
            } catch {
              /* 新位残留孤儿副本：内容无损，重试前需手工清理 */
            }
            throw rmErr
          }
        }
      } catch (e) {
        // pending 本身没写进去（opId 未赋值）时无从 abort——journal 里没有悬置记录
        // 低-4appendAborted 自身失败（journal 目录被删/磁盘满/权限）不再穿透——
        // 此处已在失败善后路径上，留痕失败只降级（悬置 pending 由进门 healthCheck 收口），
        // 必须保住 {ok:false} 契约，不能把调用方换成吃裸异常
        if (opId !== undefined) {
          try {
            await appendAborted(journalPath, opId, errMsg(e))
          } catch {
            /* 留痕失败吞掉：journal 无 aborted 行 → 悬置 pending 待恢复链收口 */
          }
        }
        // linkSync 的 EEXIST = 目标位在预检后被并发占用——按 ALREADY_EXISTS 收口
        // （此时什么都没动：源在旧位、清单未改，journal 已 abort）
        if ((e as NodeJS.ErrnoException).code === 'ALREADY_EXISTS') {
          return { ok: false, code: 'ALREADY_EXISTS', reason: '目标已存在' }
        }
        return { ok: false, code: 'WRITE_ERROR', reason: `移动/重命名失败：${errMsg(e)}` }
      }

      // 清单 path 更新（docId 不变，只改 path）——在 journal 保护段内：
      // 此步失败/崩溃 → pending 悬置（文件已在新路径），下次进门 healthCheck 自动对齐清单
      // 拆两段各给真实后果文案——原一刀切「清单更新失败」会把
      // appendSettled（journal 落账）失败也标成清单问题，误导诊断方向（清单可能已更新成功）
      try {
        await ctx.updateManifestPath(docId, newPath)
      } catch (e) {
        return {
          ok: false,
          code: 'WRITE_ERROR',
          reason: `文件已移动到新路径，但清单更新失败（下次打开本书时自动对齐）：${errMsg(e)}`,
        }
      }
      try {
        // 内容未变，settled 复用移动前单读派生的指纹（不再整读 newSafe 全文）
        await appendSettled(journalPath, opId, baseRev ?? computeRevision(newSafe))
      } catch (e) {
        return {
          ok: false,
          code: 'WRITE_ERROR',
          reason: `文件已移动到新路径，但 journal settled 落账失败（pending 悬置，恢复链下次进门收口）：${errMsg(e)}`,
        }
      }
      invalidateTreeIndex(ctx.bookRoot, true)
      return { ok: true, docId, path: newPath }
    },
  })
}
