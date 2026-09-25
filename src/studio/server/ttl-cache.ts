/**
 * TTL+探针+FIFO 结果缓存通用壳（复审-0914-优化修复批 D1 收敛件）。
 *
 * server 域此前 17 份同构缓存壳（stat 指纹探针 + TTL 注入口 + `__xxxScanCountForTest`
 * 计数钩子 + forget 挂点 + 过期顺手逐出 + FIFO 上限），每份 40-80 行复制；本件归一为
 * 单源工厂。**时序语义逐位对齐既有各份**（R42-16/R44-9 两档 ts/probeTs 判定、R47-18
 * 过期顺手逐出、命中不续命、FIFO 按 Map 插入序逐最旧），收敛映射与沿革：
 *
 * | 端点缓存（文件 · Map）                                | 形态                     | 沿革 |
 * |------------------------------------------------------|--------------------------|------|
 * | search.ts · searchCache（R35-7）                      | 单级探针 + 异步 + inFlight| R47-18 顺手逐出 |
 * | rhythm.ts · rhythmCache（R44-8）                      | 单级探针 + 同步          | R47-18 |
 * | settings.ts · settingsCache（R46-16）                 | 单级探针 + 同步/异步孪生 + inFlight | 无逐出（特记 evictExpiredOnMiss:false）；0918独立重评修复批 D001 补 inFlight |
 * | settings.ts · completionNamesCache（R0912-ds41）      | 单级探针 + 异步 + inFlight | 同上；TTL 链 = 本壳注入口 → settings 注入口 → 常量；D001 补 inFlight |
 * | foreshadows.ts · foreshadowCache 同步孪生（R44-8）    | 单级探针 + 同步          | R47-18 |
 * | foreshadows.ts · foreshadowCache 异步孪生（PM-1）     | 单级探针 + 异步 + inFlight| 与同步孪生共壳共 Map |
 * | health.ts · styleScanCache（D3/R62-21）               | 纯 TTL + 异步            | R47-18 / R0912-B-P2-1 ts 取写入当刻 |
 * | analysis.ts · styleCorpusCache（D3/R62-21）           | 纯 TTL + 异步            | R42-16 ts 当刻 / R58-B-10 写侧全表过期清扫 |
 * | analysis.ts · analysisOverviewCache（R36-7/R37-17）   | 两级探针 + 异步          | 重评2-P3-④ 探针节流 / R44-10 异步让出 |
 * | snapshots.ts · versionStatsCache（R36-7/R37-17/R44-9）| 两级探针 + 异步          | 同上（本形态正本位） |
 * | overview.ts · overviewCache（R47-7）                  | 单级探针 + 异步          | 成功态才落缓存（storeIf）/ R47-18 |
 * | overview.ts · stateCache（G3/R37-19）                 | 纯 TTL + 异步            | 失败不落缓存；无逐出行（evictExpiredOnMiss:false） |
 * | state.ts · stateCache（R75-D-P3b）                    | 纯 TTL + 异步            | 成功才落缓存；R47-18 |
 * | check.ts · treeIssuesCache（R75-D-P3b）               | 纯 TTL + 异步            | 同上 |
 * | knowledge.ts · learnCache（R66-28）                   | 纯 TTL + 异步            | result.ok 才落缓存（storeIf）；R47-18 |
 * | progress.ts · summaryCache（V-P2-27/R37-3）           | 纯 TTL 30s + 同步/异步孪生| 共壳共 Map；R47-18 |
 * | books.ts · shelfGuardCache（R39-16）                  | 纯 TTL 30s + 同步        | 损坏标记也落缓存；forget = 整表 clear |
 *
 * 保留手写特例（不收敛，记因）：
 * - stream-ticket.ts tickets（R32-21/R73-49）：一次性票库非「探针签名+计算结果」缓存
 *   形态——条目值即过期时刻、消费即删、签发时全表 prune、触顶逐最早过期票，通用件
 *   语义面（probe 命中判定/store 条件/FIFO 时机）均不覆盖，硬套会改时序行为。
 *
 * 行为红线（本批遵守）：命中/失效时序、逐出序、bookRoot 键控、响应字节逐位不变——
 * 各端点的 TTL 测试注入口（__setXxxForTest）名与签名原样保留在端点文件内，经 ttl
 * 注入 getter 接本件。观测钩子（R0916-7-P3-6 钩子收敛）：计数不再以测试命名 API 挂在
 * 壳上，改由壳自持 stats()/resetStats() 观测面承载——原路由层自持的探针/签名计数闭包
 * 与 __xxxScanCountForTest 一族随之删除（analysis / snapshots / settings 三族先行）。
 *
 * 键控：业务键 K（可为复合对象）经 keyOf 字符串化为 Map 存储键（searchCache
 * `bookRoot\0scope\0q` / shelfGuardCache `workDir\0path` 同款复合键口径）。
 */
