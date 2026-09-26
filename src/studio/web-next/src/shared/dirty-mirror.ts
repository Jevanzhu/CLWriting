/**
 * dirty 正文节流镜像（渲染进程硬崩溃兜底）——自
 * stores/doc.ts 抽出的独立模块。纯 localStorage 逻辑：键格式/节流分档/指纹台账/
 * 书级清扫/复活判读的语义与实现逐位不变（首版 / 清理面补全 /
 * 节流分档+指纹跳写 / baseRev 复活时效门 / 属主精确判定，
 * 沿革注记随实现移位于此），文档缓存态经 deps 参数化注入，doc store 侧改薄委托。
 *
 * 三面：①写侧——dirty/conflict entry 内容节流镜像进 localStorage
 * （Electron 渲染进程同源持久，重启可读，随存镜像时基线 baseRev）；②读侧——open
 * 载入时按 baseRev 时效门判读复活；③清理——保存成功/转 clean/文档删除/切书清扫。
 * 所有 localStorage 访问 try/catch 降级（node 测试环境/隐私模式/quota 爆均退化为
 * 无镜像，autosave 与 .版本 快照仍是主兜底）。
 */

/** 写侧读取的 entry 投影（doc store 缓存条目的镜像相关面）。 */
export interface MirrorEntryView {
  content: string
  dirty: boolean
  conflict: boolean
  /** 镜像时的服务端基线——复活时效门的判据。 */
  baselineRevision: string
}

export interface DirtyMirrorDeps {
  /** 当前文档 entry 投影读取（doc store 传 docs Map 取值）。 */
  getEntry: (docId: string) => MirrorEntryView | undefined
  /** 当前书名（null = 未开书；写侧属主标注用）。 */
  getBook: () => string | null
}

