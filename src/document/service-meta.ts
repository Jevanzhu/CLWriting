/**
 * DocumentService meta 族（章节/文档元数据 PATCH 写回链）—— 自 service.ts 缝 C 拆出。
 *
 * （⑤④收官补批——缝C meta 族参数化，作者拍板「不想挂账」）：
 * service.ts（2110 行）meta 族拆分，五波批次唯一「非纯移动」缝——允许行为等价的
 * 代码形状改写，逐处账本见下。本文件承载 meta 族四件：
 *   - updateChapterMetaLocked：章节元数据 PATCH 锁内本体（单读判据 → 非 UTF-8 闸 →
 *     fm 文本级补丁 → 覆盖前留底 → journal pending/settled 配对 → 原子写回 →
 *     piece/chapter 文件名联动 rename）；
 *   - rollbackMetaOnRenameFail：rename 失败回写旧 fm；
 *   - syncRenamePieceList：短篇正文改名后章纲同名跟随（/）；
 *   - updateDocMetaLocked：通用 fm PATCH 锁内本体（卷纲/总纲，不联动文件名）。
 * 原 private 方法降为模块级自由函数、首参为显式依赖；起该首参由
 * 「MetaHost 结构化宿主（DocumentService 实例）」改为 `ctx: DocContext`——共享设施
 * 不再从类实例上摸（原形态要求 service.ts 剥 private + 标 @internal 且与宿主双向耦合，
 * 见源码质量评审）；move/rename 本体亦迁 service-move.ts，本文件单向引入。
 * 仅跨模块消费的两个入口函数加 export，模块私有件（rollbackMetaOnRenameFail/
 * syncRenamePieceList 仅本文件消费）保持非导出。注释全部原样随迁；锁序（save → 布线 →
 * 清单/journal）、revision 链、journal 落账、错误信封逐字节保持。
 *
 * 非纯移动差异账本（全部为行为等价的形状改写，剥前缀/缩进后逻辑行零增删）：
 * 1) 依赖参数化：四函数首参 `ctx: DocContext`；函数体内 `ctx.X`（X ∈ bookRoot/
 *    journalDir/snapshotsDir/manifestPath/lookupPathByDocIdAdoptAsync/resolveSafePath/
 *    withSaveLocks/snapshotPolicy）逐处改写 `ctx.X`，`doMoveOrRename(ctx, ...)` 改直调
 *    service-move.ts 的 doMoveOrRename(ctx, ...)；journal 路径改经 ctx.journalPathOf
 *    单源。不再需要宿主接口与剥 private 面（MetaHost 接口随本批删除）。
 * 2) 兄弟调用降级：updateChapterMetaLocked 内 `this.syncRenamePieceList(...)` 与
 *    `this.rollbackMetaOnRenameFail(...)`（3 个调用点）为同模块自由函数直调、首参补传 ctx。
 * 3) 调用点接线：公开入口 updateChapterMeta/updateDocMeta 原位保持于 service.ts 类体
 *   （chainDocMetaOp 串行链不变），回调内改为 `updateXxxMetaLocked(this.ctx, docId, meta)`。
 *
 * per-实例状态口径：metaOpChains Map（同 docId meta 串行链）现由 ctx
 * （DocContext.chainDocMetaOp）持有——身份仍是「每服务实例一份」，严禁提为模块级单例
 * （多服务实例会跨实例串态）。本文件模块顶层零求值常量、零可变模块态。
 *
 * 依赖方向：本文件对 service.ts 仅 `import type { MoveResult }`（verbatimModuleSyntax
 * 下编译期擦除，运行时零回边、无环）；运行时依赖只有 doc-context.ts（共享设施）与
 * service-move.ts（rename 委托），单向引入。其余出边（fs/format/log 与 document
 * 叶子件）与原 service.ts 同集，只出不进。
 */

