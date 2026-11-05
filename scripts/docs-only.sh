#!/usr/bin/env bash
# Reads changed paths (one per line) on stdin; prints "true" when every path is documentation only
# (specs/**, docs/**, any *.md) and none is QA evidence (qa/evidence/** always counts as code), else "false".
# An empty list prints "false" so CI errs on the side of running everything. Used by ci.yml and dod.yml (spec 008 FR-001).
set -euo pipefail
any=0
while IFS= read -r f || [ -n "$f" ]; do
  [ -z "$f" ] && continue
  any=1
  case "$f" in
    qa/evidence/*) echo false; exit 0 ;;
    specs/*|docs/*|*.md) ;;
    *) echo false; exit 0 ;;
  esac
done
if [ "$any" = 1 ]; then echo true; else echo false; fi
