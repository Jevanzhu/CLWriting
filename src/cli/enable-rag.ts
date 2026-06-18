/**
 * `clwriting enable-rag` —— 启用 RAG 可选插件（M7 #37）。
 *
 * 写 book.yaml rag 非密段（enabled/endpoint/model）+ 引导 key 落 gitignore 区。
 * 红线 H1：api_key 绝不进 git（落 .clwriting/rag.secret 或环境变量）。
 */

import process from 'node:process'
import { resolveBookRoot, findWorkDir } from '../install/books.js'
import { enableRag, readApiKey } from '../rag/config.js'

/** `clwriting enable-rag` */
export function enableRagCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：clwriting enable-rag --endpoint URL --model NAME [--key KEY] [--use-env] [书目录]')
    console.log()
    console.log('启用 RAG 可选插件（外部 embedding + node:sqlite 向量库 + 纯 JS 召回）。')
    console.log()
    console.log('参数：')
    console.log('  --endpoint URL    embedding 端点（OpenAI 兼容）')
    console.log('  --model NAME      embedding 模型名')
    console.log('  --key KEY         api_key（落 .clwriting/rag.secret，绝不进 git）')
    console.log('  --use-env         不落文件，改用环境变量 CLWRITING_RAG_API_KEY')
    console.log()
    console.log('安全：api_key 只落 .clwriting/rag.secret（非 git）或环境变量，绝不写进 book.yaml。')
    return
  }

  const val = (flag: string): string | undefined => {
    const idx = args.indexOf(flag)
    return idx !== -1 ? args[idx + 1] : undefined
  }
  const endpoint = val('--endpoint')
  const model = val('--model')
  const key = val('--key')
  const useEnv = args.includes('--use-env')

  if (!endpoint || !model) {
    console.error('✗ 需要 --endpoint 和 --model（用 --help 看用法）')
    process.exit(1)
  }

  const r = resolveBookRoot(args)
  if (!r.ok) {
    console.error(`✗ ${r.reason}`)
    process.exit(1)
  }

  const workDir = findWorkDir(process.cwd())
  if (!workDir) {
    console.error('✗ 当前不在 CLWriting 工作目录（找不到 .clwriting/）。key 需落此处。')
    process.exit(1)
  }

  const result = enableRag(r.bookRoot, workDir, { endpoint, model, apiKey: useEnv ? undefined : key, useEnv })
  if (!result.ok) {
    console.error(`✗ ${result.reason}`)
    process.exit(1)
  }

  console.log(`✓ 已启用 RAG（写入 book.yaml rag 段）`)
  console.log(`  endpoint: ${endpoint}`)
  console.log(`  model: ${model}`)

  if (key && !useEnv) {
    console.log(`  key: 已存 .clwriting/rag.secret（gitignore 区，不进 git）`)
  } else if (useEnv) {
    console.log(`  key: 请设环境变量 CLWRITING_RAG_API_KEY`)
  }

  // 验证 key 可读
  const readable = readApiKey(workDir)
  if (!readable) {
    console.log(`  ⚠️ 暂未检测到 key（rag.secret 未存或环境变量未设），召回会降级回落精准读取`)
  }

  console.log()
  console.log('下一步：')
  console.log('  RAG 建索引随定稿增量更新（需宿主在写章编排层调 buildIndex）')
  console.log('  未启用 RAG 时主路径零影响（精准读取为主路径）')
}
