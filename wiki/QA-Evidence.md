# QA Evidence

All QA artefacts are committed under [`qa/evidence/`](https://github.com/Shashank2577/GEMs/tree/main/qa/evidence):

```
qa/evidence/<spec>/<story>/
  VERDICT.md            ai-sdlc verdict: criterion → met/not met/unverifiable → evidence
  *.png                 named screenshots per acceptance criterion (desktop + mobile)
  *.webm                full video of each E2E test
```

Run them yourself: `scripts/local-pg.sh && pnpm exec playwright test e2e/<spec>` (HTML report in `qa/.runs/<port>/report`).

| Spec | Story | Verdict |
|---|---|---|
| 000 | Smoke (signup → demo → dashboard → feed) | passing — `qa/evidence/000-smoke/smoke/` |
