/**
 * 定稿确认（去 git 版本系统版本）。
 *
 * 作者在 app 里编辑正文/设定文件 → 保存（内容 ≠ 定稿基线 → revision 态）
 * → 点「定稿」→ 写定稿版本（工作区/.版本/，pinned 永久保留）+ manifest 更新 finalizedRevision
 * → 当前指纹 == 基线 → 派生回 final。
 *
 * 不再依赖 git：不 add/commit，纯内容指纹 + 账本。幂等：当前指纹 == 已记录基线 → skipped。
 *
 * R30-5（三十轮）锁序统一：全仓锁序定为「save 锁 → 布线锁 → 清单锁」。定稿对布线
 * 正文章在进入清单锁**之前**先预取全部目标布线文件的同名锁（取不到 → LEAD_WRITE_ERROR
 * fail-closed，与原回写失败语义一致）——消除旧序「持清单锁内再取布线锁」与保存链
 * （save 锁 → 布线锁 → 清单锁）构成的 ABBA 交叉等待对（旧靠 5s/2×5s 超时兜底不死锁，
 * 双侧注释各自宣称「单向无环」但未覆盖交叉对）。履历回写拆「持锁核心 + 自取锁包装」
 * 两层（lead-finalize.ts）：定稿持锁路径只调核心，不在同进程内嵌套再取同名锁。
 *
 * R30-6（三十轮）：锁等待异步化。finalizeRevisionAsync 为异步孪生（布线预取锁与清单
 * 锁等待用 setTimeout 轮询原语，事件循环不阻塞，供服务进程调用链用）；finalizeRevision
 * 同步孪生保留原签名与同步等待（Atomics 微睡）——存量调用方（studio API / 批量定稿）
 * 契约不变，两孪生共享同一持锁核心与锁序，语义逐位对齐。
 */
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { readChapter } from '../format/chapters.js'
import { readManifest, readManifestStrict, writeManifest, withManifestLock, withManifestLockAsync } from './manifest.js'
import { invalidateTreeIndex } from './tree.js'
import { computeRevision } from './revision.js'
import { writeVersion, VERSIONS_DIR_NAME } from './version.js'
import { countWords } from '../format/words.js'
import { splitFrontMatter } from '../format/frontmatter.js'
import { safeManifestPath, safeDocId } from '../fs/safe-path.js'
import { hashBytes } from '../fs/hash.js'
import {
  applyLeadUpdatesLocked,
  acquireLeadFileLocksSync,
  acquireLeadFileLocksAsync,
  resolveLeadUpdateTargets,
  type LeadUpdateTargets,
} from './lead-finalize.js'
import { outlineDeclarationForChapter } from '../check/outline-leads.js'
import { readChapterUpdatesForChapterChecked, leadEvidenceMatchesBody } from '../check/lead-updates.js'
import { leadClosureItems } from '../check/leads.js'
import { readDraft } from '../format/draft.js'
import { log } from '../log/index.js'

export type FinalizeOutcome =
  | { ok: true; status: 'final'; skipped: boolean }
  | { ok: false; code: 'NOT_FOUND' | 'WRITE_ERROR' | 'LEAD_GATE' | 'LEAD_WRITE_ERROR'; error: string }

/**
 * R30-5（三十轮）：定稿前置解析（锁外、无锁纯读）——清单解析/路径校验/指纹基线/
 * 章号标题/布线判定与回写目标。原实现章号与布线判定在清单锁内算，现移到锁外：
 * 这些是纯磁盘读，不依赖清单并发态；锁内一致性由 Z-14/R72-5 的锁内重指纹兜底，
 * 布线目标一致性由「持锁核心内逐文件锁内重读」兜底（见 lead-finalize.ts 核心注释）。
 */
interface FinalizePrepared {
  bookRoot: string
  docId: string
  manifestPath: string
  relPath: string
  absPath: string
  /** 锁外指纹基线（computeRevision 对存在文件恒返回非 null 指纹）。 */
  currentRev: `sha256:${string}`
  chapterNo: number
  title: string
  isWiredChapter: boolean
  /** 布线正文章的回写目标（非布线章 / 无待回写条目时 updates 为空，不预取锁）。 */
  wiringTargets: LeadUpdateTargets | null
}

