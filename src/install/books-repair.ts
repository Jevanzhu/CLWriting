/**
 * books.jsonl 自愈（#32 第 6 节，文件即真相 + 不报错拒绝）—— 依据 M5 #32。
 *
 * R0916-5e（2026-09-16，⑤④产品拆分波1）：自 install/books.ts 缝 A 纯移动拆出——
 * RepairResult / repairBooks / isDirConfirmedMissing / repairBooksLocked /
 * scanBookCandidates / detectBookName / detectBookKind / detectBookCreatedAt
 * 原样随迁（注释随代码走，零行为变化）；books.ts 逐名 re-export 桥接，既有消费方
 * import 面不动。登记读写/锁原语（readBooksStrict/writeBooks/tryBooksLock）与
 * books.jsonl 残核留在 books.ts。
 *
 * R0916-7-P3-3（2026-09-16 评审修复批）：登记读写/锁原语与 KIND_DIRS 改引
 * books-store.ts（原引 books.ts）——本模块自此不回引 books.ts，
 * books ↔ books-repair 环解开。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { readBookConfig } from '../format/yaml.js'
import { log } from '../log/index.js'
import { KIND_DIRS, readBooksStrict, tryBooksLock, writeBooks, type BookEntry } from './books-store.js'
import { isBookRepo } from './books-resolve.js'

// ── 自愈（#32 第 6 节，文件即真相 + 不报错拒绝）──

export interface RepairResult {
  /** 重建的登记条目 */
  rebuilt: BookEntry[]
  /** 原登记中 path 在磁盘找不到的书（可能被移动/改名） */
  missing: BookEntry[]
  /** 已按 book.yaml 书名重新关联的移动/改名书目录 */
  relinked: { name: string; from: string; to: string }[]
  /** 是否有变动（重建了或发现缺失） */
  changed: boolean
  /** M-8（第八轮）：books.jsonl 读失败时跳过本轮自愈（防「降级空表 × 扫盘整写」清掉
   *  非标准深度登记）——此时其余字段为空、changed=false，调用方应告警而非报告自愈；
   *  R63-2（十一轮）：登记锁超时同款跳过（另一进程持锁改写中，扫盘整写会与之交错） */
  skipped?: 'read-failed' | 'lock-timeout'
  /** R35-28（三十五轮）：幽灵条目（登记在册、目录确认缺失且无法重关联）的可操作修复
   *  提示——自愈只报告不清除（数据安全优先），作者需按提示人工处理；missing 为空时
   *  不带该键。 */
  missingHint?: string
  /** R35-28：显式清除（opts.purgeConfirmedMissing=true）时移除的幽灵登记条目——
   *  仅含「目录确认不存在（ENOENT）」者；瞬态不可读（网络盘离线等 EACCES/EIO）保留。 */
  purged?: BookEntry[]
}

/**
 * 自愈 books.jsonl（#32 第 6 节）。
 * - 缺失/损坏 → 扫描工作目录直接子目录 + 长篇/短篇 子目录（有 book.yaml）→ 重建登记
 * - 已有登记：检查 path 是否在磁盘存在，不存在的标 missing（提示重关联）
 *
 * 真源是磁盘上的书仓库本身；books.jsonl 是「可从扫描重建的派生登记」（类比 .cache）。
 * R35-28（三十五轮）：missing 只报告不清除（幽灵登记处理提示见 missingHint）；要清除
 * 必须显式传 opts.purgeConfirmedMissing（默认关），且仅清「目录确认不存在（ENOENT）」
 * 的条目——瞬态不可读（网络盘离线等 EACCES/EIO）不误清，逐条留日志。
 */
export function repairBooks(
  workDir: string,
  opts?: { purgeConfirmedMissing?: boolean },
): RepairResult {
  // R63-2：读→扫→写整段进跨进程锁；超时跳过本轮（幂等，下次启动重试）
  const release = tryBooksLock(workDir)
  if (!release) {
    return { rebuilt: [], missing: [], relinked: [], changed: false, skipped: 'lock-timeout' }
  }
  try {
    return repairBooksLocked(workDir, opts?.purgeConfirmedMissing ?? false)
  } finally {
    release()
  }
}

