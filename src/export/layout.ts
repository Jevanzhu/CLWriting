/**
 * 导出备目录与写出两阶段：目录准备 / 旧产物清位（prepareExportLayout）、
 * 全本流式与分章逐章落盘（writeExportProducts / writeSplitUnit）。
 *
 * 不变量：归档不删、归档不下即改序号兜底名（不覆写作者手改稿）；全本发布裁定
 * （零成功章不落盘）；失败信封回填已落盘产物清单。
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile, atomicWriteStream, renameWithRetry } from '../fs/atomic.js'
import { chapterFilePrefix } from '../format/words.js'
import { isMdFileName, isTxtFileName } from '../format/filename.js'
import { errMsg } from '../log/index.js'
import { exportPayload, purifyBody } from './purify.js'
import {
  OLD_EXPORT_DIR,
  TXT_EXPORT_SUBDIR,
  archiveOldExport,
  nextFreeName,
  relPosixIn,
  sanitizeFileName,
  FILENAME_MAX_BYTES,
} from './naming.js'
import { readUnitBody } from './collect.js'
import type { ExportOutput, ExportPlan, ExportRun, StageResult } from './types.js'
/** 阶段四·备目录：导出目录创建 + 同名旧产物归档清位 + 分章目录归档重建。
 *  顺序不变量（勿调换）：①目录先建——其后全部产物写在其下；②清旧只归档「其它名字」
 *  的过期产物——当前同名的保护留给写出段「先归档再覆盖 / 归档不下改序号」单点
 * 清旧失败不阻断导出（清的是别名产物，留在原位不构成覆写）；
 * ③分章目录归档失败 → 本次产物写「分章-N」新目录（不覆写原目录——目录被
 *  编辑器/Word 占用正是 win 上整目录 rename 最常失败的场景）。
 * 导出供分段直测（生产唯一调用点在 exportBook 阶段四）。 */
export function prepareExportLayout(args: {
  bookRoot: string
  bookTitle: string
  doMerged: boolean
  doSplit: boolean
  warnings: string[]
  /** 输出形态（缺省 md——分段直测的既有调用点零改动） */
  output?: ExportOutput
}): StageResult<Omit<ExportPlan, 'filtered'>> {
  const { bookRoot, bookTitle, doMerged, doSplit, warnings } = args
  const output = args.output ?? 'md'
  // txt 面落 导出/纯文本/ 独立子目录（归档子目录随之为 纯文本/.旧版/）——
  // 与 md 面的清旧/覆盖保护按目录作用域隔断（见 TXT_EXPORT_SUBDIR 注）
  const exportDir =
    output === 'txt' ? join(bookRoot, '工作区', '导出', TXT_EXPORT_SUBDIR) : join(bookRoot, '工作区', '导出')
  // 目录创建位于主信封 try 之外——工作区只读/EROFS/EACCES 时裸异常
  // 上抛，worker 形态变 500 且丢 chapterCount/warnings，违背确立的
  // {ok:false} 信封契约。mkdir 结果被后续清旧/分章目录准备依赖、无法并入主 try，
  // 本地收编同款错误信封（口径同 short 分支收编写法）。
  try {
    mkdirSync(exportDir, { recursive: true })
  } catch (e) {
    return { ok: false, error: `导出写入失败：${errMsg(e)}` }
  }

  let mergedFileName = ''
  if (doMerged) {
    const ext = output === 'txt' ? '.txt' : '.md'
    mergedFileName = `全本-${sanitizeFileName(bookTitle, FILENAME_MAX_BYTES - Buffer.byteLength('全本-') - Buffer.byteLength(ext))}${ext}`
    // 书改名/字节截断形变后，旧「全本-旧书名.md」残留在导出目录里会让作者
    // 拿错稿——同前缀其余文件视为过期产物归档清位（归档不删，清旧失败不阻断导出）
    // readdirSync 清点同在主信封 try 之外——导出目录被并发删/
    // EACCES 时裸异常上抛破坏 {ok:false} 信封契约（同上方 mkdir 收编口径）。
    // 清旧循环里归档失败是安全的——清的是「其它名字」的过期产物，归档
    // 不下就留在原位，本次写的是另一个名字，不存在覆写；故此处不比照写入点做兜底改名。
    // 扫描面已按输出分流（md = 导出/ 根、txt = 导出/纯文本/），扩展名判定同口径
    // 跟随（isMdFileName / isTxtFileName）——形状异形的杂项文件不动。
    const isProductExt = output === 'txt' ? isTxtFileName : isMdFileName
    try {
      for (const old of readdirSync(exportDir)) {
        // .md 判定改 isMdFileName（大小写不敏感）——.MD 家族漏网点
        if (old.startsWith('全本-') && isProductExt(old) && old !== mergedFileName) {
          archiveOldExport(exportDir, old, warnings)
        }
      }
    } catch (e) {
      return { ok: false, error: `导出写入失败：${errMsg(e)}` }
    }
  }

  // 分章导出目录准备：旧目录先归档再重建（原 rmSync 整删与「归档
  //    不删」哲学相悖——作者手改过 分章/ 内单章稿后再导出即被静默销毁不可挽回；
  //    对齐 archiveOldExport：整目录 rename 进 导出/.旧版/分章[-N]/，归档失败保留
  //    原目录记 warnings 继续导（宁可残留不可销毁））
  // 归档失败分支不再允许新产物同名覆写原目录——目录被占用
  //    （编辑器/Word 开着导出稿）正是 win 上 rename 整目录搬迁最常失败的场景，随后
  //    writeSplit 的同名 atomicWriteFile 会把作者手改稿替换掉且无 .旧版 副本，与
  //    「已保留原位」警告自相矛盾。改：本次产物写入带序号新目录（分章-N）。
  let splitTargetDirName = '分章'
  if (doSplit) {
    const splitDir = join(exportDir, '分章')
    if (existsSync(splitDir)) {
      try {
        const archiveDir = join(exportDir, OLD_EXPORT_DIR)
        mkdirSync(archiveDir, { recursive: true })
        let dstName = '分章'
        let n = 2
        while (existsSync(join(archiveDir, dstName))) dstName = `分章-${n++}`
        // 分章目录归档同族收编 renameWithRetry（win 瞬时锁退避；确定性错误仍走
        // catch 改写带序号新目录「不覆写原目录」语义不变）
        renameWithRetry(splitDir, join(archiveDir, dstName))
      } catch {
        let n = 2
        while (existsSync(join(exportDir, `分章-${n}`))) n++
        splitTargetDirName = `分章-${n}`
        warnings.push(
          `分章目录归档失败（原目录已保留原位，请手动移入 ${OLD_EXPORT_DIR}/）；本次产物改写入 ${splitTargetDirName}/，不覆写原目录`,
        )
      }
    }
    // 连带（代理范围外上报、主评审收口）：分章目录重建 mkdir 同在主信封
    // try 之外（EROFS/EACCES 裸抛破坏 {ok:false} 信封契约）——与上方母本目录/清旧
    // 两处同族同款本地收编。
    try {
      mkdirSync(join(exportDir, splitTargetDirName), { recursive: true })
    } catch (e) {
      return { ok: false, error: `导出写入失败：${errMsg(e)}` }
    }
  }
  return { ok: true, value: { exportDir, output, mergedFileName, splitTargetDirName, doMerged, doSplit } }
}
/** 阶段五内部·分章单章写出：前缀/文件名净化 + 撞名序号判定 + 规范化写 + 产物登记。
 * 单章写入失败带上章上下文重抛——外层收编为 {ok:false}。
 * 本文件私有（生产唯一调用点 = writeExportProducts）。 */