import { basename, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { atomicWriteFile, linkOrRenameExclusive, renameWithRetry, rmWithRetry } from '../fs/atomic.js'
import { errMsg, log } from '../log/index.js'
import { computeRevisionBytes } from './revision.js'
import { layoutOf } from './layout.js'
import { appendAborted, appendPending, appendSettled } from './journal.js'
import { writeVersion } from './version.js'
import { readManifestStrict, type Manifest } from './manifest.js'
import { invalidateTreeIndex, invalidateTreeIndexForContent } from './tree.js'
import { readFile as readDoc, parseFlat, patchFlatFm, splitFrontMatter, joinFrontMatter, bodyOf, isFmWritableValue } from '../format/frontmatter.js'
import { countWords, chapterFilePrefix } from '../format/words.js'
import { sanitizeChapterTitle, chapterNoFromName } from '../format/filename.js'
import { isUtf8Bytes, NON_UTF8_REJECT } from './service-guards.js'
import { isPieceBody, isSamePhysicalFile, normalizeChapterNo, chapterTitleSegment } from './service-helpers.js'
import { doMoveOrRename } from './service-move.js'
import type { DocContext } from './doc-context.js'
// 依赖方向纪律：对公共入口模块仅 import type（编译期擦除，运行时零回边、无环）
import type { MoveResult } from './service.js'

/** 原 MetaHost 结构化宿主接口随「剥 private + @internal」面一并删除——
 *  共享设施改由 DocContext 显式提供（见 doc-context.ts），本文件不再对 service.ts 提宿主面要求。 */

export async function updateChapterMetaLocked(ctx: DocContext, docId: string, meta: { 标题?: string; 章号?: number }): Promise<MoveResult> {
  // lookup strict 读失败收口 WRITE_ERROR（未执行修改、可重试），不裸穿
  let path: string | null
  try {
    path = await ctx.lookupPathByDocIdAdoptAsync(docId)
  } catch (e) {
    return { ok: false, code: 'WRITE_ERROR', reason: `元数据修改前清单查询失败（未执行修改，可重试）：${errMsg(e)}` }
  }
  if (!path) return { ok: false, code: 'NOT_FOUND', reason: `文档 ${docId} 未在清单登记` }
  const abs = ctx.resolveSafePath(path)
  if (!abs) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
  // 能力校验补齐（与 save 同防线）——定稿/摘要 等只读区
  // 此前可经 PATCH op=meta 改写其 fm
  if (!layoutOf(path).capabilities.write) {
    return { ok: false, code: 'CAPABILITY_DENIED', reason: '该文档只读，不可改元数据' }
  }
  // （二十四轮 C 域）：保存协议收口——本路径 read→patch→写回原先全程不持
  // per-doc save 锁，GUI(dev:app) 与 dev:api 双进程同书时：进程 A executeSave 刚落盘
  // 的新正文，会被进程 B 在此路径读到的旧正文以「新 fm + 旧正文」整篇覆盖回去
  //（B 的 read→write 毫秒窗），终态永久不可恢复（本路径又无快照留底）。取与
  // executeSave 同款跨进程保存锁（`<journal>.save.lock`，5s fail-closed，拿不到=
  // 未执行可重试，不降级裸写）。锁覆盖到尾部 doMoveOrRename：其内部嵌套拿
  // manifest/journal 锁，方向与 executeSave 内 maybeUpdateManifest 相同（单向无环）；
  // doMoveOrRename 不取 save 锁。
  // 注释如实化：旧称「executeSave 锁内临界段全同步，JS 单线程
  // 不与本同步方法交错，不会自锁」不实——executeSave 持锁段内有 await 点
  //（appendPending/appendSettled 的 journal 锁等待、maybeUpdateManifest 的清单锁
  // 等待、legacy 收编的清单锁）与多次磁盘写（UTF-8 探测读/快照留底/原子落盘/
  // journal/清单 RMW/字数日记），本方法自身也是异步方法，交错确有可能。不会**死锁**
  // 的真实依据：同进程嵌套获取同一锁表现为轮询等待（cross-process-lock.ts
  // 注，异步形态轮询到超时），executeSave 持锁段常态毫秒级完成且 finally 必释放
  // ——交错的同 docId 获取者（本方法或排队 executeSave）轮询等锁，常态毫秒级拿到，
  // 极端（持锁段超 5s，如杀毒扫描拖慢 IO）fail-closed 返回 WRITE_ERROR 可重试；
  // 同族操作另由 SaveQueue（save）/chainDocMetaOp（meta）按 docId 链串行，同进程
  // 交错面只剩「save ↔ meta」这一跨族 await 窗口，如上受锁轮询兜底。
  const journalPath = ctx.journalPathOf(docId) // 编码口径单源（doc-context）
  // （修复批）：取锁/释放编排单源化至 withSaveLocks
  //（获取抛出收口 / 布线锁 / 锁序 / 异步化机制随迁），
  // 本处保留调用面专属文案与锁档，锁序与失败语义逐位不变。
  return ctx.withSaveLocks<MoveResult>({
    journalPath,
    // 锁档生效值随容器走（per-ctx 组装参数，缺省 = META/WIRING 常量档）
    saveTimeoutMs: ctx.metaSaveLockTimeoutMs,
    onSaveLockThrown: (e) => ({ ok: false, code: 'WRITE_ERROR', reason: `元数据保存锁获取失败（未执行保存，可重试）：${errMsg(e)}` }),
    onSaveLockTimeout: () => ({ ok: false, code: 'WRITE_ERROR', reason: '元数据保存等待超时：另一进程正在保存此文档（5 秒未让出），请重试' }),
    wiring: {
      relPath: path,
      timeoutMs: ctx.wiringSaveLockTimeoutMs,
      onThrown: (e) => ({ ok: false, code: 'WRITE_ERROR', reason: `布线文件锁获取失败（未执行保存，可重试）：${errMsg(e)}` }),
      onTimeout: () => ({ ok: false, code: 'WRITE_ERROR', reason: '元数据保存等待超时：另一进程正在回写此布线文件（5 秒未让出），请重试' }),
    },
    body: async () => {
    // 单次 Buffer 读派生文本与判据（照抄 updateDocMeta 修法）
    // ——原 readDoc（610）与 readFileSync（619）两次独立读盘，两读之间文件被并发替换
    // （他进程改名/移动不持 save 锁）时判据与写回内容错源（微 TOCTOU）；且第二次读
    // 无守卫，ENOENT 裸穿 MoveResult 契约（ee- 同族）。
    let fileBytes: Buffer
    try {
      fileBytes = readFileSync(abs)
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `元数据读取失败：${errMsg(e)}` }
    }
    // readFile(filePath, content) 形参直喂单读文本——fmRaw/body 与 readDoc(abs) 同源派生
    const r = readDoc(abs, fileBytes.toString('utf-8'))
    if (!r.ok) return { ok: false, code: 'WRITE_ERROR', reason: `元数据读取失败：${r.error.message}` }
    // 非 UTF-8（GBK 等）防线——utf-8 读入产生 U+FFFD 替换符，元数据写回会把
    // 乱码正文原子覆盖回原文件，原始字节永久丢失（本路径无快照留底，用户没碰正文却
    // 被「盲改」）。检出即拒绝，先转码再改。
    // 低级项：判据从「body 含 U+FFFD」升级为「盘上字节非合法 UTF-8」（fatal
    // 解码探测，与 save 主路径同口径）——原判据对 fm 区（GBK 标题等）是盲区，且 fm
    // 往返依赖 parse/stringify 非无损；盘上合法 UTF-8 时读出的 FFFD 是用户自粘内容，
    // body 原样透传不构成损坏。
    if (!isUtf8Bytes(fileBytes)) return NON_UTF8_REJECT
    const map = parseFlat(r.fmRaw)
    if (meta.标题 !== undefined) map.set('标题', meta.标题)
    // piece-body / chapter 统一写「章号」字段
    // （-：原注「避免同方法内两次磁盘读」为旧双调用口径——
    // 现行本方法仅此一处判定，结果存 isPiece 供尾部 rename 分流，随本批如实化。）
    const isPiece = isPieceBody(path, ctx.bookRoot)
    if (meta.章号 !== undefined) map.set('章号', meta.章号)
    // 写侧改文本级补丁——parseFlat→stringifyFlat 整体重排会把手写
    // 嵌套段/块标量变体压平（同 updateDocMeta 的境界体系问题），补丁只换目标键行
    const fmUpdates: Record<string, unknown> = {}
    if (meta.标题 !== undefined) fmUpdates['标题'] = meta.标题
    if (meta.章号 !== undefined) fmUpdates['章号'] = meta.章号
    const patched = patchFlatFm(r.fmRaw, fmUpdates)
    if (!patched.ok) return { ok: false, code: 'BAD_INPUT', reason: patched.reason }
    // 覆盖前留底（对齐 files.ts PUT 覆盖留底同款，fail-open
    // 不阻断）——meta PATCH 的「读旧→patch→整文件写回」此前零快照，写入失败之外的
    // 误改（如 patch 错键行）无底可回；本路径已有非 UTF-8 拒写防线（上方），此处
    // utf-8 读入必然无损。快照失败（磁盘满/权限）只 log.warn，元数据修改照常落盘
    // （留底是兜底不是闸，与 lead-update-draft 取舍一致）。
    try {
      // 同源派生对齐 ——本函数上方已把两次读盘收敛
      // 为单次 fileBytes 读且已过 isUtf8Bytes 判据（合法 UTF-8 时 Buffer 直存与
      // utf-8 往返字节一致），快照却又第二次 readFileSync 再读盘：两读之间文件
      // 被并发替换（他进程结构性操作不持 save 锁的毫秒窗）时「覆盖前留底」存档的不是
      // 被覆盖内容（错档非丢失），且多一次全文读。改直喂 fileBytes（writeVersion 形参
      // string | Buffer，Buffer 透传字节档）。
      // 补产 words——本路径手工编辑频率低，一次 toString 全文
      // 物化可接受，免版本面板对 meta-overwrite 版本的全量读+重数兜底（读侧
      // listVersionEntries 以 meta.words 命中为快路径）。
      writeVersion(
        ctx.snapshotsDir,
        docId,
        fileBytes,
        { origin: 'meta-overwrite', reason: '章节元数据修改前留底（R26-51）', words: countWords(bodyOf(fileBytes.toString('utf-8'))) },
        { policy: ctx.snapshotPolicy(), force: true },
      )
    } catch (e) {
      log.warn('document', `章节元数据修改前快照失败（fail-open 继续写入）：${errMsg(e)}`)
    }
    // （c 修复批）：meta PATCH 写回补 journal pending/settled
    // 配对（保存协议统一；此前双路径写回零 pending——原子写兜底只保「不半截」，崩溃窗
    // 在健康面零痕迹，作者对「fm 是否改成了」无从对账）。选取「真补」而非豁免登记的
    // 依据：写回全文（新 fm + 原正文）在写前已知，appendPending 原语直接可用；崩溃后
    // 的 save 类复核按「盘上指纹 vs baseRevision」确定性收口（已落盘 ⇒ 自动
    // settled；未落盘 ⇒ 报红），与 executeSave 语义逐位同构。
    // baseRevision 取写回前盘上指纹（fileBytes 单读派生，同源口径）。
    // updateDocMetaLocked 同款。
    // appendPending 全文实参随形参收窄删除（起 pending 只记元数据；
    // 当时的「pending 快照即写回全文」已不成立，复核判据一律走 baseRevision）。
    const metaFullText = joinFrontMatter(patched.text, r.body)
    const metaBaseRev = computeRevisionBytes(fileBytes)
    let metaOpId: string
    try {
      metaOpId = await appendPending(journalPath, docId, metaBaseRev)
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `journal 追加失败，元数据修改未执行：${errMsg(e)}` }
    }
    try {
      // 元数据写入走原子写（-6A：防 writeFileSync 半截损坏不可恢复）
      // 平台规范化批：BOM 补回移除（规范形无 BOM），行尾/BOM 由 joinFrontMatter
      // 整体规范化（原文带 BOM/CRLF 的外部编辑产物经此写自愈归一）
      atomicWriteFile(abs, metaFullText, { fsync: true })
    } catch (e) {
      try {
        await appendAborted(journalPath, metaOpId, `元数据写入失败：${errMsg(e)}`)
      } catch {
        // journal 留痕失败吞掉（best-effort）：必须保住 {ok:false} 契约
      }
      return { ok: false, code: 'WRITE_ERROR', reason: `元数据写入失败：${errMsg(e)}` }
    }
    // settled best-effort（口径：写已落盘，落账失败不误报——悬置 pending 由
    // 进门 save 类复核自动消解）
    try {
      await appendSettled(journalPath, metaOpId, computeRevisionBytes(Buffer.from(metaFullText, 'utf-8')))
    } catch (e) {
      log.warn('document', `元数据已写盘但 journal settled 写失败（${docId}，恢复链 R0912-1a 将按 pending 自动消解）：${errMsg(e)}`)
    }
    // meta PATCH 同文件整写——与 executeSave 同款单键失效
    invalidateTreeIndexForContent(ctx.bookRoot, path)
    // 标题三级回落——显式传标题（meta.标题）→ fm 标题 → 现有文件名
    // 标题段（剥章号数字前缀与 .md）。此前章号-only PATCH 且 fm 缺标题时直落「未命名」，
    // 作者手建的 `0001-我的章节.md` 改一次章号就被静默改成 `000N-未命名.md`（用户自选
    // 标题丢失）。「未命名」兜底语义保留给显式传空标题的编辑路径；回落链产物
    // 非空（文件名无标题段时退回旧行为）。
    // -：fm 标题两臂重复求值 hoist——原三元两臂各自
    // String(map.get('标题') ?? '')（map 已在上方 set，两臂同源，求值恒等），
    // 收敛为一次读取。
    // 0914 文件名标题段剥离收编 chapterNoFromName 单源（chapterTitleSegment）
    // ——原窄正则只认 `-` 分隔，`5—标题.md`/`5 标题.md` 的章号前缀剥不净（整名连章号
    // 落标题）；裸章号名（`0001.md`）剥后为空，经下方 sanitize || '未命名' 兜底。
    const fmTitle = String(map.get('标题') ?? '')
    const 标题 = meta.标题 !== undefined ? fmTitle : fmTitle || chapterTitleSegment(basename(path))
    // 清偿批删去原此处 invalidateTreeIndex(bookRoot, true)——与
    // rename 委托链尾 doMoveOrRename 的同参整书失效（本文件 :1526 附近）在同一操作
    // 链上重复，保留链尾一处。分路径核实：rename 路径的结构性失效单源在链尾（成功
    // 由 doMoveOrRename 尾部调用）；不 rename 路径 rel_path 集合不变，上方的
    // invalidateTreeIndexForContent 已失效 indexes/indexSigCache/本章 probe 键，章级
    // 机检行按 (mtime,size) 指纹自失效，无需 structural 整表清空——链中提前清反而把
    // 未变章的有效缓存行连坐清掉（下轮聚合全章重算，纯性能损耗；本路径低频）。
    // 时序上该调用先于 rename，本就防不住「失效后-重建-旧树」竞态，rename 后仍靠
    // 链尾失效兜底，删除无正确性回退面。

    if (isPiece) {
      // 短篇：rename 文件名（章号3位-标题.md）+ 同步章纲同名文件
      const no = normalizeChapterNo(map.get('章号'))
      // 0914 fm 缺章号时的前缀回落收编 chapterNoFromName 单源——
      // 原窄正则 `^(\d+-)` 对 `5—标题.md`/`5 标题.md` 失明（前缀丢落，改名静默剥
      // 章号）。识别走单源；产出保原文件名章号段原文（锚：`1-` 保 `1-`，不做
      // 位宽归一——改名动作只动标题段，作者手定的位宽/分隔形态不在本路径归一；
      // `5—`/`5 ` 整段保留修丢落）。裸数字名无原文段时按单源正典位宽补 `001-`
      //（保章号不丢——旧行为此形态连章号一起剥掉）。
      const nameNo = no ?? chapterNoFromName(basename(path))
      const rawPrefix = nameNo !== null ? (basename(path).match(/^\d+(?:[-—]|\s)/)?.[0] ?? '') : ''
      const numPrefix =
        no !== null
          ? chapterFilePrefix(no, 'piece')
          : nameNo !== null
            ? rawPrefix || chapterFilePrefix(nameNo, 'piece')
            : ''
      // 标题缺失/空白时兜底「未命名」——否则文件名劣化成 `001-.md`
      // 消毒走 sanitizeChapterTitle 单源（控制字符含 \n / Windows
      // 非法字符 :*?"<>| / 码位 60/字节 120 双封顶）——此前仅替换 \\ / 两字符，
      // 「改标题→重命名」路径消毒族口径漂移（同族 draft.ts 新建章、style-entry 已单源）
      const safeTitle = sanitizeChapterTitle(标题) || '未命名'
      const newName = `${numPrefix}${safeTitle}.md`
      if (basename(path) !== newName) {
        // 外层已持本 docId 的 save 锁，传 holdSaveLock:false 防
        // 同进程嵌套同路径锁（重取必超时 fail-closed）
        const result = await doMoveOrRename(ctx, docId, { kind: 'rename', newName }, { holdSaveLock: false })
        if (result.ok) await syncRenamePieceList(ctx, path, newName)
        else rollbackMetaOnRenameFail(ctx, abs, r)
        return result
      }
      return { ok: true, docId, path }
    }

    // 长篇 chapter：文件名按 章号4位-标题.md（消毒同 piece 分支单源口径）
    const no = normalizeChapterNo(map.get('章号'))
    const safeTitle = sanitizeChapterTitle(标题) || '未命名'
    const newName =
      no !== null ? `${chapterFilePrefix(no, 'chapter')}${safeTitle}.md` : basename(path)
    if (basename(path) !== newName) {
      // 外层已持本 docId 的 save 锁，同 piece 分支防嵌套自锁
      const result = await doMoveOrRename(ctx, docId, { kind: 'rename', newName }, { holdSaveLock: false })
      if (!result.ok) rollbackMetaOnRenameFail(ctx, abs, r)
      return result
    }
    return { ok: true, docId, path }
    },
  })
}

