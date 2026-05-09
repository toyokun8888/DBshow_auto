---
name: project-rules-gate
description: Use at the start of any filedatachange project task, especially code, SQL, DB design, file operations, dependency changes, or ambiguous decisions. Ensures rules.md is read and applied before work proceeds.
---

# Project Rules Gate

Use this skill before work that affects this project.

## Required steps

1. Read `rules.md` first.
2. Treat `rules.md` as the project charter and highest-priority local rule source.
3. Check the request against these mandatory rules:
   - Do not add external npm packages without prior user approval.
   - Do not perform or propose destructive DB operations such as `DROP`, `TRUNCATE`, or deleting existing columns.
   - Do not leave `console.log` debug output in final implementation.
   - Do not automatically delete duplicate-looking files such as files with `(1)` in the name.
   - Prefer local-only behavior and avoid external API transmission unless explicitly approved.
   - Respect existing auto-classification core logic unless the user explicitly asks to change it.
   - New DB tables and views must start with `xxx_`.
   - Master tables use `xxx_TM###_...`, log tables use `xxx_TL###_...`, and views use `xxx_VQ###_...`.
4. If the request is ambiguous, do not decide from guesswork. Present at least two options and ask the user to choose.
5. State briefly which rule affected the plan before making edits.

## Output

When this skill is used, include a short note in the final response that `rules.md` was checked.
