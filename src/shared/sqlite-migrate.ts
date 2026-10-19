/**
 * sqlite schema 版本化迁移阶梯（`PRAGMA user_version` 单源）——events / rag / cache 三库共用。
 *
 * 缺口（本模块存在的理由）：三库此前的 schema 演进都是探列式——`PRAGMA table_info/
 * table_xinfo` 判列 + `ALTER TABLE ADD COLUMN`。加列可行，但**改名 / 改型 / 回滚无路径**：
 * 库里没有任何版本锚点，回答不了「这库升到哪一级了」，于是每次打开都要把全部探测重跑
 * 一遍；一旦某次演进不是「加列」形态（改列义、拆表、加约束），新旧库形态就再也无从区分。
 * 本模块把「当前 schema 处于哪一级」变成**读一个整数**：每库一份阶梯（steps），升到
 * target 后写 `user_version = target`。
 *
 * 语义裁定（四条，全部 fail-closed，不做静默容忍）：
 * 1. 库版本 > target（新库被旧代码打开）→ 抛 SqliteSchemaTooNewError，拒绝打开。
 *    理由：超前版本意味着该库由更新的应用版本写入，其 schema 可能含本代码不认识的
 *    列 / 约束 / 语义（如 NOT NULL / UNIQUE 约束、被拆分或改义的表）。旧代码照常读写
 *    会写出违反新约束的行，或按旧语义误读新数据——事件库是对话史 / 审计（产品数据），
 *    静默损伤不可逆。拒绝比容忍便宜：错误在打开点显式暴露，调用方既有降级路径承接
 *    （开库失败降级 / 上报），派生缓存库可删重建。**只读降级方案被否**：只读是调用方
 *    的纪律，本原语约束不了后续写入；三库的读写共用同一连接，假只读只是把错误推迟到
 *    第一次写入，还把「不可用」伪装成「可用」。
 * 2. 空库（sqlite_master 零行）→ 直接跑 createFresh 建到 target，不跑历史步。
 *    理由：历史步描述「从旧形态升到新形态」，空库没有旧形态可升；且历史步可能含对
 *    已废弃形态的假设（改名步 / 数据搬迁步），在空库上跑属未定义行为。
 * 3. 每步成功后写 `user_version = step.to`；步抛错则版本不推进（下次打开从同一步重试）。
 *    **不包外层事务**：步自身可能持事务（RAG 的 norm 回填走 BEGIN IMMEDIATE / COMMIT），
 *    调用方也可能已在事务内（cache 重建的建表就在 BEGIN 里）——BEGIN 套 BEGIN 直接抛错。
 *    DDL 与 PRAGMA user_version 各自是原子语句，重试正确性由「步必须幂等」保证：失败重跑
 *    同一步，已生效的 DDL 是 no-op（CREATE / ALTER 幂等形态）。代价如实记：步执行到一半
 *    崩溃会留下「部分 DDL + 旧版本号」态，靠下一次打开重跑该步收敛。
 * 4. 步抛错**原样上抛，不包装**：上游存在按错误形态判定的分支（库损坏判定、duplicate
 *    column 幂等、唯一约束去重），包装会改判据，把可自愈故障升级成硬错。
 *
 * 零依赖（只依赖 node:sqlite 的类型，且仅以窄接口约束、不 import 该模块）：日志留痕归各域
 * 调用点（tag 由域侧给出），本模块不感知 log / 库路径 / 库内容——迁移只涉 schema，正文
 * 永不入本模块视野。「node:sqlite 的 DatabaseSync 满足本窄接口」由各域调用点（db 为
 * DatabaseSync）在编译期自证，本模块不重复声明该类型。
 */
/** 原语实际触达的连接面（窄接口）：node:sqlite 的 DatabaseSync 结构满足，测试可注入
 *  记账替身以断言「零 DDL」（假连接无需类型断言）。 */
export interface SqliteMigrationConn {
  prepare(sql: string): { get(): unknown }
  exec(sql: string): void
}

