#!/usr/bin/env node
/**
 * 知识层 manifest 对账门（P2-29）——「CI 只相信正式知识层」落成门禁。
 *
 * 背景：src/knowledge/manifest.ts 的 validateKnowledgeManifest 已完整实现（target 路径
 * 安全 + sha256 与磁盘对账 + 重复检测 + 元数据校验），但全仓零调用方——注释宣称的
 * 「CI 只相信正式知识层」名存实亡（cc 评审 P2-29）。本脚本接线该校验为 CI 门：
 * 知识层/_manifest.json 与实际文件任一失配（改名漏登记 / 改内容漏更新 / 路径越界）即红。
 *
 * R62-53：补反向扫描（manifest→磁盘 之外再扫描 磁盘→manifest）——盘上 `.md` 文件
 * 未在 manifest 登记且非豁免的，告警红（防「往知识层丢个 .md 就以为进了 CI」漂移）。
 * 豁免白名单：文件名含「草稿」或为 README.md（D 类草稿/导航性文件不经版本化登记）。
 *
 * 用法：npm run check:knowledge（退出码 1 = 失配，并列出问题）
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateKnowledgeManifest, KNOWLEDGE_DIR, type KnowledgeManifest } from '../src/knowledge/manifest.js'

// 仓库根（工作区路径可能含 ^ 等特殊字符，fileURLToPath 解码，与 check-packaging 同口径）
const root = fileURLToPath(new URL('..', import.meta.url))

/** 递归收集 dir 下全部 .md 的绝对路径。
 *  R71-39（总七十一轮）：symlink→目录此前被 Dirent.isDirectory()（对 symlink 恒 false）
 *  静默跳过——目录内 .md 整树逃 R62-53 反向门（未登记可绕过 CI 登记）。处置取最小
 *  正确的 fail-closed 拒绝：知识层内出现指向目录的 symlink 即抛错（main 转
 *  console.error + exit(1)），作者改实体目录或删除后再跑；symlink→文件沿用 .md
 *  名字口径（未登记即 unmatched；越界登记由正向 isSafeKnowledgeTarget 挡）。 */
function collectMdFiles(dir: string): string[] {
  const out: string[] = []
  for (const en of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, en.name)
    if (en.isDirectory()) {
      out.push(...collectMdFiles(p))
    } else if (en.isSymbolicLink() && statSync(p).isDirectory()) {
      // 指向目录的 symlink：反向扫描无法保证其子树 .md 可见（且环路/越界不可判）——
      // fail-closed 拒绝；断链 symlink 的 statSync 抛错同样未捕获即非零退出
      throw new Error(`知识层内发现指向目录的 symlink：${p}（反向扫描 fail-closed：请改为实体目录或删除后重跑）`)
    } else if (en.name.endsWith('.md')) {
      out.push(p)
    }
  }
  return out
}

/**
 * R62-53 反向扫描：盘上 .md 未登记且非豁免 → 返回相对路径（项目根 → 知识层全树 .md）。
 * 豁免：文件名含「草稿」或为 README.md（草稿不经版本化、README 为导航性文件）。
 */
export function scanUnregisteredKnowledgeMd(
  projectRoot: string,
  manifestOrEntries: KnowledgeManifest | KnowledgeManifest['entries'] | undefined,
  rootDir: string = KNOWLEDGE_DIR
): string[] {
  const registered = new Set(
    (Array.isArray(manifestOrEntries) ? manifestOrEntries : (manifestOrEntries?.entries ?? [])).map((e) => e.target)
  )
  const knowledgeRoot = join(projectRoot, rootDir)
  if (!existsSync(knowledgeRoot)) return []
  const unmatched = []
  for (const fp of collectMdFiles(knowledgeRoot)) {
    const rel = relative(projectRoot, fp).split(sep).join('/')
    const base = fp.split(sep).pop() ?? ''
    const exempt = base.includes('草稿') || base === 'README.md'
    if (!registered.has(rel) && !exempt) unmatched.push(rel)
  }
  return unmatched
}

// 门禁主体收进 main() + 直跑守卫：npm run check:knowledge（node 直跑本文件）时执行；
// 被测试 import（R63-15 直测 scanUnregisteredKnowledgeMd）时不触发校验/exit 副作用
function main(): void {
  const report = validateKnowledgeManifest(root)
  if (!report.ok) {
    console.error('check:knowledge 失配（知识层 manifest 与磁盘不一致，修复后再提交）：')
    for (const issue of report.issues) console.error(`  - ${issue.path}: ${issue.message}`)
    process.exit(1)
  }

  const manifest = report.manifest
  // R71-39：反向扫描的 fail-closed 抛错（symlink→目录等）转人话报错 + 非零退出，
  // 不裸栈崩（脚本门禁口径与上方失配报告一致）
  let unidentified: string[] = []
  try {
    unidentified = scanUnregisteredKnowledgeMd(root, manifest)
  } catch (e) {
    console.error(`check:knowledge 反向扫描失败（${e instanceof Error ? e.message : String(e)}）`)
    process.exit(1)
  }
  if (unidentified.length > 0) {
    console.error('check:knowledge 反向扫描发现盘上未登记的 .md（非草稿/非 README，进 CI 需登记 manifest）：')
    for (const p of unidentified) console.error(`  - ${p}`)
    process.exit(1)
  }

  const count = manifest?.entries?.length ?? 0
  console.log(`check:knowledge 通过：知识层 ${count} 条 manifest 条目与磁盘一致；反向扫描无未登记 .md。`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()