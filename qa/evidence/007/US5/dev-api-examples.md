# US5 developer API examples

`GET /api/dashboard` (demo org, real API on :8788). Trimmed to `myWork` and `awaitingDecision`; the API returns the same `awaitingDecision` to every role (the UI gates the buttons), `myWork` is per caller.

## owner

Request: `GET /api/dashboard` -> 200

```json
{
  "myWork": [
    {
      "workspaceId": "8858d157-bce6-43f7-bd54-ae48776c5bfb",
      "tenderId": "ecf44194-0032-44c4-92b4-f38c1064ad8b",
      "bidNumber": "GEM/2026/B/6425094",
      "title": "Online UPS 10 kVA with 30 min battery backup",
      "stage": "submitted",
      "dueAt": "2026-10-23T06:30:00.000Z",
      "endAt": "2026-10-24T06:30:00.000Z",
      "readiness": {
        "percent": 100,
        "blockers": 0,
        "analysed": true
      }
    },
    {
      "workspaceId": "3e44141e-1779-4917-bb26-3a694f6360db",
      "tenderId": "882736ba-c994-4a59-823d-02c53b79e7af",
      "bidNumber": "GEM/2026/B/6433013",
      "title": "Laptop \u2013 Notebook (Q2), Core i7, 16 GB, 14\" FHD",
      "stage": "submitted",
      "dueAt": "2026-10-29T06:30:00.000Z",
      "endAt": "2026-10-30T06:30:00.000Z",
      "readiness": {
        "percent": 100,
        "blockers": 0,
        "analysed": true
      }
    },
    {
      "workspaceId": "608340f4-bddb-4a30-ab53-9414effd7d21",
      "tenderId": "e9d0ef3a-d60d-4d38-a28d-06c03fca6818",
      "bidNumber": "GEM/2026/B/6440932",
      "title": "Supply, Installation, Testing & Commissioning of CCTV Surveillance System",
      "stage": "submitted",
      "dueAt": "2026-11-01T06:30:00.000Z",
      "endAt": "2026-11-02T06:30:00.000Z",
      "readiness": {
        "percent": 100,
        "blockers": 0,
        "analysed": true
      }
    },
    {
      "workspaceId": "37a940fd-672b-4097-ace0-0febb63f2e98",
      "tenderId": "253cdd38-5b1f-4cce-be59-79f6ea8df5a8",
      "bidNumber": "GEM/2026/B/6488446",
      "title": "Multifunction Machine MFM (Q2) \u2013 A3 mono laser, 35 ppm, duplex",
      "stage": "analysing",
      "dueAt": "2026-11-07T04:30:00.000Z",
      "endAt": "2026-11-08T04:30:00.000Z",
      "readiness": {
        "percent": 100,
        "blockers": 0,
        "analysed": true
      }
    },
    {
      "workspaceId": "72c3aa8a-2a96-42fc-b180-b661ba7c6680",
      "tenderId": "91529d63-af6d-4f0a-9c2e-8e4f2ecd7894",
      "bidNumber": "GEM/2026/B/6512203",
      "title": "Interactive Flat Panel 75\" 4K with OPS module",
      "stage": "identified",
      "dueAt": "2026-11-09T14:30:00.000Z",
      "endAt": "2026-11-10T14:30:00.000Z",
      "readiness": {
        "percent": 100,
        "blockers": 0,
        "analysed": true
      }
    }
  ],
  "awaitingDecision": [
    {
      "workspaceId": "37a940fd-672b-4097-ace0-0febb63f2e98",
      "tenderId": "253cdd38-5b1f-4cce-be59-79f6ea8df5a8",
      "bidNumber": "GEM/2026/B/6488446",
      "title": "Multifunction Machine MFM (Q2) \u2013 A3 mono laser, 35 ppm, duplex",
      "score": 100,
      "verdict": "go",
      "endAt": "2026-11-08T04:30:00.000Z"
    },
    {
      "workspaceId": "b5ecbc31-cb1b-456a-8a9c-2a8d16711809",
      "tenderId": "6b6cca11-7427-40af-9229-d5908bdd3df4",
      "bidNumber": "GEM/2026/B/6535960",
      "title": "Rack Server \u2013 2 x Intel Xeon Silver, 256 GB RAM, 8 x 1.92 TB SSD",
      "score": 80,
      "verdict": "no_go",
      "endAt": "2026-11-13T06:30:00.000Z"
    }
  ]
}
```

## bid_manager

Request: `GET /api/dashboard` -> 200