export interface TtlProbeCacheOptions<K, V> {
  /** 诊断名（错误信息用，无行为面） */
  name: string
  /** 业务键 → Map 存储键（简单书键缓存传恒等 `k => k`） */
  keyOf: (key: K) => string
  /** FIFO 容量：插新键前 size ≥ max 逐最旧（Map 插入序；set 覆写不重排行——与既有各份逐位一致） */
  max: number
  /** 生效 TTL（ms）——每次判定现取：端点的 `__setXxxForTest(ms | null)` 改写模块级
   *  覆盖变量后立即生效（settings completion-names 的「本壳 → settings 壳 → 常量」回落
   *  链在端点侧以闭包表达，本件不感知） */
  ttl: () => number
  /** 单级探针：stat 指纹/目录签名，每次 get 现算（先于命中判定——既有各份口径：探针
   *  在扫描**前**取值，扫描期间落盘的变更使签名失配，下次按失效重算，宁多扫不脏读）。
   *  两级探针缓存传入「第一级便宜指纹」，第二级走 signature。 */
  probe?: (key: K) => string
  /** 两级探针第二级（全量 stat 签名 walk）：仅在第一级指纹变化时执行；签名一致回填
   *  第一级指纹复用结果免重算（snapshots.ts R44-9 正本位语义，计数由端点传入的包装
   *  函数自行维护）。须与 probe 同用。 */
  signature?: (key: K) => string
  /** 同步计算体（getSync 用；与 computeAsync 至少提供其一，孪生共享壳时两者都给） */
  computeSync?: (key: K) => V
  /** 异步计算体（get 用） */
  computeAsync?: (key: K) => Promise<V>
  /** 只缓存满足条件的成功结果（learnCache result.ok / overviewCache stateOk 同款）；
   *  不满足时照常返回值但不 FIFO 不落缓存 */
  storeIf?: (value: V) => boolean
  /** 在途去重：同键并发 MISS 合并为同一 Promise（searchBookCached inFlightSearches /
   *  getForeshadowsCachedAsync foreshadowInFlight 同款；job 收尾自清，拒绝不悬空） */
  inFlight?: boolean
  /** MISS 路径过期条目顺手逐出（R47-18，缺省 true）：重算路径必走，delete 零成本零
   *  语义变更（成功 set 原键覆写）。settings×2 与 overview stateCache 无此行，传 false。 */
  evictExpiredOnMiss?: boolean
  /** 写侧全表过期清扫（styleCorpusCache R58-B-10 同款）：仅写路径、FIFO 之前，逐出
   *  全部已过期条目（未触达书的陈旧条目不驻留至 FIFO 触顶） */
  sweepExpiredOnWrite?: boolean
}

interface TtlCacheEntry<V> {
  value: V
  /** 写入当刻 Date.now()（R42-16/R0912-B-P2-1 口径——MISS 计算体含让出跨 tick，
   *  「出生即折旧」会吃掉 TTL 窗） */
  ts: number
  sig?: string
  probe?: string
  /** 探针取值时刻（两级探针专用，重评2-P3-④/R44-9：节流窗起点，≤ ts——复用窗 ⊆
   *  缓存 TTL 窗，不出现「探针仍新鲜而缓存已过期」的倒挂） */
  probeTs?: number
}

type TtlJudgment<V> =
  | { action: 'hit'; value: V }
  | { action: 'compute'; sig?: string; probe?: string; probeTs?: number }

