/**
 * 书库 layout 迁移编排表 —— 启动迁移链的单点顺序声明。
 *
 * 迁移链原逐行硬编码在 studio/server/index.ts 的启动段（v2 版式 → v3 版式 →
 * 版本目录 → 伏笔搬迁 → 定稿基线）：步骤间的「先于/晚于」依赖只活在注释里，新迁移
 * 插入位置无锚，插错位即静默错序——伏笔搬迁晚于定稿基线时，清单路径已被 v2 步改指
 * 设定/伏笔/*，而物理文件靠伏笔步搬；定稿基线先跑会对 设定/伏笔/* existsSync 落空、
 * 跳过该 entry，且整书幂等闸（任一 document entry 已有基线→整书跳过）此后不再补，
 * git 时代书的伏笔永久缺定稿基线。
 *
 * 契约：`LAYOUT_MIGRATIONS` 数组序 = 执行序，各步保持既有幂等语义（每启动重跑无害）。
 * 表序即依赖声明——需要「先于某步」的新迁移插在该步之前；既有依赖由顺序契约测试锁住
 * （见 test/install/migrate-foreshadow-before-finalize.test.ts）。
 *
 * 执行面为异步（`runLayoutMigrationsAsync`）：链在服务启动段跑在 listen 之前，
 * 其中定稿基线步要读 git status——同步版（spawnSync + 清单锁 Atomics.wait）在网盘
 * 挂载 / 杀软锁 .git 时会把服务进程事件循环连续占满，启动整体停摆。各步 run 记作
 * 「同步或异步」，驱动器逐个 await（同步步 await 一个非 promise 值零额外调度代价），
 * **表序契约与执行顺序逐位不变**。
 *
 * 不引入书级 layout_version 锚：各步判定成本低（目录/清单 existsSync）且幂等，版本锚
 * 要新增用户库文件，且半途失败时锚语义复杂（锚已 bump 而某步未成，须按步回退或降级），
 * 收益不抵风险面——顺序单点化已消掉本问题的错序通道。
 */
import { migrateLayoutV2 } from './migrate-layout-v2.js'
import { migrateLayoutV3 } from './migrate-layout-v3.js'
import { migrateFinalizedRevisionsAsync } from './migrate-finalized-revision.js'
import { migrateLegacyForeshadows } from '../document/foreshadow.js'
import { migrateVersionsDir } from '../document/version.js'

/** 单步迁移结果：errors 沿用 v2/v3 的结构化错误面（无错误 = 空数组）。 */
export interface LayoutMigrationStepResult {
  errors: string[]
}

/** 编排表条目。 */
export interface LayoutMigration {
  /** 表内唯一标识：顺序契约测试与启动通告定位用 */
  id: string
  /** 启动通告 kind（errors 非空时使用；不产通告的步骤缺省） */
  noticeKind?: string
  /** 通告文案中的步骤名（如「版式 v2 迁移」） */
  noticeLabel?: string
  /** 执行一步（幂等）；抛出即中断本表，由调用方逐书收口 */
  run: (bookRoot: string) => LayoutMigrationStepResult | Promise<LayoutMigrationStepResult>
}

/**
 * 书级 layout 迁移表——数组序即执行序（改动此数组即改动启动链顺序）。
 * 新增迁移：插到依赖位并在顺序契约测试里声明其先于/晚于关系。
 */
export const LAYOUT_MIGRATIONS: readonly LayoutMigration[] = [
  {
    id: 'layout-v2',
    noticeKind: 'migrate-layout-v2',
    noticeLabel: '版式 v2 迁移',
    // 旧目录固化 + 清单 entry.path 改写（定稿/正文→写作/正文、大纲/{5类线索}→布线/…）。
    // 先于伏笔搬迁：伏笔 entry 的新路径由本步改写，物理文件由伏笔步搬。
    run: (bookRoot) => migrateLayoutV2(bookRoot),
  },
  {
    id: 'layout-v3',
    noticeKind: 'migrate-layout-v3',
    noticeLabel: '版式 v3 迁移',
    // 取消草稿目录：写作/草稿/草稿-N.md 搬回正文区（幂等，源不存在 no-op）。
    run: (bookRoot) => migrateLayoutV3(bookRoot),
  },
  {
    id: 'versions-dir',
    // 工作区/.snapshots → 工作区/.版本（幂等，旧目录不存在 no-op；无结构化错误面）。
    run: (bookRoot) => {
      migrateVersionsDir(bookRoot)
      return { errors: [] }
    },
  },
  {
    id: 'legacy-foreshadows',
    // 大纲/伏笔/ → 设定/伏笔/（幂等，旧目录不存在 no-op）。
    // 必须在 finalized-revisions **之前**（本表序即该契约）：清单路径已由 layout-v2 指到
    // 设定/伏笔/*，物理文件靠本步搬；若定稿基线先跑，伏笔 entry 对 设定/伏笔/* existsSync
    // 落空被跳过，整书幂等闸此后不再补——git 时代书的伏笔永久缺定稿基线。
    // 两步无相互依赖（本步不读清单，定稿基线不碰磁盘搬迁），调序安全性仅由表序保证。
    run: (bookRoot) => {
      migrateLegacyForeshadows(bookRoot)
      return { errors: [] }
    },
  },
  {
    id: 'finalized-revisions',
    // 定稿基线：旧 git 书库 clean→final / dirty→revision / untracked→draft（幂等）。
    // 本步为异步（git status 走异步孪生 + 清单锁异步孪生，见该函数头注）。
    run: (bookRoot) => migrateFinalizedRevisionsAsync(bookRoot).then(() => ({ errors: [] as string[] })),
  },
]

/** 逐步执行结果（含通告定位面），供启动链生成启动通告。 */
export interface LayoutMigrationOutcome {
  id: string
  noticeKind?: string
  noticeLabel?: string
  errors: string[]
}

/**
 * 按表序执行全部书级 layout 迁移（异步——启动段在 createServer/listen 之前 await）。
 * 任一步抛出即中断本表，由调用方逐书 try/catch 收口（单本书故障只降级该书）。
 * 表序即执行序：逐个 await 保证「前一步完成才起后一步」，顺序契约与同步版逐位一致。
 */
export async function runLayoutMigrationsAsync(bookRoot: string): Promise<LayoutMigrationOutcome[]> {
  const outcomes: LayoutMigrationOutcome[] = []
  for (const migration of LAYOUT_MIGRATIONS) {
    const result = await migration.run(bookRoot)
    outcomes.push({
      id: migration.id,
      noticeKind: migration.noticeKind,
      noticeLabel: migration.noticeLabel,
      errors: result.errors,
    })
  }
  return outcomes
}
