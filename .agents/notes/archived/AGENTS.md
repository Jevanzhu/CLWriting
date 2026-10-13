# Archived Agent Notes

Sealed decision records. Every artifact here is frozen: never edit, reformat, translate,
repair, move, or delete one. `manifest.json` records a content hash per file and is
append-only, so any change to sealed bytes is rejected by
`scripts/harness/verify-archived-agent-notes.ts`.

Archiving a note is the only way files appear here:

1. Move the complete artifact set from `implemented/<class>/`.
2. Insert an identical `Archived: YYYY-MM-DD` line directly below `Status: implemented`
   in every language file.
3. Re-record any paired-content hashes.
4. Repair or remove inbound links.
5. Seal with `node scripts/harness/verify-archived-agent-notes.ts --write`.

Archive links are checked inbound only: links pointing into this tree are validated, but
links this tree makes to the outside are not, because they may be stale by design.