/**
 * 一级升级步：把库从 to-1 级升到 to 级。
 *
 * **硬契约（新增步的前置条件，不是建议）**：`run` 必须**幂等且可重入**。阶梯不包外层
 * 事务（见文件头裁定 3），步执行到一半崩溃会留下「部分 DDL + 旧版本号」态，下次打开
 * 从同一步重跑——因此步内每个动作都必须满足「重复执行等价于执行一次」：建表用
 * `IF NOT EXISTS`、加列先探列（`PRAGMA table_info/table_xinfo`）再 `ALTER`、回填／搬迁
 * 按条件收敛，且不得假设「本步只会被调用一次」。违反的代价：同一库在不同崩溃点收敛到
 * 不同形态，而版本号只记「跑到哪一步」，阶梯无从发现（契约的反面钉子见
 * test/rag/store-migration-race.test.ts 的阶梯契约用例）。
 */
export interface SqliteMigrationStep<C extends SqliteMigrationConn> {
  readonly to: number
  readonly run: (db: C) => void
}

/** 一库一份迁移计划。steps 必须恰为 1..target 连续升序（见 assertLadder）；createFresh
 *  是空库直达 target 的建库路径，其末态 schema 必须与「跑完全部 steps」逐字一致——两条
 *  路径的 schema 分叉是本阶梯最隐蔽的失效形态（新库正常、老库正常、混合环境报错）。 */
export interface SqliteMigrationPlan<C extends SqliteMigrationConn> {
  readonly tag: string
  readonly target: number
  readonly steps: readonly SqliteMigrationStep<C>[]
  readonly createFresh: (db: C) => void
}

/** 迁移结果类别：fresh = 空库直达；applied = 跑了至少一步；skipped = 已在目标版本（零 DDL）。 */
export type SqliteMigrationKind = 'fresh' | 'applied' | 'skipped'

/** 迁移结果（供各域留痕；不含库路径与内容）。 */
export interface SqliteMigrationOutcome {
  readonly kind: SqliteMigrationKind
  readonly from: number
  readonly to: number
  /** 本次执行的步号（升序）；fresh / skipped 恒空（fresh 不跑 steps，kind 自明） */
  readonly appliedSteps: readonly number[]
}

/** 库版本超前（库由更新版本的应用写入，本应用不认识其 schema）。类型化是为了让调用方
 *  能按类型分派（区别于库损坏 / 锁 / IO 故障：那三类可重试或可删重建，本类只能升级应用）。 */
export class SqliteSchemaTooNewError extends Error {
  readonly tag: string
  readonly dbVersion: number
  readonly target: number

  constructor(tag: string, dbVersion: number, target: number) {
    super(
      `${tag} 库 schema 版本超前（user_version=${dbVersion}，本应用支持到 v${target}）——` +
        `该库由更新版本的应用写入，以旧 schema 认知读写会静默损坏数据，故拒绝打开；` +
        `请升级应用版本后重试（派生缓存库亦可删除重建）`,
    )
    this.name = 'SqliteSchemaTooNewError'
    this.tag = tag
    this.dbVersion = dbVersion
    this.target = target
  }
}

/** 「库版本超前」判据（类型化分派单源）：调用方据此把该态归并为可透出的状态
 *  （如 RAG 索引状态的 too-new），区别于损坏／锁／IO——那三类可重试或可删重建，
 *  本类唯一出路是升级应用版本。 */
export function isSqliteSchemaTooNewError(e: unknown): e is SqliteSchemaTooNewError {
  return e instanceof SqliteSchemaTooNewError
}

/** 阶梯校验（红线）：steps 必须恰为 1..target 连续升序。缺号会让某级升级被静默跳过
 *  ——版本照样推到 target，库却停在中间形态，此后每次打开都以为已是最新；重复 / 乱序
 *  同属配置错误。计划由域侧常量手写，故此处抛错而非静默修补。 */
