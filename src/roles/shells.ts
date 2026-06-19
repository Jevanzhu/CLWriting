/**
 * 角色单源 → 三平台壳生成器 —— 依据 M4 #21。
 *
 * 角色源放在 `.clwriting/roles/*.md`，壳是派生物。
 * 生成器写 `.clwriting/shells.manifest.json`，drift check 同时检查：
 * - 正向 drift：角色源变了但壳没重生
 * - 反向 drift：壳被手改了
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parseFlat, splitFrontMatter } from '../format/frontmatter.js'

export type ShellPlatform = 'claude' | 'codex' | 'generic'

export interface RoleDefinition {
  id: string
  name: string
  description: string
  model: string
  tools: string[]
  body: string
  sourcePath: string
  sourceRelPath: string
  sourceHash: string
}

export interface RoleSourceManifest {
  version: 1
  roles: { id: string; path: string; sha256: string }[]
}

export interface ShellManifest {
  version: 1
  generated_at: string
  outputs: ShellManifestOutput[]
  roles: { id: string; path: string; sha256: string }[]
}

export interface ShellManifestOutput {
  platform: ShellPlatform
  path: string
  kind: 'skill' | 'agent' | 'agents-index' | 'entry'
  role_id?: string
  source_hash: string
  output_hash: string
}

export type GenerateShellsResult =
  | { ok: true; manifest: ShellManifest; written: string[] }
  | { ok: false; reason: string }

export type DriftIssueKind =
  | 'manifest-missing'
  | 'source-missing'
  | 'source-drift'
  | 'output-missing'
  | 'output-drift'
  | 'output-malformed'

export interface DriftIssue {
  kind: DriftIssueKind
  path: string
  message: string
}

export interface DriftReport {
  ok: boolean
  issues: DriftIssue[]
}

const GENERATED_MARKER = '<!-- CLWriting generated file. Do not edit directly. -->'
const MANIFEST_FILE = '.clwriting/shells.manifest.json'
const ROLES_MANIFEST_FILE = '.clwriting/roles/roles.manifest.json'

/** 读取 `.clwriting/roles/*.md` 角色源。 */
export function loadRoleDefinitions(projectRoot: string): { ok: true; roles: RoleDefinition[] } | { ok: false; reason: string } {
  const rolesDir = join(projectRoot, '.clwriting', 'roles')
  if (!existsSync(rolesDir)) {
    return { ok: false, reason: '缺少 .clwriting/roles 角色源目录' }
  }

  const files = readdirSync(rolesDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('._'))
    .sort()
  if (files.length === 0) {
    return { ok: false, reason: '.clwriting/roles 下没有角色源文件' }
  }

  const roles: RoleDefinition[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const sourcePath = join(rolesDir, file)
    const raw = readFileSync(sourcePath, 'utf-8')
    const split = splitFrontMatter(raw)
    if (split === null) return { ok: false, reason: `${file} 缺少 front matter` }

    const fm = parseFlat(split.fmRaw)
    const id = String(fm.get('id') ?? '').trim()
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      return { ok: false, reason: `${file} 的 id 必须是小写英文/数字/短横线，并以英文开头` }
    }
    if (seen.has(id)) return { ok: false, reason: `角色 id 重复：${id}` }
    seen.add(id)

    // tools 必须用方括号语法 `tools: [Read, Write]`——parseValue 只认 [a,b] 为数组，
    // 裸逗号 `Read, Write` 会被当整体字符串致 tools 渲染成 none（M4 smoke P4）。
    const toolsRaw = fm.get('tools')
    if (toolsRaw !== undefined && !Array.isArray(toolsRaw)) {
      return { ok: false, reason: `${file} 的 tools 必须写成方括号数组，例如 tools: [Read, Write]` }
    }
    const tools = Array.isArray(toolsRaw) ? toolsRaw.map(String) : []
    roles.push({
      id,
      name: String(fm.get('name') ?? id),
      description: String(fm.get('description') ?? ''),
      model: String(fm.get('model') ?? 'inherit'),
      tools,
      body: split.body.trim(),
      sourcePath,
      sourceRelPath: normalizeRel(projectRoot, sourcePath),
      sourceHash: hashText(raw),
    })
  }

  return { ok: true, roles }
}

