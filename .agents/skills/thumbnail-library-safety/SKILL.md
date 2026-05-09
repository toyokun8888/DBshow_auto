---
name: thumbnail-library-safety
description: Use for Goal 4 thumbnail collection, scraping/API approval, retry limits, progress tables, local thumbnail paths, and Goal 5 localhost-only library page safety.
---

# Thumbnail And Local Library Safety

Use this skill for thumbnail collection and the local library page.

## Required context

Read these files before deciding:

1. `rules.md`
2. `goals.md`
3. `requirements_and_schedule.md`
4. `database.md`
5. `planned_sql.md`

## Thumbnail collection checks

- External APIs, scraping, and Google Cloud API use require explicit user approval for scope, credentials, and destination.
- Avoid mass access. Use rate limits, daily caps, retry caps, and backoff.
- Store progress, status, failure reason, retry count, and timestamps in DB.
- Do not retry forever.
- Prefer priority order from `goals.md`: owned works, wanted list, then remaining master data.
- Store local thumbnail file names and full local paths.
- Do not expose local paths or private data to external services unless explicitly approved.
- New DB objects must follow `xxx_`, `TM`, `TL`, and `VQ` naming rules.

## Local library page checks

- The page must be localhost-only unless the user explicitly approves otherwise.
- Avoid external telemetry, analytics, or third-party assets.
- Do not add new npm packages without prior approval.
- Opening files or folders from the browser must be designed with explicit local safety boundaries.

## Ambiguity rule

If API scope, scraping cadence, credential handling, DB table design, or localhost exposure is unclear, present at least two options and ask the user to choose.