/** R30-5：布线预取锁失败（fail-closed）的定稿信封——与回写失败的 LEAD_WRITE_ERROR 同通道。 */
function leadLockFailError(targets: LeadUpdateTargets, detail: string): string {
  const files = [...targets.files.values()].map((f) => `${f}.lock`).join('、')
  return `账本履历回写布线锁预取失败（${files || '无目标文件'}；定稿未生效，修复后可重试）：${detail}`
}

/**
 * 锁外前置段：全部失败形态为 NOT_FOUND（原语义逐位保留）。
 * P1-BE-1：computeRevision 对不存在文件抛 ENOENT，需前置校验（batch-finalize 单条缺失不应中断整批）。
 */
function prepareFinalize(bookRoot: string, docId: string): FinalizePrepared | Extract<FinalizeOutcome, { ok: false }> {
  // R70-19（十八轮）：入口 safeDocId fail-loud——writeVersion 对非法 id 是 warn+null
  // 不抛，若不拦会在「未写定稿版本」的情况下落 finalizedRevision 并返回 ok:true
  //（清单被篡改插入非法 id 条目时的纵深缺口；executeSave/doMoveOrRename/doTrash 同款）
  if (!safeDocId(docId)) return { ok: false, code: 'NOT_FOUND', error: '文档 ID 非法' }
  // docId → relPath（清单解析；未登记返回 NOT_FOUND）
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const relPath = lookupRelPath(docId, manifestPath)
  if (!relPath) return { ok: false, code: 'NOT_FOUND', error: '未在文档清单中找到该文档' }

  // 路径校验（防 manifest 篡改穿越——与其他 4 个 API 端点一致）
  const absPath = safeManifestPath(bookRoot, relPath)
  if (!absPath) return { ok: false, code: 'NOT_FOUND', error: '文档路径非法' }

  // 当前内容指纹
  if (!existsSync(absPath)) return { ok: false, code: 'NOT_FOUND', error: '文档不存在' }
  const currentRev = computeRevision(absPath)

  // 章号 + 标题（版本元信息用）；解析失败从文件名推断（R30-5：移到锁外，纯读）
  const rd = readChapter(absPath)
  const chapterNo = rd.ok ? rd.chapter.章号 : inferChapterFromName(relPath)
  const title = rd.ok && rd.chapter.标题 ? rd.chapter.标题 : basenameNoExt(relPath)

  // 定稿正文章（长篇有布线）判定——ee-P1-3 防吃书闸与 ee-P1-4 账本回写共用同一条件，
  // 保持两处口径一致（任一单独漂移都会让闸门拦了不回写、或回写了不拦）。
  const isChapter = relPath.startsWith('写作/正文/')
  const hasWiring = existsSync(join(bookRoot, '布线'))
  const isWiredChapter = isChapter && hasWiring && chapterNo > 0

  // R30-5：布线回写目标解析（锁外）——定稿在进清单锁前按它预取布线锁
  const wiringTargets = isWiredChapter ? resolveLeadUpdateTargets(bookRoot, chapterNo) : null

  return { bookRoot, docId, manifestPath, relPath, absPath, currentRev, chapterNo, title, isWiredChapter, wiringTargets }
}

/**
 * X-5 清单 RMW 持锁核心（R30-5 起由两个孪生入口共享）：读基线 → 幂等判定 → 写版本/
 * 回写账本 → 写基线。前置契约：调用方已持清单锁；isWiredChapter 时已**先**持全部布线
 * 预取锁（统一锁序「布线锁 → 清单锁」）。持锁段内的 return 即定稿结果。
 */