```json
{
  "myWork": [
    {
      "workspaceId": "015e46a8-ff82-4d25-9b40-3f67a601f458",
      "tenderId": "92fe3f31-0982-425f-b3b7-50d753e31b18",
      "bidNumber": "GEM/2026/B/6504284",
      "title": "Next Generation Firewall (NGFW) \u2013 5 Gbps threat protection, 3-year subscription",
      "stage": "go",
      "dueAt": "2026-11-07T06:12:43.413Z",
      "endAt": "2026-11-09T20:30:00.000Z",
      "readiness": {
        "percent": 100,
        "blockers": 0,
        "analysed": true
      }
    },
    {
      "workspaceId": "696516d2-1888-4c90-b898-cbd97c62ea52",
      "tenderId": "572e54f7-27ba-47be-8907-007304afa87d",
      "bidNumber": "GEM/2026/B/6448851",
      "title": "Network Video Recorder \u2013 32 channel with 4 x 8 TB HDD",
      "stage": "ready",
      "dueAt": "2026-11-08T06:12:43.431Z",
      "endAt": "2026-11-05T11:12:00.000Z",
      "readiness": {
        "percent": 100,
        "blockers": 0,
        "analysed": true
      }
    }
  ],
  "awaitingDecision": [
    {
      "workspaceId": "37a940fd-672b-4097-ace0-0febb63f2e98",
      "tenderId": "253cdd38-5b1f-4cce-be59-79f6ea8df5a8",
      "bidNumber": "GEM/2026/B/6488446",
      "title": "Multifunction Machine MFM (Q2) \u2013 A3 mono laser, 35 ppm, duplex",
      "score": 100,
      "verdict": "go",
      "endAt": "2026-11-08T04:30:00.000Z"
    },
    {
      "workspaceId": "b5ecbc31-cb1b-456a-8a9c-2a8d16711809",
      "tenderId": "6b6cca11-7427-40af-9229-d5908bdd3df4",
      "bidNumber": "GEM/2026/B/6535960",
      "title": "Rack Server \u2013 2 x Intel Xeon Silver, 256 GB RAM, 8 x 1.92 TB SSD",
      "score": 80,
      "verdict": "no_go",
      "endAt": "2026-11-13T06:30:00.000Z"
    }
  ]
}
```

## analyst

Request: `GET /api/dashboard` -> 200

```json
{
  "myWork": [
    {
      "workspaceId": "3e2edfc5-1c19-46c4-a861-fab27ef11797",
      "tenderId": "2a203be0-388d-4afa-97ff-d64b217edc6c",
      "bidNumber": "GEM/2026/B/6472608",
      "title": "CCTV Camera \u2013 IP Bullet 4 MP with IR, PoE (MII compliant)",
      "stage": "preparing",
      "dueAt": "2026-11-03T06:12:43.363Z",
      "endAt": "2026-11-06T22:30:00.000Z",
      "readiness": {
        "percent": 100,
        "blockers": 0,
        "analysed": true
      }
    },
    {
      "workspaceId": "3493bd75-68b4-42f4-98fd-ba3cbc304ecf",
      "tenderId": "1403e898-35e0-4b86-a236-c116311f350f",
      "bidNumber": "GEM/2026/B/6464689",
      "title": "Desktop Computers (Q2) \u2013 Intel Core i5, 16 GB RAM, 512 GB SSD, 23.8\" monitor",
      "stage": "preparing",
      "dueAt": "2026-11-07T06:12:43.383Z",
      "endAt": "2026-11-06T08:30:00.000Z",
      "readiness": {
        "percent": 89,
        "blockers": 1,
        "analysed": true
      }
    },
    {
      "workspaceId": "11e0d568-b88c-455f-9ab3-8865995369b3",
      "tenderId": "bc785af3-8e57-4c65-9403-db2a0e30209c",
      "bidNumber": "GEM/2026/B/6480527",
      "title": "Wi-Fi 6 Access Point \u2013 Indoor, ceiling mount, controller based",
      "stage": "go",
      "dueAt": "2026-11-08T06:12:43.397Z",
      "endAt": "2026-11-07T10:30:00.000Z",
      "readiness": {
        "percent": 100,
        "blockers": 0,
        "analysed": true
      }
    }
  ],
  "awaitingDecision": [
    {
      "workspaceId": "37a940fd-672b-4097-ace0-0febb63f2e98",
      "tenderId": "253cdd38-5b1f-4cce-be59-79f6ea8df5a8",
      "bidNumber": "GEM/2026/B/6488446",
      "title": "Multifunction Machine MFM (Q2) \u2013 A3 mono laser, 35 ppm, duplex",
      "score": 100,
      "verdict": "go",
      "endAt": "2026-11-08T04:30:00.000Z"
    },
    {
      "workspaceId": "b5ecbc31-cb1b-456a-8a9c-2a8d16711809",
      "tenderId": "6b6cca11-7427-40af-9229-d5908bdd3df4",
      "bidNumber": "GEM/2026/B/6535960",
      "title": "Rack Server \u2013 2 x Intel Xeon Silver, 256 GB RAM, 8 x 1.92 TB SSD",
      "score": 80,
      "verdict": "no_go",
      "endAt": "2026-11-13T06:30:00.000Z"
    }
  ]
}
```

## viewer

Request: `GET /api/dashboard` -> 200

```json
{
  "myWork": [],
  "awaitingDecision": [
    {
      "workspaceId": "37a940fd-672b-4097-ace0-0febb63f2e98",
      "tenderId": "253cdd38-5b1f-4cce-be59-79f6ea8df5a8",
      "bidNumber": "GEM/2026/B/6488446",
      "title": "Multifunction Machine MFM (Q2) \u2013 A3 mono laser, 35 ppm, duplex",
      "score": 100,
      "verdict": "go",
      "endAt": "2026-11-08T04:30:00.000Z"
    },
    {
      "workspaceId": "b5ecbc31-cb1b-456a-8a9c-2a8d16711809",
      "tenderId": "6b6cca11-7427-40af-9229-d5908bdd3df4",
      "bidNumber": "GEM/2026/B/6535960",
      "title": "Rack Server \u2013 2 x Intel Xeon Silver, 256 GB RAM, 8 x 1.92 TB SSD",
      "score": 80,
      "verdict": "no_go",
      "endAt": "2026-11-13T06:30:00.000Z"
    }
  ]
}
```

