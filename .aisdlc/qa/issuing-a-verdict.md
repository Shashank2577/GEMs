---
description: 'Recording a QA verdict: exactly one of qa:approved or qa:rejected,
  comment first and label second, a criteria table with evidence, specific
  actionable rejections, and filing out-of-scope bugs instead of blocking.
  Use whenever you are about to approve or reject a change.'
---

# Skill — issuing a verdict

## Exactly one label, always

```sh
# Approve
gh issue edit <n> --add-label qa:approved --remove-label qa:rejected

# Reject
gh issue edit <n> --add-label qa:rejected --remove-label qa:approved
```

Always remove the other one. An item carrying both is the state the
automation cannot interpret, and it will be treated as rejected.

The comment goes first, the label second. If the session dies between the
two, a comment with no label is a recoverable state; a label with no reasons
is a decision nobody can act on.

## The comment

`role-packs/qa/templates/verdict-comment.md`. The parts that matter:

- **A criteria table.** Every criterion from the work item, one row each,
  with met / not met / unverifiable and the evidence. This is the artifact —
  the traceability matrix and the client-facing report both read from it.
- **Findings**, ordered by severity, each with what was observed, the
  command that shows it, and what was expected.
- **What you did not check**, and why. Every review has a boundary. Stating
  it lets the next reader judge how much the verdict covers, and stops an
  approval being read as a guarantee it was never meant to be.

## Approving

Approve when every criterion is met and you have evidence for each. That
is the whole bar — not "no bugs found", which is unfalsifiable.

An approval still carries findings. Things that are out of scope for this
work item but real go into new bug issues, linked from the comment:

```sh
gh issue create --title "bug: <specific>" --label type:bug \
  --body "Found reviewing #<n> (PR #<p>). Repro: ...\nExpected: ...\nActual: ..."
```

Do not hold a story hostage to defects it was never asked to fix. File them
and approve.

## Rejecting

Reject when any criterion is not met, or cannot be verified.

Every rejection has to be actionable by a developer session with no memory
of this review. That means it names the criterion, quotes it, and shows the
specific observation:

> **AC 2 — not met.** The criterion reads *"Given the policy forbids pushing
> to main / Then no session can push to main (verified structurally by
> branch protection)"*. `role-packs/developer/tools.yaml` denies
> `git push origin main*`, but the compiler drops it —
> `build/developer/claude-code/UNMAPPABLE.md` lists it. `gh api
> .../branches/main/protection` returns `"enabled": false` for
> `required_status_checks`, so nothing structural is holding.
> **Expected:** either a protection rule that enforces it, or the criterion
> restated.

Never:
- "Needs more tests." Which behaviour, untested how?
- "Doesn't feel right." Not a finding.
- "Consider refactoring X." Not a rejection reason. That is a comment on an
  approval, or a separate issue.

Never reject for style, for a choice you would have made differently, or
for scope the work item already settled.

## The third rejection

The automation applies `needs-human` at three. When you are casting the
third, write for the human who is about to arrive, not for the developer:

- What is the pattern across all three rejections?
- Is the work item wrong — criteria contradictory, story too big, estimate
  off?
- What would break the loop? Name it.

Three rejections almost never means three unrelated mistakes. It usually
means the work item was wrong and everyone has been patching around it.
