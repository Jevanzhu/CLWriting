/**
 * 阶段 52（慢盘面加固 P3-12）：机检链「前奏段」让出计数观察口。
 *
 * 各切片段（生成器核）每处理 *_YIELD_EVERY 项自增一次——供测试断言「让出确实落在
 * 目标段」（A2 隔离夹具：把目标段喂大、其余段喂小，断言 处理 N 项 ⇒ 让出 ≥ ⌊N/K⌋；
 * 单靠心跳不能区分刀落在哪一段）。生产只增不读，口径同 cache/rebuild.ts 的
 * sourceProbeStats（「测试断言用」）。
 *
 * 落 shared 而非 check：消费方横跨 format/chapters.ts（正文/章纲目录整扫）与
 * check/*，而 format 不得 import check（P2-A1 消环口径）。
 */
export const preludeYieldStats = {
  /** tree-issues-cache.ts dirFpCore：纪元指纹递归 walk（计数单位 = 计入指纹的 .md 项） */
  dirFp: 0,
  /** format/chapters.ts scanChapterDirCore：目录整扫（计数单位 = walk 枚举到的 .md 项） */
  chapterScan: 0,
  /** run.ts scanChapterUpdatesByChapterCore：账本归档逐文件读（计数单位 = 配对的归档 .md） */
  leadUpdatesScan: 0,
  /** leads.ts checkLeadsBookItemsCore：全书性红项（计数单位 = 引文核验的履历条） */
  leadsBook: 0,
  /** run.ts openCheckDbAsync：rebuild 效应让出档（S3 落） */
  rebuild: 0,
}

/** 测试复位口（零生产调用；先例 cache/rebuild.ts clearSourceProbeThrottle）。 */
export function __resetPreludeYieldStatsForTest(): void {
  preludeYieldStats.dirFp = 0
  preludeYieldStats.chapterScan = 0
  preludeYieldStats.leadUpdatesScan = 0
  preludeYieldStats.leadsBook = 0
  preludeYieldStats.rebuild = 0
}
