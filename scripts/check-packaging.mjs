#!/usr/bin/env node
/**
 * CC-P1-7 打包资源门——resources/ 必须进 asar + 捆绑资源自洽。
 *
 * 背景：electron-builder files 长期只含 dist（通配），resources/（内置 prompt/技巧包）
 * 缺席时打包态 resourcesRoot() 必抛错、AI 链路全挂——dev 形态无此问题，只有打包
 * 冒烟才能暴露（cc 轮评审 P1-7）。真打包校验（asar 清单 + 解包冒烟）靠发布前
 * build:desktop:dir 手动跑；本门做两层廉价的静态防回潮，CI 每跑必核：
 *   1. package.json files 数组必须含 dist 与 resources（P3 修复：原正则按两空格
 *      缩进 + 精确通配文本锚定 electron-builder.yml，格式微调即静默失效——改为
 *      JSON.parse 后直接断言，顺序/格式无关）
 *   2. resources/prompts/versions.json 与实际 .md 文件互相对账（改名单不改表即红）
 *
 * 用法：npm run check:packaging（退出码 1 = 失配，并列出问题）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// fileURLToPath 解码百分号编码（工作区路径含 ^ 时 pathname 会带 %5E，scandir 直接 ENOENT）
const root = fileURLToPath(new URL('..', import.meta.url))
const problems = []

// ── 1. package.json：files 数组必须含 dist 与 resources（P3：正则 → JSON.parse）──
// 导出纯函数供 test/desktop/check-packaging.test.ts 直测断言口径（脚本本体只在
// 直跑时执行校验/退出，import 不产生副作用）。
export function problemsForPackageFiles(files) {
  const found = []
  if (!Array.isArray(files)) {
    found.push('package.json files 不是数组——npm 打包内容清单没了/形状变了')
    return found
  }
  // 直接断言成员资格（顺序/缩进无关；成员允许带 /**/* 等通配后缀——同一目录的
  // 不同写法均算覆盖，格式微调不再静默失效）
  for (const need of ['dist', 'resources']) {
    const covers = (entry) => entry === need || entry.startsWith(need + '/')
    if (!files.some((entry) => typeof entry === 'string' && covers(entry))) {
      found.push(`package.json files 未包含 ${need}——npm 打包内容缺整目录（CC-P1-7 回潮）`)
    }
  }
  return found
}

function checkPackaging() {
  const pkgPath = join(root, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (e) {
    problems.push(`package.json 不可读/不是合法 JSON：${e.message}`)
  }
  if (pkg) problems.push(...problemsForPackageFiles(pkg.files))

  // ── 2. 捆绑资源自洽：versions.json ↔ 实际 .md 双向对账 ────────────────────
  const promptsDir = join(root, 'resources', 'prompts')
  const skillsDir = join(root, 'resources', 'skills')
  for (const dir of [promptsDir, skillsDir]) {
    if (!existsSync(dir)) problems.push(`捆绑资源目录缺失：${dir}`)
  }
  if (existsSync(promptsDir)) {
    const versionsPath = join(promptsDir, 'versions.json')
    if (!existsSync(versionsPath)) {
      problems.push('缺 resources/prompts/versions.json——prompt 版本表没了')
    } else {
      let versions
      try {
        versions = JSON.parse(readFileSync(versionsPath, 'utf8'))
      } catch (e) {
        problems.push(`versions.json 不是合法 JSON：${e.message}`)
      }
      if (versions) {
        // 表里有名、盘上无文件 → 运行期 readBuiltin 直接 throw
        for (const name of Object.keys(versions)) {
          if (!existsSync(join(promptsDir, name))) {
            problems.push(`versions.json 登记 ${name}，但 resources/prompts/ 下无此文件`)
          }
        }
        // 盘上有文件、表里无名 → 该 prompt 永远走不到版本化链路（静默漂移）
        const listed = new Set(Object.keys(versions))
        for (const f of readdirSync(promptsDir)) {
          if (f.endsWith('.md') && !listed.has(f)) {
            problems.push(`resources/prompts/${f} 存在但 versions.json 未登记`)
          }
        }
      }
    }
  }
  if (existsSync(skillsDir)) {
    const skillFiles = readdirSync(skillsDir).filter((f) => f.endsWith('.md'))
    if (skillFiles.length === 0) problems.push('resources/skills/ 下无任何 .md 技巧包')
  }

  if (problems.length > 0) {
    console.error('check:packaging 失配（打包资源防回潮门，修复后再提交）：')
    for (const p of problems) console.error('  - ' + p)
    process.exit(1)
  }
  console.log('check:packaging 通过：resources/ 已入打包清单，prompt 版本表与文件对账一致。')
}

// 直跑才执行校验（import 侧只拿纯函数，测试不触发 process.exit）
const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (invoked) checkPackaging()