function finalizeLockedCore(pre: FinalizePrepared): FinalizeOutcome {
  const { bookRoot, docId, manifestPath, relPath, absPath, chapterNo, title, isWiredChapter, wiringTargets } = pre
  // Z-14（第五十八轮）：锁内重算指纹——锁外计算到锁内读取之间他进程（GUI 保存/CLI
  // 批量定稿）可落盘新内容，pinned 版本与基线指纹会记到不同稿。重算不一致时以新指纹
  // 重走下方幂等/闸门判定（旧指纹作废；跨进程窗口极窄，重算后仍以锁内一致快照为准）。
  // R72-5（二十轮 B-10）：锁内一次读——原「此处 computeRevision 读盘 + 步骤①再
  // readFileSync」两次读盘之间他进程仍可插入落盘，pinned 版本内容与基线指纹错拍；
  // 现指纹与版本内容同源于同一次读取（hashBytes 单源 fs/hash.ts）。读取失败按外部
  // 已移除处理，沿用锁外基线（原 X-5 兜底语义），后续写版本若也失败走 WRITE_ERROR。
  const fileBytes = existsSync(absPath) ? readFileSync(absPath) : null
  const rev = fileBytes ? (hashBytes(fileBytes) as `sha256:${string}`) : pre.currentRev
  // 幂等：当前指纹 == 已记录的定稿基线 → skipped，不重复写版本。
  // R27-40（二十七轮）：strict 读——瞬态读失败原会当「无基线」走补建分支，空表
  // 整文件重写吞掉全书登记；现上抛由本信封收口为 WRITE_ERROR（拒定稿保旧清单）。
  let manifest
  try {
    manifest = readManifestStrict(manifestPath)
  } catch (e) {
    return { ok: false, code: 'WRITE_ERROR', error: `定稿前清单读取失败（已拒绝，防空表重写）：${e instanceof Error ? e.message : String(e)}` }
  }
  const entry = manifest.entries.get(docId)
  if (entry?.finalizedRevision === rev) {
    return { ok: true, status: 'final', skipped: true }
  }

  // ee-P1-3：手工/批量定稿防吃书闸——正文章跑账本「两端闭合」两条结构红
  // （声明了没做 / 做了没声明），非空则阻断定稿。此前红项只在 AI 自愈循环（retry）拦截，
  // 作者手工定稿主路径失守（README「账实不符阻断定稿」失效）。只拦这两条：复读/文风/
  // 禁词等其余红项不拦定稿，定稿前树红点/机检面板仍可见。
  if (isWiredChapter) {
    const blockers = finalGateBlockers(bookRoot, absPath, chapterNo)
    if (blockers.length > 0) {
      return { ok: false, code: 'LEAD_GATE', error: blockers.join('\n') }
    }
  }

  // ① 写定稿版本（永久保留，pinned）。R72-5（二十轮 B-10）：内容取自锁内同源读取的
  // 字节，不再二次 readFileSync；文件在锁内消失（fileBytes null）时此前会在 computeRevision
  // 处抛裸错，现收编进契约。
  try {
    if (!fileBytes) return { ok: false, code: 'WRITE_ERROR', error: '定稿失败：文件在定稿过程中被移除' }
    const content = fileBytes.toString('utf-8')
    const versionsDir = join(bookRoot, '工作区', VERSIONS_DIR_NAME)
    const split = splitFrontMatter(content)
    // R27-41（二十七轮）：pinned 版本直存原始字节（writeVersion R26-52 已支持
    // Buffer）——utf-8 文本化会把 GBK 等非 UTF-8 源变 U+FFFD 失真副本，而这是全
    // 系统唯一 pinned 永久留底；content 仍供 words 统计（近似口径，注释在案）。
    writeVersion(versionsDir, docId, fileBytes, {
      origin: 'finalize',
      reason: `定稿 ch:${String(chapterNo).padStart(4, '0')} ${title}`,
      baseRevision: rev,
      words: countWords(split ? split.body : content),
      pinned: true,
    })
  } catch (e) {
    return { ok: false, code: 'WRITE_ERROR', error: `写版本失败：${e instanceof Error ? e.message : String(e)}` }
  }

  // W-P1-3 右端闭环（决策 2）：定稿正文章（长篇有布线）→ 已确认的 账本推进.md 回写布线履历并清空。
  // 非正文文档（设定/章纲等）/ 无布线的独立短篇 → 跳过（账本推进仅对长篇正文有意义）。
  // ee-P1-4：回写提前到 manifest 基线落盘**之前**，失败 → LEAD_WRITE_ERROR（manifest 不落盘，
  // 重试必然重新回写）。这推翻了 X-P2-5 的 best-effort 决策：叠加上面「指纹==基线 → skipped」
  // 幂等短路，原顺序下回写中途失败（如磁盘满）后基线已落盘、账本推进.md 未清空，下次定稿
  // skipped 永不再回写——账本履历**永久丢失**。skipped 造成的永久丢失 > 误导作者重试的害处
  // （X-P2-5 当初担心的「实际已生效，报失败误导重试」不再成立：现在报失败后重试是真实
  // 需要的，且重试安全——版本追加无害，回写自带同章号+动词+证据去重）。
  // R30-5：布线锁已由入口在进清单锁**之前**预取（wiringTargets）——此处只调持锁核心，
  // 不得再经自取锁包装（同进程嵌套取同名锁会等到超时失败）。
  if (isWiredChapter && wiringTargets) {
    try {
      applyLeadUpdatesLocked(chapterNo, wiringTargets)
    } catch (e) {
      return {
        ok: false,
        code: 'LEAD_WRITE_ERROR',
        error: `账本履历回写失败（定稿未生效，修复后可重试）：${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  // ② manifest 更新定稿基线（entry 无则补建——旧书未登记首次定稿时落盘）。
  // ee-P1-4：必须等账本回写成功后才写——基线在位即触发上方 skipped 幂等，先写基线会把
  // 回写失败变成「下次定稿永不再回写」的永久丢失窗口。
  if (!entry) {
    manifest.entries.set(docId, { id: docId, nodeType: 'document', path: relPath, parentId: null })
  }
  const next = manifest.entries.get(docId)!
  next.finalizedRevision = rev
  next.finalizedAt = new Date().toISOString()
  // R72-5（二十轮 B-2）：writeManifest 失败此前裸抛穿透 FinalizeOutcome 契约，批量定稿
  // 循环被单条中断丢汇总。收编进契约（WRITE_ERROR）；版本已写、基线未落 → 重试重写版本
  // （追加无害）后落基线，不产生不一致态。
  try {
    writeManifest(manifestPath, manifest)
  } catch (e) {
    return { ok: false, code: 'WRITE_ERROR', error: `定稿基线落盘失败：${e instanceof Error ? e.message : String(e)}` }
  }

  invalidateTreeIndex(bookRoot)
  return { ok: true, status: 'final', skipped: false }
}

/**
 * 定稿确认：写 pinned 定稿版本 + manifest 更新定稿基线 → 回 final。
 *
 * 同步孪生（签名与既有调用方契约不变）：锁等待为同步原语（Atomics 微睡）。
 * 服务进程调用链请改用 finalizeRevisionAsync（R30-6，等待期不阻塞事件循环）。
 *
 * @param bookRoot 书仓库根
 * @param docId 目标文档 id
 * @returns 是否成功 + 结果状态。
 */
export function finalizeRevision(bookRoot: string, docId: string): FinalizeOutcome {
  const pre = prepareFinalize(bookRoot, docId)
  if ('ok' in pre) return pre
  // R30-5：统一锁序「布线锁 → 清单锁」——布线正文章先预取全部目标布线锁，再进清单锁；
  // 任一预取失败 → LEAD_WRITE_ERROR fail-closed（定稿未生效：版本未写、清单未动，可重试）。
  if (pre.isWiredChapter && pre.wiringTargets && pre.wiringTargets.updates.length > 0) {
    const locks = acquireLeadFileLocksSync(pre.wiringTargets.files.values())
    if (locks === null) {
      return { ok: false, code: 'LEAD_WRITE_ERROR', error: leadLockFailError(pre.wiringTargets, '布线文件锁等待超时（另一进程正在回写/保存该布线文件）') }
    }
    try {
      return withManifestLock(pre.manifestPath, () => finalizeLockedCore(pre))
    } finally {
      for (const r of locks) r()
    }
  }
  return withManifestLock(pre.manifestPath, () => finalizeLockedCore(pre))
}

/**
 * R30-6（三十轮）：finalizeRevision 的异步孪生——布线预取锁与清单锁等待全部走
 * setTimeout 轮询原语（事件循环不阻塞），语义（超时档/fail-closed/锁序）与同步孪生
 * 逐位对齐。错误文案中同步/异步原语同档（5s），仅等待机制不同。
 */
export async function finalizeRevisionAsync(bookRoot: string, docId: string): Promise<FinalizeOutcome> {
  const pre = prepareFinalize(bookRoot, docId)
  if ('ok' in pre) return pre
  if (pre.isWiredChapter && pre.wiringTargets && pre.wiringTargets.updates.length > 0) {
    const locks = await acquireLeadFileLocksAsync(pre.wiringTargets.files.values())
    if (locks === null) {
      return { ok: false, code: 'LEAD_WRITE_ERROR', error: leadLockFailError(pre.wiringTargets, '布线文件锁等待超时（另一进程正在回写/保存该布线文件）') }
    }
    try {
      return await withManifestLockAsync(pre.manifestPath, () => finalizeLockedCore(pre))
    } finally {
      for (const r of locks) r()
    }
  }
  return withManifestLockAsync(pre.manifestPath, () => finalizeLockedCore(pre))
}

/**
 * ee-P1-3 定稿防吃书闸：算出阻断定稿的账本结构红（人话 message 列表，空 = 放行）。
 *
 * 数据源与 checkWithDb（src/check/run.ts）完全同口径，不自创：
 * - 声明侧：outlineDeclarationForChapter（细纲 fm「推进」三态；R69-2：细纲自带章号 ≠
 *   被检章 = 声明未知 → 跳过闭合比对——批量连写 batchSize≥2 时细纲恒@首章、其余章推进
 *   落归档，此前「未知」被当「未声明」，归档章实际推进全部误报 lead-done-not-declared
 *   并经本闸 LEAD_GATE 硬阻断批量定稿）
 * - 兑现侧：readChapterUpdatesForChapter 过滤 leadEvidenceMatchesBody（证据核心须在 fm 剥离
 *   后的当前正文命中才算兑现），比对逻辑复用 check 层导出的 leadClosureItems
 *   （单一真相源，防与机检口径漂移）。
 *   ff-P1-1：兑现侧与回写（applyLeadUpdates）共用同一读取源（主文件属于本章时 +
 *   本章归档）——此前闸只读主文件，批量连写下归档章推进绕过闸直接落履历。
 *
 * 整体 try/catch fail-open：闸门自身故障（读盘异常等）返回 [] 不阻断定稿——闸门是防
 * 吃书增强而非定稿的必要条件，与 X-P2-5 降级哲学一致（观测/防护层故障不应锁死作者）。
 */
function finalGateBlockers(bookRoot: string, absPath: string, chapterNo: number): string[] {
  try {
    const declaration = outlineDeclarationForChapter(bookRoot, chapterNo)
    if (!declaration.known) return [] // 声明未知：闭合比对不可判定，跳过（R69-2）
    const draft = readDraft(absPath)
    if (!draft.ok) return []
    // R32-3（三十二轮）：兑现侧改 Checked 读——主文件/归档「存在但读失败」时 updates
    // 不完整，按其比对会把「清单未知」当「已声明未兑现」产 lead-declared-not-done 假红
    // 硬阻断定稿（R31-3 只闭合了机检侧）。unreadable → 跳过闭合比对 + warn 留痕
    // （闸门降级放行，对齐 X-P2-5/R29-8 口径——观测得到但不锁死作者）。
    //（win 线 R33-5 同因独立修复，合并取本侧 unreadable 形状 + warn 留痕。）
    const fulfilled = readChapterUpdatesForChapterChecked(bookRoot, chapterNo)
    if (fulfilled.unreadable) {
      log.warn('finalize', `第${chapterNo}章 防吃书闸兑现侧清单不可读（主文件/归档在位但读失败），闭合比对降级跳过`)
      return []
    }
    const actual = fulfilled.updates
      .filter((u) => leadEvidenceMatchesBody(draft.body, u.证据))
      .map((u) => u.leadId)
    return leadClosureItems(declaration.leads, actual, chapterNo).map((i) => i.message)
  } catch (e) {
    // R29-8（二十九轮）：fail-open 留痕——闸门自身故障此前静默返回 [] 放行，「闸门
    // 降级」零痕迹（与 R29-8② state.ts 布线缺失健康项同族：静默失效面至少可观测）。
    // 只加观测，不改变放行语义（闸门是防吃书增强而非定稿必要条件，X-P2-5 哲学不变）。
    log.warn(
      'finalize',
      `第${chapterNo}章 防吃书闸执行失败，闸门降级放行：${e instanceof Error ? e.message : String(e)}`,
    )
    return []
  }
}

/** 清单 docId → relPath（容错：缺文件/未登记 → null）。 */
function lookupRelPath(docId: string, manifestPath: string): string | null {
  try {
    const m = readManifest(manifestPath)
    return m.entries.get(docId)?.path ?? null
  } catch {
    return null
  }
}

/** 从文件名推断章号（`0001-开篇.md` → 1；解析失败 → 0）。 */
function inferChapterFromName(relPath: string): number {
  const base = relPath.split('/').pop() ?? ''
  const m = base.match(/^(\d+)-/)
  return m ? Number(m[1]) : 0
}

function basenameNoExt(relPath: string): string {
  const base = relPath.split('/').pop() ?? ''
  return base.replace(/\.md$/, '')
}