/** 生成角色壳，默认生成 Claude Code / Codex / 通用三套。 */
export function generateRoleShells(input: {
  projectRoot: string
  platforms?: ShellPlatform[]
  now?: string
}): GenerateShellsResult {
  const loaded = loadRoleDefinitions(input.projectRoot)
  if (!loaded.ok) return loaded

  const platforms = input.platforms ?? ['claude', 'codex', 'generic']
  const outputs = buildOutputs(input.projectRoot, loaded.roles, platforms)
  const written: string[] = []

  try {
    writeRoleSourceManifest(input.projectRoot, loaded.roles)
    written.push(ROLES_MANIFEST_FILE)

    for (const output of outputs) {
      writeManagedFile(join(input.projectRoot, output.path), output.content)
      written.push(output.path)
    }

    const manifest: ShellManifest = {
      version: 1,
      generated_at: input.now ?? new Date().toISOString(),
      roles: loaded.roles.map((r) => ({ id: r.id, path: r.sourceRelPath, sha256: r.sourceHash })),
      outputs: outputs.map((o) => ({
        platform: o.platform,
        path: o.path,
        kind: o.kind,
        ...(o.roleId ? { role_id: o.roleId } : {}),
        source_hash: o.sourceHash,
        output_hash: hashText(o.content),
      })),
    }
    writeFileSync(join(input.projectRoot, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf-8')
    written.push(MANIFEST_FILE)
    return { ok: true, manifest, written }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** 检查壳与角色源是否漂移。 */
export function checkRoleShellDrift(projectRoot: string): DriftReport {
  const manifestPath = join(projectRoot, MANIFEST_FILE)
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      issues: [{ kind: 'manifest-missing', path: MANIFEST_FILE, message: '缺少壳 manifest，请先生成角色壳' }],
    }
  }

  let manifest: ShellManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ShellManifest
  } catch {
    return {
      ok: false,
      issues: [{ kind: 'manifest-missing', path: MANIFEST_FILE, message: '壳 manifest 损坏，请重新生成角色壳' }],
    }
  }

  const loaded = loadRoleDefinitions(projectRoot)
  const currentRoles = new Map<string, RoleDefinition>()
  if (loaded.ok) {
    for (const role of loaded.roles) currentRoles.set(role.id, role)
  }

  const issues: DriftIssue[] = []
  for (const output of manifest.outputs) {
    const outputPath = join(projectRoot, output.path)
    const currentSourceHash = output.role_id
      ? currentRoles.get(output.role_id)?.sourceHash
      : aggregateSourceHash([...currentRoles.values()])

    if (currentSourceHash === undefined) {
      issues.push({
        kind: 'source-missing',
        path: output.path,
        message: `壳 ${output.path} 对应的角色源不存在`,
      })
    } else if (currentSourceHash !== output.source_hash) {
      issues.push({
        kind: 'source-drift',
        path: output.path,
        message: `角色源已变化，壳 ${output.path} 需要重生`,
      })
    }

    if (!existsSync(outputPath)) {
      issues.push({
        kind: 'output-missing',
        path: output.path,
        message: `派生壳缺失：${output.path}`,
      })
      continue
    }

    const outputText = readFileSync(outputPath, 'utf-8')
    if (output.role_id) {
      const malformed = validateRoleShellFormat(output, outputText)
      if (malformed) issues.push(malformed)
    }

    const currentOutputHash = hashText(outputText)
    if (currentOutputHash !== output.output_hash) {
      issues.push({
        kind: 'output-drift',
        path: output.path,
        message: `派生壳被手改：${output.path}；请改角色源后重生`,
      })
    }
  }

  return { ok: issues.length === 0, issues }
}

/** 部署可用性检测的一部分：角色壳格式必须能被宿主识别，且名称对得上要 spawn 的角色。 */
function validateRoleShellFormat(output: ShellManifestOutput, text: string): DriftIssue | null {
  if (output.role_id === undefined) return null

  if (output.platform === 'claude') {
    const split = splitFrontMatter(text)
    if (split === null) {
      return {
        kind: 'output-malformed',
        path: output.path,
        message: `Claude 角色壳缺少 front matter：${output.path}`,
      }
    }
    const fm = parseFlat(split.fmRaw)
    const name = String(fm.get('name') ?? '').trim()
    if (name !== output.role_id) {
      return {
        kind: 'output-malformed',
        path: output.path,
        message: `Claude 角色壳 name=${name || '空'}，但待 spawn 标识是 ${output.role_id}`,
      }
    }
  }

  if (output.platform === 'codex' && !text.includes(`- id: ${output.role_id}`)) {
    return {
      kind: 'output-malformed',
      path: output.path,
      message: `Codex 角色壳缺少匹配的 id：${output.role_id}`,
    }
  }

  return null
}

/** drift check 人话输出。 */
export function formatDriftReport(report: DriftReport): string {
  if (report.ok) return '✓ 角色壳与角色源一致，没有 drift。'
  return ['✗ 角色壳存在 drift：', ...report.issues.map((i) => `· ${i.message}`)].join('\n')
}

interface RenderedOutput {
  platform: ShellPlatform
  path: string
  kind: ShellManifestOutput['kind']
  roleId?: string
  sourceHash: string
  content: string
}

function buildOutputs(projectRoot: string, roles: RoleDefinition[], platforms: ShellPlatform[]): RenderedOutput[] {
  const outputs: RenderedOutput[] = []
  const aggregateHash = aggregateSourceHash(roles)

  for (const platform of platforms) {
    if (platform === 'claude') {
      outputs.push({
        platform,
        path: 'CLAUDE.md',
        kind: 'entry',
        sourceHash: aggregateHash,
        content: renderClaudeEntry(roles),
      })
      outputs.push({
        platform,
        path: '.claude/SKILL.md',
        kind: 'skill',
        sourceHash: aggregateHash,
        content: renderClaudeSkill(roles),
      })
      for (const role of roles) {
        outputs.push({
          platform,
          path: `.claude/agents/${role.id}.md`,
          kind: 'agent',
          roleId: role.id,
          sourceHash: role.sourceHash,
          content: renderClaudeAgent(role),
        })
      }
    } else if (platform === 'codex') {
      outputs.push({
        platform,
        path: '.codex/AGENTS.md',
        kind: 'agents-index',
        sourceHash: aggregateHash,
        content: renderCodexAgentsIndex(roles),
      })
      for (const role of roles) {
        outputs.push({
          platform,
          path: `.codex/agents/${role.id}.md`,
          kind: 'agent',
          roleId: role.id,
          sourceHash: role.sourceHash,
          content: renderCodexAgent(role),
        })
      }
    } else {
      outputs.push({
        platform,
        path: 'AGENTS.md',
        kind: 'agents-index',
        sourceHash: aggregateHash,
        content: renderGenericAgents(roles),
      })
    }
  }

  // 确保输出路径是项目内相对路径，防御未来参数扩展时路径穿越。
  for (const output of outputs) {
    const abs = join(projectRoot, output.path)
    if (normalizeRel(projectRoot, abs).startsWith('..')) throw new Error(`非法输出路径：${output.path}`)
  }
  return outputs
}

function renderClaudeEntry(roles: RoleDefinition[]): string {
  return [
    GENERATED_MARKER,
    '# CLWriting Claude Code',
    '',
    'This workspace uses CLWriting. Run `clwriting session-start` at session start for bounded context; if unavailable, run `clwriting enter`.',
    '',
    'Workflow details live in `.claude/SKILL.md`. Role shells live in `.claude/agents/*.md`.',
    '',
    '## Roles',
    '',
    ...roles.map((role) => `- ${role.id}: ${role.description || role.name}`),
    '',
  ].join('\n')
}

function renderClaudeSkill(roles: RoleDefinition[]): string {
  return [
    GENERATED_MARKER,
    '# CLWriting Write',
    '',
    'Use this skill to run the CLWriting eight-stage chapter workflow.',
    '',
    '## SessionStart',
    '',
    'On session start, run `clwriting session-start` for bounded AI context. If the host cannot run hooks, ask the author to run `clwriting enter` or run it manually before acting.',
    '',
    '## Workflow',
    '',
    '1. Read the SessionStart context or run `clwriting enter`, then follow the current route.',
    '2. Draft the outline with the outline role. Declare the chapter scene(s) in the outline front matter (e.g. `场景: 对话`, or multiple `场景: [战斗, 对话]`, matching the `文风/样章库/` scene names) so prepared style samples fit the chapter; then run `clwriting confirm <chapter>` after author approval.',
    '3. Prepare bounded context with CLWriting scripts and style samples (samples are selected by the outline `场景`; first declared scene is primary).',
    '4. Draft prose with the writer role; record each model call with the call-budget gate.',
    '5. Run `clwriting check`; red items must return to drafting.',
    '6. Run review roles according to the review tier; ledger verification must always run.',
    '7. Wait for the author verdict and write `工作区/审稿.md`.',
    '8. Run `clwriting finalize`.',
    '',
    '## Roles',
    '',
    ...roles.map((role) => `- \`${role.id}\`: ${role.description || role.name}`),
    '',
  ].join('\n')
}

function renderClaudeAgent(role: RoleDefinition): string {
  return [
    '---',
    `name: ${role.id}`,
    `description: ${role.description}`,
    `tools: ${role.tools.join(', ') || 'none'}`,
    `model: ${role.model}`,
    '---',
    '',
    GENERATED_MARKER,
    `<!-- source_hash: ${role.sourceHash} -->`,
    '',
    `# ${role.name}`,
    '',
    `Role id: ${role.id}`,
    '',
    role.body,
    '',
  ].join('\n')
}

function renderCodexAgentsIndex(roles: RoleDefinition[]): string {
  return [
    GENERATED_MARKER,
    '# CLWriting Codex Agents',
    '',
    'These role files are generated from `.clwriting/roles/*.md`.',
    'At session start, run `clwriting session-start` for bounded context; if unavailable, use `clwriting enter`.',
    '',
    ...roles.map((role) => `- ${role.id}: .codex/agents/${role.id}.md`),
    '',
  ].join('\n')
}

function renderCodexAgent(role: RoleDefinition): string {
  return [
    GENERATED_MARKER,
    `<!-- source_hash: ${role.sourceHash} -->`,
    '',
    `# ${role.name}`,
    '',
    `- id: ${role.id}`,
    `- model: ${role.model}`,
    `- tools: ${role.tools.join(', ') || 'none'}`,
    '',
    role.description,
    '',
    role.body,
    '',
  ].join('\n')
}

function renderGenericAgents(roles: RoleDefinition[]): string {
  const lines = [
    GENERATED_MARKER,
    '# CLWriting Agents',
    '',
    'Session start: run `clwriting session-start` for bounded AI context. Without hook support, run `clwriting enter` manually.',
    '',
  ]
  for (const role of roles) {
    lines.push(`## ${role.name}`, '', `id: ${role.id}`, `model: ${role.model}`, '', role.description, '', role.body, '')
  }
  return lines.join('\n')
}

function writeRoleSourceManifest(projectRoot: string, roles: RoleDefinition[]): void {
  const manifest: RoleSourceManifest = {
    version: 1,
    roles: roles.map((r) => ({ id: r.id, path: r.sourceRelPath, sha256: r.sourceHash })),
  }
  const target = join(projectRoot, ROLES_MANIFEST_FILE)
  mkdirSync(join(projectRoot, '.clwriting', 'roles'), { recursive: true })
  writeFileSync(target, JSON.stringify(manifest, null, 2), 'utf-8')
}

function writeManagedFile(filePath: string, content: string): void {
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8')
    if (!existing.includes(GENERATED_MARKER)) {
      throw new Error(`拒绝覆盖非 CLWriting 生成文件：${filePath}`)
    }
  }
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf-8')
}

function aggregateSourceHash(roles: RoleDefinition[]): string {
  return hashText(roles.map((role) => `${role.id}:${role.sourceHash}`).sort().join('\n'))
}

function hashText(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf-8').digest('hex')
}

function normalizeRel(root: string, target: string): string {
  return relative(root, target).replace(/\\/g, '/')
}
