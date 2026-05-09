---
name: db-sql-reconciliation
description: Use for PostgreSQL schema design, planned_sql.md edits, database.md edits, DB/code reconciliation, table naming, indexes, dry-run logs, unmatched files, and owned file registration decisions.
---

# DB / SQL Reconciliation

Use this skill for DB and SQL work in the filedatachange project.

## Required context

Read these files before deciding:

1. `rules.md`
2. `database.md`
3. `planned_sql.md`
4. `phase2_code_requirements.md`
5. `phase2_db_code_reconciliation.md`
6. For major schema or scheduling decisions, also read `requirements_and_schedule.md`.

## Project-specific checks

- New tables and views must follow the `xxx_` prefix rule from `rules.md`.
- Master tables use `xxx_TM###_...`.
- Log tables use `xxx_TL###_...`.
- Views use `xxx_VQ###_...`.
- Do not use destructive SQL such as `DROP`, `TRUNCATE`, or removing existing columns.
- New SQL should be additive unless the user explicitly approves otherwise.
- For schema changes, include pre-check and post-check verification queries where practical.
- Keep `xxx_TM002_owned_files` for clean matched owned files.
- Put unmatched or manually-confirm-needed files in `xxx_TM005_unmatched_files` when relevant.
- Preserve dry-run behavior before real DB writes or file moves.
- Ensure DB logs and CSV logs can be reconciled through `run_id` and per-file status.

## Ambiguity rule

If schema, naming, or flow is uncertain, present at least two options and ask the user to confirm. Do not silently choose a destructive or irreversible direction.

## Output

Return:

- Confirmed compatible items.
- Required changes.
- Open questions, if any.
- Files that should be edited.
