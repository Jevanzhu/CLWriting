#!/usr/bin/env node
/**
 * 模型参数表目录生成脚本（批次 D1，学 cherry generate-catalog）。
 *
 * 用法：npm run generate:catalog
 * 改 src/ai/provider/model-quirks.ts（唯一真相源）后必跑；
 * 生成物 catalog.gen.ts 不手改——catalog-sync.test.ts 离线重算比对，
 * 「改源不重生成」与「手改生成物」都会红。
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { buildModelCatalog, contentVersionOf } from '../src/ai/provider/catalog.js'

const catalog = buildModelCatalog()
const version = contentVersionOf(catalog)

const body = `/**
 * ⚠️ 自动生成文件——不要手改（npm run generate:catalog 产出）。
 *
 * 源头：src/ai/provider/model-quirks.ts（参数表唯一真相源）。
 * 双向校验：test/ai/provider/catalog-sync.test.ts 离线确定性重算——
 * 改 model-quirks.ts 后未重新生成、或手改本文件，比对失配即红。
 * contentVersion = 目录体内容哈希（SHA-256 前 16 位，不透明 token）：
 * 同内容 ⇒ 同版本，A7 表驱动入库的 seeder 以此做跳过依据。
 */
import type { ModelCatalog } from './catalog.js'

export const MODEL_CATALOG_VERSION = ${JSON.stringify(version)}

export const MODEL_CATALOG = ${JSON.stringify(catalog, null, 2)} satisfies ModelCatalog
`

// fileURLToPath 解码 ^ 等特殊字符（工作区路径含 ^ 时 URL 形态会 ENOENT，见 check-counts.mjs）
const dest = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'ai', 'provider', 'catalog.gen.ts')
writeFileSync(dest, body)
console.log(`catalog.gen.ts 已生成：contentVersion=${version}，${catalog.rows.length} 行`)
