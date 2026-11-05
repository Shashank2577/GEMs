---
description: Reading a work item's acceptance criteria before the diff, splitting
  each Then/And into separate checks, and classing each as met, not met or
  cannot be verified. Use at the start of every review.
---

# Skill — reading acceptance criteria

## Criteria first, diff second

Open the work item and read the Gherkin before you open the diff. Write
down each `Given/When/Then` as a line you will have to mark met, not met,
or unverifiable.

The order matters more than it sounds. Read the diff first and you inherit
the author's frame: you end up checking whether the code does what the code
appears to be trying to do. That question always answers yes. The question
you were dispatched to answer is whether it does what the *work item* asked.

## Each `Then` is a separate claim

A criterion with three `And` clauses is four checks, not one:

```gherkin
Given issue #N labeled status:ready and a dispatch
When the dispatcher runs
Then a session starts with the compiled role pack, budget limits injected
And the issue moves to status:in-progress with a session-start comment
```

That is: a session starts · the role pack is compiled into it · budget
limits are injected · the label moves · a comment is posted. Five. Authors
routinely satisfy four and quietly drop the third.

## The three outcomes

**Met** — you can point at the specific thing. A line number, a command's
output, a screenshot. "The code does this" with no pointer is not met, it
is unverified.

**Not met** — you can say what is missing, concretely.

**Cannot be verified** — the change may well be correct, but nothing in the
PR lets you confirm it from outside. This is a rejection, not a pass. Say
what would have satisfied you: "AC 3 needs a live run; the PR has stub
fixtures only. A run link, or a recorded transcript, would close it."

Being unable to verify is not the author's fault by default — sometimes the
environment genuinely cannot support it, and they said so in a Gaps section.
That is a judgement call. An acknowledged gap with a stated reason is very
different from a silent one.

## Read the Gaps section carefully, and then adversarially

An honest Gaps section is a good sign and should be rewarded — the system
depends on authors writing them. But two failure modes hide there:

1. **A gap that is actually a failed criterion.** If a gap says "AC 2 is not
   met", the verdict is reject regardless of how gracefully it is written.
   Honesty about a miss is not a substitute for the miss.
2. **A criterion that is neither claimed nor in Gaps.** Cross off every
   criterion against either the Evidence or the Gaps section. Anything left
   unaccounted for is the most likely place a story quietly narrowed.

## Criteria you cannot test

If a criterion is untestable as written — no observable outcome, or it
depends on something that does not exist — do not invent a reading of it and
do not reject the author for it. Escalate: the criterion is the defect, and
the fix belongs on the work item, not in this PR.
