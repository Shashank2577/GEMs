# 007/US3 developer API examples (real requests, trimmed; API on :8788, cookie auth)

## PATCH /api/org (bid_manager+) -> 200
```
PATCH /api/org  {"onboardingState":{"company":true,"categories":true}}
200 {"id":"d316ab4c-...","name":"Aarav Technologies","plan":"trial","onboardingState":{"company":true,"categories":true},"scoringWeights":null}
```

## Unknown key -> 400 (FR-048)
```
PATCH /api/org  {"onboardingState":{"bogus":true}}
400 {"error":{"code":"validation_error","message":"onboardingState: Unknown onboarding key: bogus",
  "details":{"fields":{"onboardingState":"Unknown onboarding key: bogus"}, ...}}}
```

## Analyst -> 403
```
PATCH /api/org  (analyst session)  {"onboardingState":{"company":true}}
403 {"error":{"code":"forbidden","message":"You need to be at least a Bid Manager to do that"}}
```

## Completion -> `onboarding.completed` activity (FR-052)
```
PATCH /api/org  {"onboardingState":{"completed":true}}   (sent twice)
200 {... "onboardingState":{"company":true,"completed":true,"categories":true} ...}

GET /api/activity   (one entry only, despite the repeat PATCH)
{"action":"onboarding.completed","entityType":"organization","entityId":"d316ab4c-...",
 "meta":{"durationSec":2},"user":{"name":"Aarav Shah"}}
```
