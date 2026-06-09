## Story Craft

This project uses story-craft for Chinese fiction workflows.

Project data is stored under `.story/`, while human-readable projections live at
`正文/`, `设定/`, `大纲/`, `追踪/`, and `审查报告/`.

Do not edit `.story/contracts/*.json` by hand unless the user explicitly asks.
Prefer the story-craft Skill flow and the internal CLI:

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" where
```

## Story Commands

Use `/story-init` to initialize or refresh deployment.

For short projects, continue with `/story-short-write`.
For long projects, continue with `/story-long-plan` and `/story-long-write`.

## Story Deployment

Deployment metadata is written to `.story/contracts/deployment.json`.

Managed Claude Code assets include story-craft agents, hooks, commands,
references, and settings hooks. User-only sections in `CLAUDE.md` should be
preserved by `merge_claude_md`.