/** updateChapterMeta rename 失败回写旧 fm——两步非原子（先原子写 fm
 *  新章号/标题，后 rename 文件名），rename 失败不回写会留「fm 章号≠文件名章号」孤儿态
 *  （仅靠机检 fm-chapter-mismatch 报红兜底，按章号三口径定位会 miss）。按进入本方法时
 *  读入的快照（r.fmRaw + r.body）回写——平台规范化批语义：经 joinFrontMatter 整体规范
 *  （LF 无 BOM；CRLF/BOM 原件回写即归一，非字节原样，恢复语义不变），恢复 fm 与文件名
 *  一致；文件已不在原路径（doMoveOrRename 的「清单更新失败」路径——文件已 rename，
 *  新 fm 与新文件名一致）不回写，回写反而制造错配；回写自身失败维持 mismatch，机检
 *  兜底，不吞 rename 失败原因。 */
function rollbackMetaOnRenameFail(ctx: DocContext, abs: string, original: { fmRaw: string; body: string }): void {
  if (!existsSync(abs)) return
  try {
    // 平台规范化批：BOM 补回移除——joinFrontMatter 整体规范（规范形无 BOM）
    atomicWriteFile(abs, joinFrontMatter(original.fmRaw, original.body), { fsync: true })
    invalidateTreeIndex(ctx.bookRoot, true)
  } catch {
    // 回写失败维持现状：fm-chapter-mismatch 由机检兜底
  }
}

