# Conventions

Process adapted from [ai-sdlc](https://github.com/Shashank2577/ai-sdlc) (MIT), used here for **review and QA only**.
Specs and tasks follow the cairn spec workflow (`.cairn/workflow`, `/cairn-*` skills); code review uses the
`cairn-reviewer` agent.

## Tickets
Every user story and every open task in `specs/*/tasks.md` is a GitHub issue in this repo
(`/cairn-taskstoissues`). Labels: `type:story|task|bug`, `area:<area>`, `spec:<nnn>`, `priority:P1..P3`,
`role:developer|qa`, `status:ready|in-progress|in-review|blocked`, `qa:approved|qa:rejected`.

## Commit trailers
```
Work-Item: Shashank2577/GEMs#<issue>
Requirement: <spec>/FR-0XX[, ...]
Agent-Role: <architect|developer|qa|reviewer|techwriter|human>
Harness: claude-code
```

## Definition of Done (per story)
1. Code + unit/API tests pass (`pnpm typecheck && pnpm test`).
2. `cairn-reviewer` review recorded on the issue, no blocking findings open.
3. QA verdict per `.aisdlc/qa/verdict-comment.md`: every acceptance criterion `met` with evidence
   (Playwright run, screenshots, video, trace) stored in `qa/evidence/<spec>/<story>/` and linked from the issue.
4. Exactly one of `qa:approved` / `qa:rejected`; `qa:rejected` blocks closing the issue.
