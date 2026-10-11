/**
 * 连接级 prepared 语句缓存的单源；并承载事务失败路径的静默回滚单点
 *（rollbackQuietly / rollbackToSavepointQuietly——各域失败回滚不得再自带 try/catch 拷贝）。
 *
 * 三域（events / rag / check）原各落一份「WeakMap<db, Map<sql, stmt>> + 配对 close」
 * 的逐字同构实现；族 bug（node:sqlite 的 StatementSync 强引用其 DatabaseSync，与 WeakMap
 * 弱键构成 ephemeron 环——裸 close 后条目不随 GC 消失，每次开/关滞留 ~0.35KB 线性堆积）
 * 已需分头各修一遍，而独立性收益（互不影响）小于「同族根因修一次漏两处」的风险——
 * 故单源一处，三域改薄薄一层 re-export（对外名不变，消费方 import 面零改动），
 * 结构契约测试锚点同步移入本文件。
 *
 * 用法契约（两件必须成对，缺一即返祖）：
 *  1. `prepared(db, sql)` 只用于**恒定不变的高频 SQL**（DDL / 一次性迁移 / PRAGMA /
 *     拼变体的动态 SQL 不入缓存）；sql 串本身即缓存键，变体各自独立缓存（变体数须有界）。
 *  2. 凡有 prepared 调用面的连接，关库一律走 `closeWithPrepared(db)`，**不得裸 db.close**
 *     ——后者断不开 ephemeron 环，才是滞留根因。
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite'

/**
 * 键控在连接对象身份上的语句缓存。跨域共用一份是安全的：db 实例身份唯一，不同库
 * （RAG 库 / 事件库 / 机检缓存库）天然落在不同键下，不会互相污染；单份缓存也免去
 * 「同一条 SQL 被两域各编译一次」的重复。
 */
const preparedByDb = new WeakMap<DatabaseSync, Map<string, StatementSync>>()

/** 按 (db, sql) 取缓存的 prepared 语句；未见过则编译一次入缓存。 */
export function prepared(db: DatabaseSync, sql: string): StatementSync {
  let bySql = preparedByDb.get(db)
  if (bySql === undefined) {
    bySql = new Map()
    preparedByDb.set(db, bySql)
  }
  let stmt = bySql.get(sql)
  if (stmt === undefined) {
    stmt = db.prepare(sql)
    bySql.set(sql, stmt)
  }
  return stmt
}

/**
 * 带缓存注销的关库——先摘缓存断 ephemeron 链再 close。根因与实测数据见文件头注
 *（裸 .mjs 40k 次 open/close 复现：每次 ~0.35KB 线性堆积；close 前
 * 显式 delete 后 30k 次开/关实测归零）。三域各自的 closeEventsDb / closeRagDb /
 * closeTreeIssuesDb 均薄封装本函数，断链序在此单点保证。
 */
export function closeWithPrepared(db: DatabaseSync): void {
  preparedByDb.delete(db)
  db.close()
}

/** 静默回滚（事务）——事务样板失败路径的单点。SQLite 部分错误（SQLITE_FULL/IOERR 等）
 * 在报错前已自动回亡事务，此时裸 ROLLBACK 抛 "no transaction is active"，会替代原始
 * 病因上抛（吞诊断）；本单点吞掉回滚自身异常，原始错误由调用方原样上抛/返回。
 * 无事务在跑时调用无害（回滚动作已由自动回亡兜底）。 */
export function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK')
  } catch {
    /* 事务已自动回亡：原始错误优先 */
  }
}

/** 静默回滚到保存点（ROLLBACK TO + RELEASE 整对）。SAVEPOINT 语义与裸 ROLLBACK 不同：
 * 自动回亡外层事务时连保存点一并销毁，ROLLBACK TO / RELEASE 均抛 "no such savepoint"，
 * 同会掩蔽原始写错误——两步必须整对包裹（首步抛 ⟺ 保存点已销毁，RELEASE 无从成功），
 * 原始错误由调用方上抛。 */
export function rollbackToSavepointQuietly(db: DatabaseSync, name: string): void {
  try {
    db.exec(`ROLLBACK TO ${name}`)
    db.exec(`RELEASE ${name}`)
  } catch {
    /* SAVEPOINT 已随自动回亡销毁 */
  }
}