/** 短篇章纲同步重命名（章纲/Old.md → 章纲/New.md）：
 *  正文已 rename，章纲同名文件跟随。章纲不存在时静默跳过（不阻断正文 rename）。
 *  ：章纲已入清单（对其做过任何结构性操作即落）时委托 doMoveOrRename
 *  ——裸 renameSync 既不更新 项目/文档清单.jsonl 也不写 move-pending journal，清单残留
 *  指向旧路径的孤儿条目；tree 按旧 path 匹配 miss → docId 退化为 legacyId(新 path)，
 *  编辑器按 docId 挂的标签页/分析信封/工作区/.版本/<docId>/ 版本历史全断链。委托后
 *  journal + snapshot + 清单 path 更新 + 树索引失效与正文改名同一纪律。未登记（从未
 *  做过结构性操作）时无条目可孤儿，保留无登记回落（linkOrRenameExclusive
 *  独占落位 + 时间戳后缀保双份，失败结构化 warn 不阻断正文 rename）。 */
async function syncRenamePieceList(ctx: DocContext, oldBodyRel: string, newName: string): Promise<void> {
  const oldListRel = `大纲/章纲/${basename(oldBodyRel)}`
  const newListRel = `大纲/章纲/${newName}`
  const oldSafe = ctx.resolveSafePath(oldListRel)
  const newSafe = ctx.resolveSafePath(newListRel)
  if (!oldSafe || !newSafe) return
  if (!existsSync(oldSafe)) return
  if (existsSync(ctx.manifestPath)) {
    // （修复批）：命中读改 strict（strict 化
    // 家族口径——lookupPathByDocIdAdoptAsync 同款，本条为该族漏网成员）。容忍版在瞬态
    // 锁占（win 杀软/索引器/他进程 RMW 的 EACCES/EBUSY/EIO）时返回空清单 → oldListRel
    // 不命中 → 落入裸 rename 兜底：清单登记仍认领旧路径而被搬走 = 孤儿条目 + 新条目
    // 并存，docJoinKey 失配 docId 退化（同款危害终点）。strict 读失败时登记态未知，
    // **不走裸 rename 兜底、也不阻断正文 rename**（本函数调用序在正文 rename 成功之后
    // ——updateChapterMetaLocked 的 isPiece 分支——上抛会把已成功的改名劣化为失败）：
    // 章纲滞留旧名 + 清单与盘上文件一致（世界自洽），warn 留痕交作者重试或机检收口。
    let listedStrict: Manifest
    try {
      listedStrict = readManifestStrict(ctx.manifestPath)
    } catch (e) {
      log.warn('document', `章纲清单读失败（strict），章纲同步重命名跳过（${oldListRel} 滞留旧名，登记与盘上文件保持一致）：${errMsg(e)}`)
      return
    }
    const hit = [...listedStrict.entries].find(([, e]) => e.path === oldListRel)
    if (hit) {
      const r = await doMoveOrRename(ctx, hit[0], { kind: 'rename', newName })
      if (r.ok) return
      // 失败（含「文件已移、清单更新失败」半程态）不阻断正文 rename：前者落回裸
      // rename 兜底配对，后者 healthCheck 按悬置 pending 收口（语义）
    }
  }
  try {
    mkdirSync(dirname(newSafe), { recursive: true })
    // fallback 落位改 linkOrRenameExclusive——原裸 renameSync 对
    // 已存在目标静默替换（的 existsSync 预检只挡慢路径，预检与 rename 之间的
    // 并发落位窄窗仍在，无留底毁同名章纲）；link 独占探测无窗口，'exists'（预检漏网
    // 的并发占用）沿用时间戳后缀保双份（L- 同款）。落位成功后删源（link
    // 落位时源为同 inode 硬链接；linkOrRenameExclusive 内部降级 rename 落位时源已
    // 搬走，rmSync force 为 no-op）——删源失败先回收新位再抛（doMoveOrRename
    // 同款范式），失败收口走外层 warn。
    let dst = newSafe
    let placed = linkOrRenameExclusive(oldSafe, dst)
    if (placed === 'exists') {
      // （win 适配修复批）：大小写不敏感 FS
      //（win NTFS/mac APFS）上「仅大小写变化」的章纲改名——目标位与源是同一物理
      // 文件，linkOrRenameExclusive 恒 EEXIST，原实现误落 `-旧稿-<时间戳>` 双份
      // 分支（内容无损但需手工改名）。对齐 doMoveOrRename 主路径同判：dev+ino
      // 相等 → 原位 renameWithRetry 落大小写变体（win MoveFileEx/mac APFS 均支持；
      // 落位后源已搬走，下方删源 rmWithRetry 对已不存在路径为无害 no-op）。
      if (isSamePhysicalFile(oldSafe, dst)) {
        renameWithRetry(oldSafe, dst)
        placed = 'created'
      } else {
        dst = newSafe.replace(/\.md$/, `-旧稿-${Date.now()}.md`)
        placed = linkOrRenameExclusive(oldSafe, dst)
      }
    }
    if (placed === 'exists') {
      // 目标名与后缀名均被持续占用：不覆盖、不上抛（正文已改名成功），warn 留痕
      log.warn('document', `章纲同步重命名未落位（目标 ${newListRel} 被持续占用，正文已改名，章纲滞留旧名 ${oldListRel}）`)
      return
    }
    try {
      // 删源收编 rmWithRetry（fs/atomic.ts ，trash.ts :287
      // 先例）——win 杀毒/索引器瞬时锁（EPERM/EBUSY）下裸 rmSync 直败会让章纲同步
      // 无谓滞留旧名；退避后仍失败照走既有「回收新位再抛」回滚链（语义不变）
      rmWithRetry(oldSafe)
    } catch (rmErr) {
      try {
        // （全库代码审）：回滚删新位收编 rmWithRetry——win
        // 瞬时锁（EPERM/EBUSY）下裸 rmSync 直败会把「可回收的回滚」劣化成孤儿残留；
        // 退避后仍失败照走 catch 留痕（孤儿副本硬链接同数据，语义不变）
        rmWithRetry(dst)
      } catch {
        /* 新位残留孤儿副本：硬链接同数据，无丢失，重试前需手工清理 */
      }
      throw rmErr
    }
    invalidateTreeIndex(ctx.bookRoot, true)
  } catch (e) {
    // / （win 平台专项）双线同旨合并：失败不再静默吞
    // ——本函数只在 doMoveOrRename 成功后调用，按既有约定不阻断/不回滚正文 rename
    //（改 Promise 不上抛），但零留痕吞掉会让「章纲滞留旧名」不可见（win 上章纲被
    // 编辑器占用 EBUSY/EPERM 的典型形态，正文/章纲文件名无痕分叉）；改结构化 warn
    // 留痕（对齐 doCreate 登记失败 / doTrash 的 warn 口径）。
    log.warn('document', `章纲同步重命名失败（${oldListRel} → ${newListRel}，正文已改名，章纲滞留旧名）：${errMsg(e)}`)
  }
}

