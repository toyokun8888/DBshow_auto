---
name: daily-master-update-safety
description: Use for Goal 2 daily master DB differential updates, acquisition staging, duplicate checks, incomplete-data quarantine, retries, scheduling, and non-destructive master data refresh design.
---

# Daily Master Update Safety

Use this skill for daily master data update work.

## Required context

Read these files before deciding:

1. `rules.md`
2. `goals.md`
3. `requirements_and_schedule.md`
4. `database.md`
5. `planned_sql.md`
6. `codebase.md`

## Safety checks

- Prefer local-only processing. External access or API use needs explicit approval for scope and destination.
- Treat the update as differential. Do not overwrite existing master records in bulk.
- Use staging or quarantine for incomplete, ambiguous, or malformed records.
- Check duplicates before insert.
- Preserve enough source, run, and error metadata for retry and audit.
- Use retry limits and backoff. Do not create infinite retry loops.
- Keep schedule behavior configurable and manually stoppable.
- New SQL should be additive unless the user explicitly approves otherwise.
- Do not use `DROP`, `TRUNCATE`, or existing-column deletion.

## Ambiguity rule

If the source, schedule, duplicate rule, or update policy is unclear, present at least two options and ask the user to choose.