export function createDirtyMirror(deps: DirtyMirrorDeps) {
  /** 镜像 key：`clw:dirty-mirror:<book>:<docId>`（前缀扫描面 = 清前书镜像）。 */
  const MIRROR_KEY_PREFIX = 'clw:dirty-mirror:'
  /** 单条镜像上限（payload 字符数 ≈2MB）——超限跳过并 debug 留痕，防 localStorage quota 爆。 */
  const MIRROR_MAX_CHARS = 2_000_000
  /** 镜像节流基档（ms，trailing）：编辑高峰不逐键写同步 IO，窗口内合并为最后一版。
   *  （评审修复批）：到点是全量 JSON.stringify + localStorage.setItem 的同步
   *  主线程开销，200 万字文档 2s 一拍即数十 ms 级 CPU 峰值——按规模分档拉长（见下），
   *  崩溃窗口拉宽是既有取舍（镜像落后编辑 ≤ 一个节流间隔）的规模延伸：
   *  镜像始终远快于 autosave（默认 30s）主兜底，的取舍与回归测试不动。 */
  const MIRROR_THROTTLE_MS = 2_000
  /** 节流分档阈值（按 entry 内容字符数，调度时刻定格）：>256K 拉到 4s、>1M 拉到 8s。
   *  取舍：档距 2× 对应 stringify+setItem 开销近似线性随规模涨（2s 档数十 ms → 8s 档
   *  摊平为同数量级均摊），再往上该档文档已近 MIRROR_MAX_CHARS 上限（超限不写）。 */
  const MIRROR_TIER_LARGE = 256 * 1024
  const MIRROR_TIER_HUGE = 1024 * 1024
  const MIRROR_THROTTLE_LARGE_MS = 4_000
  const MIRROR_THROTTLE_HUGE_MS = 8_000

  /** 按内容规模取节流间隔（调度时刻定格；窗口内跨档不重排——节流本就允许
   *  ≤间隔 的滞后，重排只添复杂度）。 */
  function mirrorThrottleMs(contentChars: number): number {
    if (contentChars > MIRROR_TIER_HUGE) return MIRROR_THROTTLE_HUGE_MS
    if (contentChars > MIRROR_TIER_LARGE) return MIRROR_THROTTLE_LARGE_MS
    return MIRROR_THROTTLE_MS
  }

  /** pending 节流定时器（按 docId；间隔内多次 patch 只排一个 trailing 写）。 */
  const mirrorTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function mirrorKey(book: string, docId: string): string {
    return `${MIRROR_KEY_PREFIX}${book}:${docId}`
  }

  /** dirty/conflict entry 的节流镜像落盘（trailing：到点读 entry 当时内容）。
   *  ：间隔按调度时的内容规模分档取值。 */
  function scheduleDirtyMirror(docId: string, contentChars: number): void {
    if (mirrorTimers.has(docId)) return
    mirrorTimers.set(
      docId,
      setTimeout(() => {
        mirrorTimers.delete(docId)
        writeDirtyMirror(docId)
      }, mirrorThrottleMs(contentChars)),
    )
  }

  /** 上次实际落镜像的内容（按 docId）——节流到点先与 entry 内容做全等比对，
   *  一致即跳过 stringify+setItem。取值级全等而非「长度+首尾采样」：JS 字符串全等对
   *  同引用 O(1) 短路，异引用全量比对也远廉于 stringify 2MB，且无误跳过面（采样法有
   *  「仅中段等长改动」漏检面，漏检 = 崩溃恢复丢末次编辑，不可取）；「改了又改回」的
   *  净零编辑跳过是正确语义（镜像值即当前值，重写是纯浪费）。清理面（clearDirtyMirror /
   *  clearBookMirrors）必须同步撤销登记，防「镜像已删而指纹滞留」把该写的镜像误跳过。 */
  const lastMirroredContent = new Map<string, string>()

  function writeDirtyMirror(docId: string): void {
    const e = deps.getEntry(docId)
    const book = deps.getBook()
    // await 窗口守卫：entry 已清/已转 clean/已切书 → 不再镜像
    if (!e || !book || (!e.dirty && !e.conflict)) return
    // 内容未变不重写（比对在前、stringify 在后——大文档到点必 stringify 的
    // 峰值开销在净零编辑/重复调度面上直接归零）
    if (lastMirroredContent.get(docId) === e.content) return
    try {
      const payload = JSON.stringify({
        book,
        docId,
        content: e.content,
        savedAt: Date.now(),
        baseRev: e.baselineRevision, // 镜像时的服务端基线——复活时效门的判据
      })
      if (payload.length > MIRROR_MAX_CHARS) {
        console.debug(`[doc] dirty 镜像超限（${payload.length} chars）跳过: ${book}/${docId}`)
        return // 指纹不登记：内容缩回限内后下一拍照常落镜像（上限语义不变）
      }
      localStorage.setItem(mirrorKey(book, docId), payload)
      lastMirroredContent.set(docId, e.content)
    } catch (err) {
      // quota/存储不可用降级为无镜像（留痕供诊断）
      console.debug('[doc] dirty 镜像写入失败（降级为无镜像）', err)
    }
  }

  /** 清镜像（含 pending 节流）。book 由调用方快照（防在途切书误删他书同 docId 键）。
   *  （评审修复批）：本函数与下方 clearBookMirrors 即「键族清理单源」——
   *  docId 级精确删 + 书级前缀清扫两个入口，随 doc store 导出，供文档改名（op=rename /
   *  op=meta 路径同步 rename）、doOpen 404、删书（useShelf.confirmDelete）等各链调用，
   *  不再各链自拼 localStorage 键。 */
  function clearDirtyMirror(book: string | null, docId: string): void {
    const t = mirrorTimers.get(docId)
    if (t) {
      clearTimeout(t)
      mirrorTimers.delete(docId)
    }
    lastMirroredContent.delete(docId) // 指纹随镜像同撤（方向安全：缺指纹 = 必写）
    if (!book) return
    try {
      localStorage.removeItem(mirrorKey(book, docId))
    } catch { /* 存储不可用降级 */ }
  }

  /** 读镜像（损坏/字段非法视为不存在）。baseRev 为镜像时的服务端基线；
   *  旧格式镜像无此字段 → null，按陈旧处理只清不复活。 */
  function readDirtyMirror(
    book: string,
    docId: string,
  ): { content: string; savedAt: number; baseRev: string | null } | null {
    try {
      const raw = localStorage.getItem(mirrorKey(book, docId))
      if (!raw) return null
      const p = JSON.parse(raw) as { content?: unknown; savedAt?: unknown; baseRev?: unknown }
      if (typeof p.content !== 'string') return null
      return {
        content: p.content,
        savedAt: typeof p.savedAt === 'number' ? p.savedAt : 0,
        baseRev: typeof p.baseRev === 'string' ? p.baseRev : null,
      }
    } catch {
      return null
    }
  }

  /** 清整本书的全部镜像（setBook 切书用：属主精确判定 + pending 节流一并清）。
   *  清偿批属主判定改读镜像 payload 的 book 字段精确比对，不再裸
   *  前缀匹配 `${前缀}${book}:`——`:` 同时是键内书名与 docId 的分隔符，书名含 `:`
   *  （mac/linux 目录名合法）时前缀越界：清《A》把《A:B》的镜像一并删掉（跨书误伤）。
   *  取舍记档：①payload 自首版即含 book+docId，全量既有镜像兼容，键格式
   *  不变、零迁移；②解析失败的损坏键无从判属主，保守不删（readDirtyMirror 同样
   *  拒读，无复活面，仅存储残留）；③写侧同键碰撞（《A》+legacy docId「B:x」与
   *  《A:B》+docId「x」拼出同一键）不在此修——需换转义键格式牵出迁移，且互覆只伤
   *  崩溃镜像（不落盘数据），复活时效门（baseRev 对拍）再兜一层。 */
  function clearBookMirrors(book: string): void {
    for (const t of mirrorTimers.values()) clearTimeout(t)
    mirrorTimers.clear()
    // 指纹台账全清（按 docId 记账不辨书；全清只会多一次冗余重写，滞留则可能
    // 让跨书同 docId——legacy 按路径派生——的该写镜像被误跳过）
    lastMirroredContent.clear()
    try {
      const doomed: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k === null || !k.startsWith(MIRROR_KEY_PREFIX)) continue
        try {
          const p = JSON.parse(localStorage.getItem(k) ?? '') as { book?: unknown }
          if (p.book !== book) continue
        } catch {
          continue // 损坏镜像：无从判属主，保守不删（见上方取舍②）
        }
        doomed.push(k)
      }
      for (const k of doomed) localStorage.removeItem(k)
    } catch { /* 存储不可用降级 */ }
  }

  return { scheduleDirtyMirror, clearDirtyMirror, readDirtyMirror, clearBookMirrors }
}

export type DirtyMirror = ReturnType<typeof createDirtyMirror>
