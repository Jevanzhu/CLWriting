import { test, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import {
  checkRoleShellDrift,
  generateRoleShells,
  loadRoleDefinitions,
} from '../../src/roles/shells.js'

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'clwriting-roles-'))
  mkdirSync(join(root, '.clwriting', 'roles'), { recursive: true })
  writeFileSync(
    join(root, '.clwriting', 'roles', 'writer.md'),
    [
      '---',
      'id: writer',
      'name: 写稿角色',
      'description: 负责正文写作',
      'model: inherit',
      'tools: [Read, Grep]',
      '---',
      '',
      '## 职责',
      '',
      '按细纲写干净正文，不改账本。',
      '',
    ].join('\n'),
    'utf-8',
  )
  writeFileSync(
    join(root, '.clwriting', 'roles', 'reader-review.md'),
    [
      '---',
      'id: reader-review',
      'name: 读者审',
      'description: 检查爽点与追读牵引',
      'model: inherit',
      'tools: [Read]',
      '---',
      '',
      '每条问题必须带 evidence。',
      '',
    ].join('\n'),
    'utf-8',
  )
  return root
}

test('loadRoleDefinitions: 从 .clwriting/roles 读取平台无关角色源', () => {
  const root = makeProject()
  const loaded = loadRoleDefinitions(root)
  expect(loaded.ok).toBe(true)
  if (loaded.ok) {
    expect(loaded.roles.map((role) => role.id)).toEqual(['reader-review', 'writer'])
    expect(loaded.roles[1]!.tools).toEqual(['Read', 'Grep'])
    expect(loaded.roles[1]!.sourceHash).toMatch(/^sha256:/)
  }
  rmSync(root, { recursive: true, force: true })
})

test('generateRoleShells: 生成 Claude/Codex/通用壳与 manifest，drift check 通过', () => {
  const root = makeProject()
  const result = generateRoleShells({ projectRoot: root, now: '2026-06-18T00:00:00.000Z' })
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.manifest.outputs).toHaveLength(7) // Claude skill + 2 agents + Codex index + 2 agents + generic AGENTS
    expect(result.written).toContain('.clwriting/shells.manifest.json')
  }

  expect(existsSync(join(root, '.claude', 'SKILL.md'))).toBe(true)
  expect(existsSync(join(root, '.claude', 'agents', 'writer.md'))).toBe(true)
  expect(existsSync(join(root, '.codex', 'AGENTS.md'))).toBe(true)
  expect(existsSync(join(root, '.codex', 'agents', 'reader-review.md'))).toBe(true)
  expect(existsSync(join(root, 'AGENTS.md'))).toBe(true)
  expect(existsSync(join(root, '.clwriting', 'roles', 'roles.manifest.json'))).toBe(true)

  const claudeAgent = readFileSync(join(root, '.claude', 'agents', 'writer.md'), 'utf-8')
  expect(claudeAgent).toContain('source_hash: sha256:')
  expect(claudeAgent).toContain('按细纲写干净正文')

  const drift = checkRoleShellDrift(root)
  expect(drift.ok).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('checkRoleShellDrift: 角色源变化会报 source-drift', () => {
  const root = makeProject()
  generateRoleShells({ projectRoot: root })
  writeFileSync(join(root, '.clwriting', 'roles', 'writer.md'), '\n追加一条约束。\n', { flag: 'a' })

  const drift = checkRoleShellDrift(root)
  expect(drift.ok).toBe(false)
  expect(drift.issues.some((issue) => issue.kind === 'source-drift')).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('checkRoleShellDrift: 派生壳手改会报 output-drift', () => {
  const root = makeProject()
  generateRoleShells({ projectRoot: root })
  writeFileSync(join(root, '.claude', 'agents', 'writer.md'), '\n手工改壳。\n', { flag: 'a' })

  const drift = checkRoleShellDrift(root)
  expect(drift.ok).toBe(false)
  expect(drift.issues.some((issue) => issue.kind === 'output-drift' && issue.path === '.claude/agents/writer.md')).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('generateRoleShells: 拒绝覆盖非 CLWriting 生成的 AGENTS.md', () => {
  const root = makeProject()
  writeFileSync(join(root, 'AGENTS.md'), '# 手写指令\n', 'utf-8')

  const result = generateRoleShells({ projectRoot: root, platforms: ['generic'] })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.reason).toContain('拒绝覆盖非 CLWriting 生成文件')
  rmSync(root, { recursive: true, force: true })
})