/** R35-28：目录「确认不存在」（stat ENOENT）才可显式清除——EACCES/EIO 等瞬态不可读
 *  （网络盘离线、权限故障等）不得误判为已删（existsSync 对一切错误都返 false，不够用）。 */
function isDirConfirmedMissing(abs: string): boolean {
  try {
    statSync(abs)
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/** repairBooks 的持锁主体（R63-2 拆出——锁获取/超时降级在 repairBooks 收口）。 */
function repairBooksLocked(workDir: string, purgeConfirmedMissing: boolean): RepairResult {
  // M-8（第八轮）：读失败（EACCES 等）跳过本轮自愈——DA-3（第七轮）只收口了
  // append/remove/rename 三个写点，本函数自称「兜底」却用降级空表起建：EACCES 挡
  // readFileSync 不挡 atomicWriteFile 的 tmp+rename，扫盘整写会立即落盘；而
  // scanBookCandidates 只扫顶层 + 长篇/短篇 二级，登记允许任意无 .. 相对路径——
  // 非标准深度的书会被静默清出登记。读失败时留给下次启动或人工修复。
  const existing = readBooksStrict(workDir)
  if (existing === null) {
    return { rebuilt: [], missing: [], relinked: [], changed: false, skipped: 'read-failed' }
  }
  const rebuilt: BookEntry[] = existing.map((b) => ({ ...b }))
  const relinked: { name: string; from: string; to: string }[] = []
  let updated = false

  // 扫描旧平铺书仓库 + 新分组书仓库（只到二级，避免误纳书内子目录）
  const scanned: BookEntry[] = []
  const entries = scanBookCandidates(workDir)

  for (const relPath of entries) {
    const dir = join(workDir, relPath)
    if (!isBookRepo(dir)) continue
    // F6（复审-0914-优化修复批）：每书一次 readBookConfig——此前 detectBookName 与
    // detectBookKind 各整读+整解析同一文件（2× IO + 2× 解析）；读结果传参两 detect
    // 0918二轮修复批（G103）：book.yaml 读失败（EACCES 等瞬态锁定/权限，解析失败
    // 同路）跳过该书本轮对账——此前 detectBookKind 对 !ok 回落 'long'、detectBookName
    // 回落目录名，杀软/同步盘短暂锁住 book.yaml 的那次启动会把 name/kind 改写成回落
    // 值（下轮翻回，books.jsonl mtime 随抖动）。对齐同函数 isDirConfirmedMissing 的
    // ENOENT-only 瞬态纪律：读失败时登记保留原值、不重关联、不新登记（新发现的书
    // 无法定名定 kind，留待下轮），只对解析成功的结果做对账；目录确认缺失的
    // missing/purge/relink 判定不受影响（该面在下方独立运行）。
    const cfgRead = readBookConfig(join(dir, 'book.yaml'))
    if (!cfgRead.ok) {
      log.warn('books', `扫盘读取「${relPath}」的 book.yaml 失败（${cfgRead.error.message}），跳过该书本轮登记对账（登记保留原值，下次启动重试）`)
      continue
    }
    const bookName = detectBookName(cfgRead, basename(relPath))
    const kind = detectBookKind(cfgRead)
    const createdAt = detectBookCreatedAt(dir)

    const existingPathIndex = rebuilt.findIndex((b) => b.path === relPath)
    if (existingPathIndex >= 0) {
      const entry = rebuilt[existingPathIndex]!
      // R44-6（四十四轮）：path 命中改名分支补重名检查——本分支以 book.yaml title
      // 直接覆写登记名，撞上 rebuilt 中另一条目同名时会落成同名双登记（resolveBook
      // 首匹配遮蔽其一、removeBookEntry 按名过滤连删两条）；R74-10 同款跳过留痕：
      // 原条目整体保留（kind/created_at 也不半更新——部分更新无法表达「名不可改」的
      // 拒绝语义），作者按日志手动消歧
      if (entry.name !== bookName && rebuilt.some((b) => b !== entry && b.name === bookName)) {
        log.warn('books', `扫盘发现「${relPath}」的 book.yaml 书名「${bookName}」与已登记的另一本书同名，跳过改名、保留原登记名「${entry.name}」——请手动确认两处书名哪个是要保留的`)
        continue
      }
      const nextEntry = {
        ...entry,
        name: bookName,
        kind,
        ...(entry.created_at || !createdAt ? {} : { created_at: createdAt }),
      }
      if (entry.name !== nextEntry.name || entry.kind !== nextEntry.kind || entry.created_at !== nextEntry.created_at) {
        rebuilt[existingPathIndex] = nextEntry
        updated = true
      }
      continue
    }

      const existingIndex = rebuilt.findIndex((b) => b.name === bookName)
      if (existingIndex >= 0) {
        const entry = rebuilt[existingIndex]!
        const oldPath = entry.path
        // P3-13（四轮重评）：重关联判定改 isDirConfirmedMissing（stat ENOENT-only）——
        // 原 !existsSync 把 EACCES 等一切 stat 失败（existsSync 恒返 false）误当
        // 「旧目录确不存在」走 relink，与 R35-28 幽灵清除同口径：瞬态不可读不重关联，
        // 登记保留（落下方 R74-10 同名书跳过留痕分支）
        if (oldPath !== relPath && isDirConfirmedMissing(join(workDir, oldPath))) {
        rebuilt[existingIndex] = {
          ...entry,
          path: relPath,
          kind,
          ...(entry.created_at || !createdAt ? {} : { created_at: createdAt }),
        }
        relinked.push({ name: bookName, from: oldPath, to: relPath })
      } else if (oldPath !== relPath) {
        // R74-10（七十四轮批 D）：同名书跳过留痕——原路径仍存在（两处同名书仓库并存）
        // 时静默 continue，书架对第二处失明且无任何痕迹可查；去重语义不变（仍不重复
        // 登记），仅补 warn 让作者可从日志发现「多出来的同名书目录」自行处理
        log.warn('books', `扫盘发现同名书「${bookName}」在 ${relPath}（登记路径 ${oldPath} 仍存在），跳过不重复登记——请手动确认两处书目录哪个是要保留的`)
      }
      continue
    }

    // G201（0918三轮修复批）：新发现分支补「本轮已扫」同名判重——上方两道防线
    // （R44-6 改名分支 / R74-10 重关联分支）都只查 rebuilt（已登记集），同一轮循环
    // 先前迭代 push 进 scanned 的同名条目对此处不可见（scanned 循环外才并入）：
    // 两本均未登记的同名书（典型 = 手工复制书目录做备份，book.yaml title 随拷贝
    // 不变）会双双入账 → resolveBook 首匹配遮蔽其一、removeBookEntry 按名过滤连删
    // 两条（删一书另一张同名卡登记也被清，第二本成无登记幽灵），且后续 repair 两
    // 条 path 都在盘上走 path 命中分支永不判重（不可自愈）。判重命中按 R74-10 同款
    // 口径 warn 跳过留痕，交作者手动消歧。
    if (scanned.some((s) => s.name === bookName)) {
      log.warn('books', `扫盘发现同名书「${bookName}」在 ${relPath}（本轮已发现另一处同名书目录），跳过不重复登记——请手动确认两处书目录哪个是要保留的`)
      continue
    }

    scanned.push({
      name: bookName,
      path: relPath,
      kind,
      ...(createdAt ? { created_at: createdAt } : {}),
    })
  }

  rebuilt.push(...scanned)

  // 只剩无法重关联的缺失登记进入 missing；已重关联的用 relinked 报告。
  let missing = rebuilt.filter((b) => !existsSync(join(workDir, b.path)))
  // R35-28（三十五轮）：显式清除幽灵登记（默认关，见 repairBooks 头注）——仅清 ENOENT
  // 确认缺失者，瞬态不可读保留登记；逐条留痕供审计。
  const purged: BookEntry[] = []
  if (purgeConfirmedMissing && missing.length > 0) {
    const transient: BookEntry[] = []
    for (const b of missing) {
      if (isDirConfirmedMissing(join(workDir, b.path))) {
        purged.push(b)
        log.warn('books', `自愈清除幽灵登记「${b.name}」（${b.path} 目录确认不存在；显式清除参数开启）`)
      } else {
        transient.push(b)
      }
    }
    if (purged.length > 0) {
      const purgedSet = new Set(purged)
      for (let i = rebuilt.length - 1; i >= 0; i--) {
        if (purgedSet.has(rebuilt[i]!)) rebuilt.splice(i, 1)
      }
      missing = transient
    }
  }
  // R48-60（四十八轮）：missing 不再计入 changed——幽灵条目自愈不自动清除（R35-28），
  // 仅 missing>0 时 rebuilt 与盘上内容相同，计入 changed 只会每次启动整写相同
  // books.jsonl（mtime 无谓抖动）；作者提示面（hint）不受影响
  const changed = updated || scanned.length > 0 || relinked.length > 0 || purged.length > 0

  if (changed) {
    writeBooks(workDir, rebuilt)
  }

  // R35-28：幽灵条目的可操作提示（missing 非空才带）——自愈不自动清除（避免把「暂时
  // 读不到」误判为已删而静默丢书），作者按提示二选一自救。
  const hint =
    missing.length > 0
      ? `缺失登记（目录已不在）的书架卡将标「损坏」且无法经端点删除——可把书目录移回原位（自愈自动重关联），或确认书已不要后手工编辑 .clwriting/books.jsonl 移除对应行`
      : undefined
  return {
    rebuilt,
    missing,
    relinked,
    changed,
    ...(hint ? { missingHint: hint } : {}),
    ...(purged.length > 0 ? { purged } : {}),
  }
}

function scanBookCandidates(workDir: string): string[] {
  let topEntries: string[] = []
  try {
    topEntries = readdirSync(workDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
  } catch {
    return []
  }

  const candidates: string[] = []
  for (const name of topEntries) {
    candidates.push(name)
    if (name !== KIND_DIRS.long && name !== KIND_DIRS.short) continue
    try {
      const nested = readdirSync(join(workDir, name), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => `${name}/${e.name}`)
      candidates.push(...nested)
    } catch {
      // 分组目录读失败时跳过，不影响旧平铺扫描
    }
  }
  return candidates
}

/** 从 book.yaml 读结果取书名；无书名时回落目录名。
 *  F6（复审-0914-优化修复批）：改收 readBookConfig 结果（repairBooks 扫盘每书单次读取）；
 *  原实现外层 `try { readBookConfig... } catch` 为死防御已删——核实 readBookConfig 契约
 *  恒返信封不抛（缺文件/读失败/解析失败三路均 {ok:false, config:默认配置}，见 yaml.ts），
 *  解析失败时 config 为默认空 title → 本就走 fallback 分支，行为不变。 */
function detectBookName(cfgRead: ReturnType<typeof readBookConfig>, fallback: string): string {
  const title = cfgRead.config.book.title.trim()
  return title || fallback
}

/** 从 book.yaml 读结果取 kind（缺省 long）。
 *  Y-20（第五十七轮）：与 detectBookName 同走 readBookConfig 解析口径——此前正则
 *  直读文本，注释行（如 `# kind: short 预留`）会被误判 short 并写回登记。 */
function detectBookKind(cfgRead: ReturnType<typeof readBookConfig>): 'long' | 'short' {
  return cfgRead.ok && cfgRead.config.kind === 'short' ? 'short' : 'long'
}

/** 从 book.yaml 文件 mtime 兜底 created_at（去 git：不再依赖 git log；无则 undefined）。 */
function detectBookCreatedAt(dir: string): string | undefined {
  try {
    const st = statSync(join(dir, 'book.yaml'))
    if (st.isFile()) return new Date(st.mtimeMs).toISOString()
  } catch {
    // 无 book.yaml 忽略
  }
  return undefined
}
