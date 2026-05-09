---
name: file-workflow-safety
description: Use for file moving, renaming, staging folders, mp4 detection, duplicate handling, dry-run design, DB registration after moves, and existing JavaScript file workflow changes.
---

# File Workflow Safety

Use this skill for file operation workflows in this project.

## Required context

Read these files before deciding:

1. `rules.md`
2. `goals.md`
3. `codebase.md`
4. `phase2_code_requirements.md`
5. `phase2_db_code_reconciliation.md`
6. `planned_sql.md`

## Safety workflow

1. Start with dry-run behavior.
2. Log planned file actions before real moves.
3. Do not touch non-`.mp4` files unless explicitly asked.
4. Do not move files that are still downloading or changing.
5. Do not rewrite or move already-registered owned files unless explicitly asked.
6. Preserve duplicate-looking files. Treat `(1)` and similar names as duplicate candidates, never as automatic delete targets.
7. If DB registration fails after a move, preserve enough log data for manual recovery.
8. Remove temporary `console.log` debugging before finalizing code.
9. Before any real move, resolve absolute source and destination paths and verify they are within the intended manually configured roots.
10. Never overwrite an existing destination file. Check destination existence and use collision-safe naming.
11. Treat cross-drive moves as copy-then-verify work. Deleting the original requires explicit confirmation at the cleanup step, even if the broader workflow was approved earlier.

## Matching and routing

- Product ID extraction must handle 6-digit and 7-digit IDs.
- Confirm the exact extraction regex before implementation. Do not assume only one filename pattern.
- Multiple candidate IDs must remain visible for manual review.
- No product ID or no DB match means unmatched flow, not forced registration.
- Matched owned files go to `xxx_TM002_owned_files`.
- Unmatched files go to the unmatched workflow and `xxx_TM005_unmatched_files` when DB tracking is needed.

## Ambiguity rule

If file path, rename format, matching rule, or move destination is unclear, present at least two options and ask the user to confirm.
