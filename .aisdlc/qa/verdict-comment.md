## QA verdict — <APPROVED | REJECTED>

**Work item:** #<n> · **PR:** #<p> · **Reviewer:** qa (<harness>/<version>) · **Session:** <run URL>

### Acceptance criteria

| # | Criterion (quoted from the work item) | Verdict | Evidence |
|---|---|---|---|
| 1 | <quoted `Then` / `And` clause> | met | <command output, line ref, link> |
| 2 | <quoted clause> | **not met** | <what was observed instead> |
| 3 | <quoted clause> | **unverifiable** | <why, and what would have satisfied it> |

Every clause gets a row, including each `And`. A criterion absent from this
table is a criterion nobody checked.

### Findings

1. **<severity: blocking | major | minor | observation>** — <one line>.
   - Observed: `<command>` → <output>
   - Expected: <what the criterion requires>
   - Where: `<file>:<line>`

### Not checked

- <what this review did not cover, and why>

An approval covers what is in the table above. It is not a statement that
the change is free of defects.

### Bug issues filed

- #<n> — <title> (out of scope for this work item)

### Verdict

<`qa:approved` — every criterion met, evidence above.>
<`qa:rejected` — criteria <n, m> not met. Rejection <k> of 3 on this item.>

<!--
Rules:
- Comment first, then the label. A comment without a label is recoverable;
  a label without reasons is not.
- Exactly one of qa:approved / qa:rejected, and remove the other.
- "Approved with comments" is not a verdict. Findings that do not block go
  in Findings as observations, or into their own bug issues.
- Third rejection: address the human, not the developer. What is the
  pattern, and what would break it?
-->