export interface TtlProbeCache<K, V> {
  readonly name: string
  /** 异步取：命中返回缓存值；MISS 走 计数→计算→(sweep)→FIFO→落缓存。compute 可在
   *  创建时给（options.computeAsync，纯 bookRoot 派生计算体）或逐调用给（闭包
   *  per-request 上下文——styleCorpus 章列表/规则、state/overview userDataPath 等同款），
   *  逐调用优先；两者都缺 → 拒绝。 */
  get(key: K, computeAsync?: (key: K) => Promise<V>): Promise<V>
  /** 同步取（computeSync 必备）：判定/计算全同步单段（既有同步壳同形态，无在途窗口） */
  getSync(key: K): V
  /** 删书/改名失效挂点：精确键删（books.ts forgetBookKeyedCaches 家族同款） */
  forget(key: K): void
  /** 前缀键删（searchCache 复合存储键同款：存储键 `startsWith(prefix + '\0')`；仅
   *  字符串化存储键有意义，非字符串前缀匹配的键缓存勿用） */
  forgetPrefix(prefix: string): void
  /** 整表清（shelfGuardCache forgetBookKeyedCaches 同款） */
  clear(): void
  /** 条目在否（裸 Map.has 语义）。留钩子理由（R0916-7-P3-6）：纯观测读取——生产零调用、
   *  不改变缓存行为，删掉只能让「过期逐出/FIFO 淘汰」类断言退化为时间猜测。 */
  has(key: K): boolean
  /** 观测面（R0916-7-P3-6 钩子收敛）：MISS→实际计算 / 探针 / 全量签名 三计数。
   *  取代逐端点 __xxxScanCountForTest + 路由层自持计数闭包——观测改读缓存实例自身，
   *  生产零调用（纯观测读取，不改变缓存行为）。 */
  stats(): TtlCacheStats
  /** 计数复位（同观测面；三计数一并清零，测试用例间隔离用） */
  resetStats(): void
}

/** 缓存运行计数（观测面返回值；缺省全 0）。 */
export interface TtlCacheStats {
  /** MISS→实际计算次数（原 scanCountForTest） */
  misses: number
  /** 探针调用次数（原路由层自持 __xxxProbeCountForTest） */
  probes: number
  /** 全量签名调用次数（原路由层自持 __xxxSigCountForTest） */
  signatures: number
}