function assertLadder<C extends SqliteMigrationConn>(plan: SqliteMigrationPlan<C>): void {
  if (!Number.isInteger(plan.target) || plan.target < 1) {
    throw new Error(`sqlite 迁移计划非法（${plan.tag}）：target 须为正整数，收到 ${plan.target}`)
  }
  if (plan.steps.length !== plan.target) {
    throw new Error(
      `sqlite 迁移计划非法（${plan.tag}）：target=${plan.target} 须恰有 ${plan.target} 步（1..target 连续），实有 ${plan.steps.length} 步`,
    )
  }
  for (let i = 0; i < plan.steps.length; i++) {
    if (plan.steps[i]!.to !== i + 1) {
      throw new Error(
        `sqlite 迁移计划非法（${plan.tag}）：第 ${i} 步的 to=${plan.steps[i]!.to}，应为 ${i + 1}（阶梯须连续升序）`,
      )
    }
  }
}

/** 读版本锚。user_version 缺失 / 非非负整数（理论不可达态）按 0 处理：把异常形态当
 *  「未升级」走阶梯，最坏是重跑一次幂等首步（探列 + ALTER 对已就位的列是 no-op），
 *  比抛错更安全。 */
function readUserVersion(db: SqliteMigrationConn): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const v = row?.user_version
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0
}

/** 空库判定：sqlite_master 零行（新文件尚未建任何对象）。用「有无对象」而非「文件是否
 *  新建」——建了文件但 DDL 未跑成 / 对象全被删的库同样该走 createFresh 直达目标版本。 */
function isFreshDatabase(db: SqliteMigrationConn): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get() as { n?: number } | undefined
  return row?.n === 0
}

/** 写版本锚。PRAGMA 不接受参数绑定（占位符在 PRAGMA 上非法），故拼接——先过整数校验，
 *  非法即抛。版本号全部来自域侧常量与步定义，非外部输入，拼接面为零。 */
function writeUserVersion(db: SqliteMigrationConn, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`sqlite 迁移：版本号非法（${version}）`)
  }
  db.exec(`PRAGMA user_version = ${version}`)
}

/**
 * 把库升到 plan.target：读版本锚 → 空库直达 / 逐级执行缺的步（每步成功后推版本）。
 * 已是最新则**一条语句都不执行**（零 DDL、零写入）——打开热路径（每次召回开 RAG 库、
 * 每次首开事件库）的常态成本只是读一个整数。
 */
export function migrateSqlite<C extends SqliteMigrationConn>(
  db: C,
  plan: SqliteMigrationPlan<C>,
): SqliteMigrationOutcome {
  assertLadder(plan)
  const current = readUserVersion(db)
  if (current > plan.target) throw new SqliteSchemaTooNewError(plan.tag, current, plan.target)
  if (isFreshDatabase(db)) {
    plan.createFresh(db)
    writeUserVersion(db, plan.target)
    return { kind: 'fresh', from: 0, to: plan.target, appliedSteps: [] }
  }
  if (current === plan.target) {
    return { kind: 'skipped', from: current, to: plan.target, appliedSteps: [] }
  }
  const appliedSteps: number[] = []
  for (const step of plan.steps) {
    if (step.to <= current) continue
    step.run(db)
    writeUserVersion(db, step.to)
    appliedSteps.push(step.to)
  }
  return { kind: 'applied', from: current, to: plan.target, appliedSteps }
}

/** 迁移结果的单行描述（各域 log 留痕共用；只含版本与步号——不含库路径与内容，
 *  迁移只涉 schema，正文永不入日志）。 */
export function describeSqliteMigration(outcome: SqliteMigrationOutcome): string {
  if (outcome.kind === 'fresh') {
    return `schema 新库直达 v${outcome.to}（空库按目标版本建表，不跑历史步）`
  }
  if (outcome.kind === 'applied') {
    return `schema 迁移 v${outcome.from} → v${outcome.to}（应用步 ${outcome.appliedSteps.join('、')}）`
  }
  return `schema 已在 v${outcome.to}（无需迁移，零 DDL）`
}