function writeSplitUnit(
  run: ExportRun,
  plan: ExportPlan,
  splitUsed: Set<string>,
  unit: { num: number; title: string; path: string; displayNum?: number },
  body: string,
): void {
  try {
    // （阶段 24）：分章前缀走 displayNum（分流）+ chapterFilePrefix 单源收编
    //（原内联 padStart(4) 未走写侧单源家族）；文案章号引用维持本地章号。
    const display = unit.displayNum ?? unit.num
    const prefix = chapterFilePrefix(display, 'chapter')
    const ext = plan.output === 'txt' ? '.txt' : '.md'
    const baseName = sanitizeFileName(
      unit.title,
      FILENAME_MAX_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(ext),
    )
    // 同章号+同标题（手工复制备份 / 网盘同步副本「xxx 2.md」形态）撞名——
    // 直写同路径会幂等替换，chapterCount 与 files 却计两次，两章只留一章且无提示；
    // 追加序号后缀保双份并计入 warnings，作者可手动取舍。
    const fileName = `${prefix}${baseName}${ext}`
    // 平台：导出产物规范形写（正文源自库内章，CRLF 存量可携 \r 残尾——归一后
    // 两台机器的导出产物字节一致，作者侧 diff/比对有基准）
    const payloadOf = (title: string, body: string): string => exportPayload(plan.output, title, body)
    // 撞名/非撞名两分支重复的 atomicWriteFile+files.push
    // 合并单点写——名单先算定（finalName），写盘与登记只写一份
    let finalName = fileName
    if (splitUsed.has(fileName)) {
      let n = 2
      while (splitUsed.has(`${prefix}${baseName}-${n}${ext}`)) n++
      finalName = `${prefix}${baseName}-${n}${ext}`
      run.warnings.push(
        `分章 ${unit.num}「${unit.title}」与已导出产物撞名，已另存为 ${finalName}——若为同名重复章请手动核对/清理`,
      )
    }
    splitUsed.add(finalName)
    atomicWriteFile(join(plan.exportDir, plan.splitTargetDirName, finalName), payloadOf(unit.title, body))
    run.files.push(`${relPosixIn(run.bookRoot, plan.exportDir)}/${plan.splitTargetDirName}/${finalName}`)
  } catch (e) {
    // 分章单章写入失败带上章上下文重抛——外层收编为 {ok:false}
    throw new Error(`分章 ${unit.num}「${unit.title}」写入失败：${errMsg(e)}`)
  }
}