export function createTtlProbeCache<K, V>(opts: TtlProbeCacheOptions<K, V>): TtlProbeCache<K, V> {
  if (opts.signature && !opts.probe) {
    throw new Error(`[ttl-cache:${opts.name}] signature（两级探针第二级）须与 probe 同用`)
  }
  const evictExpired = opts.evictExpiredOnMiss ?? true
  const map = new Map<string, TtlCacheEntry<V>>()
  const inflight = new Map<string, Promise<V>>()
  // 运行计数（观测面 stats 来源）：misses 计入实际计算体，probes/signatures 计入探针
  // 调用点——原分散在各路由文件的自持计数闭包随之删除（R0916-7-P3-6）。
  let misses = 0
  let probes = 0
  let signatures = 0

  /** 探针取值（计数唯一入口，见 stats） */
  function probeOf(key: K): string {
    probes += 1
    return opts.probe!(key)
  }
  /** 全量签名取值（计数唯一入口，见 stats） */
  function signatureOf(key: K): string {
    signatures += 1
    return opts.signature!(key)
  }

  /** 命中判定（全同步段）：probe 未变 && 未过 TTL（两级形态见 R44-9 转写注）。 */
  function judge(key: K): TtlJudgment<V> {
    const now = Date.now()
    const ttl = opts.ttl()
    const cached = map.get(opts.keyOf(key))
    if (opts.signature) {
      // 两级探针（snapshots.ts R44-9① 正本位转写）：TTL 窗内复用上次探针值（命中路径
      // 零系统调用）；超窗现取并刷新旧条目 probeTs（后续 L2 命中回填时窗口随之续期——
      // 与既有实现逐位一致，含「探针窗新而缓存 TTL 已过」时条目照逐出的路径）
      let probe: string
      if (cached && cached.probeTs !== undefined && now - cached.probeTs < ttl) {
        probe = cached.probe!
      } else {
        probe = probeOf(key)
        if (cached) cached.probeTs = now
      }
      // 第一级：便宜指纹未变（且 TTL 内）→ 直接复用，跳过全量签名 walk
      if (cached && now - cached.ts < ttl && cached.probe === probe) {
        return { action: 'hit', value: cached.value }
      }
      // R47-18：TTL 已过的条目两级判定均不可能再命中，顺手逐出
      if (cached && now - cached.ts >= ttl && evictExpired) map.delete(opts.keyOf(key))
      // 第二级：指纹变了才全量签名；签名一致 → 回填指纹、复用结果免重算
      const sig = signatureOf(key)
      if (cached && now - cached.ts < ttl && cached.sig === sig) {
        cached.probe = probe
        return { action: 'hit', value: cached.value }
      }
      return { action: 'compute', sig, probe, probeTs: now }
    }
    // 单级探针：现算签名（先于命中判定——扫描前取值口径）；纯 TTL 形态 sig === undefined
    const sig = opts.probe ? probeOf(key) : undefined
    if (cached && now - cached.ts < ttl && (sig === undefined || cached.sig === sig)) {
      return { action: 'hit', value: cached.value }
    }
    // R47-18：过期条目顺手逐出（纯 TTL 形态 miss ⟺ 过期，与既有 `if (cached) delete` 等价）
    if (cached && now - cached.ts >= ttl && evictExpired) map.delete(opts.keyOf(key))
    return { action: 'compute', sig }
  }

  /** 落缓存（storeIf 不满足即静默跳过）：(sweep) → FIFO 逐最旧 → set（ts 取写入当刻） */
  function store(key: K, j: Extract<TtlJudgment<V>, { action: 'compute' }>, value: V): void {
    if (opts.storeIf && !opts.storeIf(value)) return
    if (opts.sweepExpiredOnWrite) {
      const sweepTtl = opts.ttl()
      const sweepNow = Date.now()
      for (const [k, v] of map) {
        if (sweepNow - v.ts >= sweepTtl) map.delete(k)
      }
    }
    // 简单 FIFO 淘汰（Map 保插入序；set 覆写既有键不重排——与既有各份逐位一致）
    if (map.size >= opts.max) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    const entry: TtlCacheEntry<V> =
      j.probeTs !== undefined
        ? { value, ts: Date.now(), sig: j.sig, probe: j.probe, probeTs: j.probeTs }
        : j.sig !== undefined
          ? { value, ts: Date.now(), sig: j.sig }
          : { value, ts: Date.now() }
    map.set(opts.keyOf(key), entry)
  }

  return {
    name: opts.name,
    get(key: K, computeAsync?: (key: K) => Promise<V>): Promise<V> {
      const j = judge(key)
      if (j.action === 'hit') return Promise.resolve(j.value)
      const compute = computeAsync ?? opts.computeAsync
      if (!compute) {
        return Promise.reject(new Error(`[ttl-cache:${opts.name}] get() 需要 compute（创建时或逐调用给）`))
      }
      // 在途去重：同键并发 MISS 只算一次，后到者 await 同一 Promise（判定段已先行
      // 走完过期逐出——与 searchBookCached/getForeshadowsCachedAsync 逐位一致）
      if (opts.inFlight) {
        const existing = inflight.get(opts.keyOf(key))
        if (existing) return existing
      }
      const job = (async (): Promise<V> => {
        misses += 1
        const value = await compute(key)
        store(key, j, value)
        return value
      })()
      if (opts.inFlight) {
        inflight.set(opts.keyOf(key), job)
        // 收尾自清（catch 先落避免 job 被拒时清理链 unhandled rejection；拒绝仍按常
        // 送达真实调用方——路由层统一错误面）
        job.catch(() => {}).then(() => {
          inflight.delete(opts.keyOf(key))
        })
      }
      return job
    },
    getSync(key: K): V {
      const j = judge(key)
      if (j.action === 'hit') return j.value
      const computeSync = opts.computeSync
      if (!computeSync) {
        throw new Error(`[ttl-cache:${opts.name}] getSync() 需要 computeSync`)
      }
      misses += 1
      const value = computeSync(key)
      store(key, j, value)
      return value
    },
    forget(key: K): void {
      map.delete(opts.keyOf(key))
    },
    forgetPrefix(prefix: string): void {
      for (const k of map.keys()) {
        if (k.startsWith(prefix + '\u0000')) map.delete(k)
      }
    },
    clear(): void {
      map.clear()
    },
    has(key: K): boolean {
      return map.has(opts.keyOf(key))
    },
    stats(): TtlCacheStats {
      return { misses, probes, signatures }
    },
    resetStats(): void {
      misses = 0
      probes = 0
      signatures = 0
    },
  }
}