export async function updateDocMetaLocked(ctx: DocContext, docId: string, meta: Record<string, unknown>): Promise<MoveResult> {
  // 0918修复批（B010）：fm 值类型闸——对象/null 等非标量此前经 stringifyValue
  // 的 String(val) 兜底落成 "[object Object]"/"null" 伪值写坏 fm；入口 fail-loud 拒收
  //（BAD_INPUT 走本 API 既有错误信封，未执行任何修改）。undefined 与既有 fmUpdates
  // 组装同口径跳过（= 不改该键）。
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue
    if (!isFmWritableValue(v)) {
      return {
        ok: false,
        code: 'BAD_INPUT',
        reason: `元数据字段「${k}」的值类型不支持（仅接受字符串/有限数字/布尔/标量数组），已拒绝写入`,
      }
    }
  }
  // lookup strict 读失败收口 WRITE_ERROR（未执行修改、可重试），不裸穿
  let path: string | null
  try {
    path = await ctx.lookupPathByDocIdAdoptAsync(docId)
  } catch (e) {
    return { ok: false, code: 'WRITE_ERROR', reason: `元数据修改前清单查询失败（未执行修改，可重试）：${errMsg(e)}` }
  }
  if (!path) return { ok: false, code: 'NOT_FOUND', reason: `文档 ${docId} 未在清单登记` }
  const abs = ctx.resolveSafePath(path)
  if (!abs) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
  // 同 updateChapterMeta——能力校验补齐
  if (!layoutOf(path).capabilities.write) {
    return { ok: false, code: 'CAPABILITY_DENIED', reason: '该文档只读，不可改元数据' }
  }
  // （二十四轮 C 域）：保存协议收口——同 updateChapterMeta，本路径 read→patch→
  // 写回原先不持 per-doc save 锁，双进程同书时他进程 executeSave 的新正文会被本路径
  // 的「旧正文+新 fm」覆盖回去（跨进程丢正文窗）。取 executeSave 同款跨进程保存锁
  //（5s fail-closed）；锁内无嵌套锁获取（纯 read/patch/write），与 executeSave 的
  // save→journal/manifest 单向序无环。
  const journalPath = ctx.journalPathOf(docId) // 编码口径单源（doc-context）
  // （修复批）：取锁/释放编排单源化至 withSaveLocks
  //（/ （布线文件含 大纲/关系线/，与 lead-finalize 回写互斥，fail-closed
  // 先释放 save 锁防泄漏）/ 锁序 / 异步化机制随迁），本处保留调用面
  // 专属文案与锁档，锁序与失败语义逐位不变。
  return ctx.withSaveLocks<MoveResult>({
    journalPath,
    // 锁档生效值随容器走（per-ctx 组装参数，缺省 = META/WIRING 常量档）
    saveTimeoutMs: ctx.metaSaveLockTimeoutMs,
    onSaveLockThrown: (e) => ({ ok: false, code: 'WRITE_ERROR', reason: `元数据保存锁获取失败（未执行保存，可重试）：${errMsg(e)}` }),
    onSaveLockTimeout: () => ({ ok: false, code: 'WRITE_ERROR', reason: '元数据保存等待超时：另一进程正在保存此文档（5 秒未让出），请重试' }),
    wiring: {
      relPath: path,
      timeoutMs: ctx.wiringSaveLockTimeoutMs,
      onThrown: (e) => ({ ok: false, code: 'WRITE_ERROR', reason: `布线文件锁获取失败（未执行保存，可重试）：${errMsg(e)}` }),
      onTimeout: () => ({ ok: false, code: 'WRITE_ERROR', reason: '元数据保存等待超时：另一进程正在回写此布线文件（5 秒未让出），请重试' }),
    },
    body: async () => {
    // 两次独立 readFileSync 收敛为单次读（finalize.ts 单读
    // 同源先例）——「utf-8 读文本」与「字节级 UTF-8 判据」原先各读一次盘，两读之间文件
    // 被并发替换（他进程保存/改名）时判据与写回内容错源（微 TOCTOU）。Buffer 一读，
    // 判据与写回同源派生。
    let raw: string
    // buf 提升作用域——写前指纹（baseRevision）单读派生用（下方 pending）
    let fileBytes: Buffer | undefined
    try {
      const buf = readFileSync(abs)
      // 非 UTF-8 防线（引入；DA-1·升级字节级判据，同 updateChapterMeta 口径）——
      // 原字符串 FFFD 判据有 fm 区 GBK 盲区：部分 GBK 双字节对恰好构成合法 UTF-8，读入
      // 无 U+FFFD 即放行，fm 往返把乱码原子覆盖回原文件，原始字节永久丢失
      if (!isUtf8Bytes(buf)) return NON_UTF8_REJECT
      fileBytes = buf
      raw = buf.toString('utf-8')
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `元数据读取失败：${errMsg(e)}` }
    }
    // 容错：裸 md 无 fm（旧书卷纲/总纲）→ 整体当 body，新建 fm
    const split = splitFrontMatter(raw)
    const body = split ? split.body : raw
    // 写侧改文本级补丁——parseFlat→stringifyFlat 整体重排会摧毁
    // fm 内唯一嵌套结构（设定/境界体系.md 的 体系:/- 名称:/序列: 被压平成伪平铺键
    // 且同名键互相覆盖，回写后 parseRealmSystems 永远解析失败 → 成长线机检静默失明，
    // 多体系时仅最后一组内容存活）。补丁只换目标键行，其余行逐字节保留；目标键自带
    // 嵌套子行时 fail-loud 拒绝。
    const fmUpdates: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(meta)) {
      if (v !== undefined) fmUpdates[k] = v
    }
    const patched = patchFlatFm(split ? split.fmRaw : '', fmUpdates)
    if (!patched.ok) return { ok: false, code: 'BAD_INPUT', reason: patched.reason }
    // 覆盖前留底（同 updateChapterMeta—— 同款，fail-open）。
    // raw 是上方单次 Buffer 读出的原文件文本（同源），字节级忠实。
    // raw 已在手，顺带产 words（免版本面板全量读兜底，meta PATCH 低频路径）。
    try {
      writeVersion(
        ctx.snapshotsDir,
        docId,
        raw,
        { origin: 'meta-overwrite', reason: '元数据修改前留底（R26-51）', words: countWords(bodyOf(raw)) },
        { policy: ctx.snapshotPolicy(), force: true },
      )
    } catch (e) {
      log.warn('document', `元数据修改前快照失败（fail-open 继续写入）：${errMsg(e)}`)
    }
    // meta PATCH 写回补 journal pending/settled 配对（同 updateChapterMetaLocked
    // 头注——选取「真补」依据与确定性收口联动；baseRevision 取写回前盘上
    // 指纹，fileBytes 单读派生）
    const metaFullText = joinFrontMatter(patched.text, body)
    const metaBaseRev = computeRevisionBytes(fileBytes!)
    let metaOpId: string
    try {
      metaOpId = await appendPending(journalPath, docId, metaBaseRev)
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `journal 追加失败，元数据修改未执行：${errMsg(e)}` }
    }
    try {
      // 平台规范化批：BOM 补回移除（规范形无 BOM）——raw 若带 BOM（外部编辑
      // 产物）由 joinFrontMatter 整体规范化剥除
      atomicWriteFile(abs, metaFullText, { fsync: true })
    } catch (e) {
      try {
        await appendAborted(journalPath, metaOpId, `元数据写入失败：${errMsg(e)}`)
      } catch {
        // journal 留痕失败吞掉（best-effort）：必须保住 {ok:false} 契约
      }
      return { ok: false, code: 'WRITE_ERROR', reason: `元数据写入失败：${errMsg(e)}` }
    }
    // settled best-effort（口径：写已落盘，落账失败不误报——悬置 pending 由
    // 进门 save 类复核自动消解）
    try {
      await appendSettled(journalPath, metaOpId, computeRevisionBytes(Buffer.from(metaFullText, 'utf-8')))
    } catch (e) {
      log.warn('document', `元数据已写盘但 journal settled 写失败（${docId}，恢复链 R0912-1a 将按 pending 自动消解）：${errMsg(e)}`)
    }
    invalidateTreeIndex(ctx.bookRoot, true)
    return { ok: true, docId, path }
    },
  })
}