/** 阶段五·写出：全本（单遍流式，内存闸审计不再物化 purified 全书
 *  数组与 `join('\n\n---\n\n')` 整书大串，逐章净化即写即弃，峰值降为单章级，产物字节
 *  与物化实现逐一恒等）+ 分章逐章原子写。
 * 写入期异常（分章经 merged 流式回调或 split 循环抛出、
 *  atomicWriteStream 自身失败）不再裸穿透 exportBook——库形态信封契约是 {ok:false}，
 *  裸异常在服务端直接打到 500 兜底面且丢 chapterCount/warnings 上下文。收编时全本
 *  尚在 tmp 未发布（atomicWriteStream 自清理），分章半产物由下次导出整目录归档清位。
 *  （§四.9）：错误信封回填已落盘产物——原 `files: []`
 *  清零让 merged+split 双模式中途失败时盘上已落的部分产物无列表（调用方/作者无从
 *  核对半产物）。回填累积的 files：split 项 push 紧随成功 atomicWriteFile 之后 ⟺
 *  已落盘；merged 名仅在 atomicWriteStream 完整发布后 unshift（中途失败 tmp 自
 *  清理、目标不在盘），不虚列。
 * 导出供分段直测（生产唯一调用点在 exportBook 阶段五）。 */
export function writeExportProducts(run: ExportRun, plan: ExportPlan): StageResult<null> {
  // splitUsed 原声明在 writeSplit 闭包定义之后（仅靠「闭包实际调用
  // 晚于声明执行」侥幸不触发 TDZ）——结构脆弱：后续在声明执行前新增任何 writeSplit
  // 调用即 ReferenceError；声明保持在产出闭包之前，消除对调用时序的隐式依赖（行为不变）。
  const splitUsed = new Set<string>() // 分章产物文件名占用集（撞名序号判定）
  const { warnings, files } = run
  try {
    if (plan.doMerged) {
      let first = true
      // 同名产物先归档再覆盖——上方清旧循环只归档「其它名字」，
      // 当前同名被跳过后被 atomicWriteStream 直接覆盖；作者手改过的导出稿
      // （分章侧已定性「不可挽回」）就此静默销毁。
      // 归档失败不覆写——照常 rename 覆盖会让 warnings 的「已保留原位，请手动移入
      // .旧版/」与事实相反（作者按提示去找的稿已被销毁）。改：归档未成 → 本次产物写
      // 序号兜底名，与分章目录「分章-N 不覆写原目录」同口径。
      if (
        existsSync(join(plan.exportDir, plan.mergedFileName)) &&
        !archiveOldExport(plan.exportDir, plan.mergedFileName, warnings)
      ) {
        const fallback = nextFreeName(plan.exportDir, plan.mergedFileName)
        warnings.push(`本次产物改写入 ${fallback}，不覆写原产物`)
        plan.mergedFileName = fallback
      }
      atomicWriteStream(
        join(plan.exportDir, plan.mergedFileName),
        (append) => {
          for (const unit of plan.filtered) {
            const raw = readUnitBody(run.bookRoot, unit, warnings)
            if (raw === null) continue // 读取失败/空正文：警告已记，跳过（不出分隔符）
            const body = purifyBody(raw)
            // 章间分隔：md 用水平线（渲染分段），txt 用空段（`---` 在纯文本里
            // 是字面噪音，且会与作者自用的场景分隔线混淆；正文内的 `---` 原样保留）
            if (!first) append(plan.output === 'txt' ? '\n\n\n' : '\n\n---\n\n')
            first = false
            // 平台：全本产物规范形写（同分章/投稿视图收口）
            append(exportPayload(plan.output, unit.title, body))
            if (plan.doSplit) writeSplitUnit(run, plan, splitUsed, unit, body)
            run.writtenCount++
            run.writtenNums.add(unit.num)
          }
        },
        // 发布裁定——零成功章时全本文件连空壳都不落盘（原口径
        // 空 `全本-*.md` 照常 rename 落盘后才在下方按失败收口，盘上残留空产物）
        { publish: () => run.writtenCount > 0 },
      )
      if (run.writtenCount > 0) files.unshift(`${relPosixIn(run.bookRoot, plan.exportDir)}/${plan.mergedFileName}`)
    } else if (plan.doSplit) {
      for (const unit of plan.filtered) {
        const raw = readUnitBody(run.bookRoot, unit, warnings)
        if (raw === null) continue
        writeSplitUnit(run, plan, splitUsed, unit, purifyBody(raw))
        run.writtenCount++
        run.writtenNums.add(unit.num)
      }
    }
    return { ok: true, value: null }
  } catch (e) {
    return { ok: false, error: `导出写入失败：${errMsg(e)}`, files }
  }
}
