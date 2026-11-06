# GeM reality check — 2026-11-06T03:40:20.547Z

- Target: `https://bidplus.gem.gov.in`  ·  User-Agent: `TenderPilot/0.1 (+https://tenderpilot.in/bot; public BidPlus listings only)`
- Plan: 3 listing page(s), 5 bid document(s), ≤ 1 request / 1.5 s
- Node v22.22.3 on darwin

## 1. Listing (POST /all-bids-data)
- page 1: 10 raw docs, 46,397 open bids reported by GeM
- page 2: 10 raw docs, 46,397 open bids reported by GeM
- page 3: 10 raw docs, 46,397 open bids reported by GeM

### Raw fields GeM returned (frequency across all docs)
| field | in % of docs | sample value |
|---|---|---|
| `id` | 100% | "10135244" |
| `b_id` | 100% | [10135244] |
| `b_bid_number` | 100% | ["GEM/2026/R/765922"] |
| `b_category_name` | 100% | ["LV7 TATA 033 000 1040 SOLENOID,LV7 TATA 2641 7270 0101 ASSY PADDING  |
| `b_total_quantity` | 100% | [408] |
| `b_status` | 100% | [1] |
| `b_bid_type` | 100% | [2] |
| `b_is_bunch` | 100% | [13] |
| `b_type` | 100% | [0] |
| `b_bid_to_ra` | 100% | [1] |
| `b_buyer_status` | 100% | [0] |
| `b_eval_type` | 100% | [0] |
| `final_start_date_sort` | 100% | ["2026-11-07T09:00:00Z"] |
| `final_end_date_sort` | 100% | ["2026-11-09T09:00:00Z"] |
| `b_is_custom_item` | 100% | [0] |
| `b_bid_number_parent` | 100% | ["GEM/2026/B/8185401"] |
| `b_id_parent` | 100% | [10063629] |
| `is_high_value` | 100% | [false] |
| `b_ra_to_bid` | 100% | [1] |
| `ra_b_status` | 100% | [1] |
| `b_is_inactive` | 100% | [0] |
| `ra_b_buyer_status` | 100% | [2] |
| `b_cat_id` | 100% | ["home_boq_boql_boql_boq"] |
| `b.b_created_by` | 100% | ["BUYER14@12ROU"] |
| `ba_is_single_packet` | 100% | [0] |
| `ba_is_global_tendering` | 100% | [0] |
| `ba_is_limited_tendering` | 100% | [0] |
| `is_rc_bid` | 100% | [0] |
| `ba_official_details_deptName` | 100% | ["Department of Military Affairs"] |
| `bid_schedule` | 100% | [] |
| `parent_bid_schedule` | 100% | [] |
| `bd_category_name` | 97% | ["LV7 TATA 033 000 1040 SOLENOID,LV7 TATA 2641 7270 0101 ASSY PADDING  |
| `ba_official_details_minName` | 93% | ["Ministry of Defence"] |
| `bd_details_is_boq` | 33% | [true] |
| `bd_details_new_boq` | 33% | [true] |

### What our parser could read (30 of 30 docs parsed)
| normalised field | filled | note |
|---|---|---|
| bidNumber | 30/30 (100%) |  |
| gemBidId | 30/30 (100%) |  |
| title | 30/30 (100%) |  |
| category | 30/30 (100%) |  |
| quantity | 30/30 (100%) |  |
| ministry | 28/30 (93%) |  |
| department | 30/30 (100%) |  |
| organisation | 0/30 (0%) | ⚠ never filled — field name or format differs from our assumption |
| buyerOffice | 0/30 (0%) | ⚠ never filled — field name or format differs from our assumption |
| state | 2/30 (7%) | sparse |
| city | 0/30 (0%) | ⚠ never filled — field name or format differs from our assumption |
| startAt | 30/30 (100%) |  |
| endAt | 30/30 (100%) |  |
| emdAmount | 0/30 (0%) | ⚠ never filled — field name or format differs from our assumption |
| estimatedValue | 0/30 (0%) | ⚠ never filled — field name or format differs from our assumption |
| epbgPercent | 0/30 (0%) | ⚠ never filled — field name or format differs from our assumption |
| documentUrl | 30/30 (100%) |  |

### Dates (our assumption: GeM "…Z" timestamps are IST wall-clock times)
Now: 2026-11-06T03:40:25.165Z UTC = 2026-11-06T09:10:25.165 IST
| bid | raw start | raw end | parsed endAt (UTC) | endAt in IST | status |
|---|---|---|---|---|---|
| GEM/2026/R/765922 | 2026-11-07T09:00:00Z | 2026-11-09T09:00:00Z | 2026-11-09T03:30:00.000Z | 2026-11-09T09:00:00.000 | open |
| GEM/2026/R/765921 | 2026-11-07T09:00:00Z | 2026-11-09T09:00:00Z | 2026-11-09T03:30:00.000Z | 2026-11-09T09:00:00.000 | open |
| GEM/2026/R/765923 | 2026-11-07T09:00:00Z | 2026-11-09T09:00:00Z | 2026-11-09T03:30:00.000Z | 2026-11-09T09:00:00.000 | open |
| GEM/2026/R/765924 | 2026-11-07T09:00:00Z | 2026-11-09T09:00:00Z | 2026-11-09T03:30:00.000Z | 2026-11-09T09:00:00.000 | open |
| GEM/2026/R/765931 | 2026-11-07T09:00:00Z | 2026-11-09T09:00:00Z | 2026-11-09T03:30:00.000Z | 2026-11-09T09:00:00.000 | open |
| GEM/2026/R/765930 | 2026-11-07T09:00:00Z | 2026-11-09T09:00:00Z | 2026-11-09T03:30:00.000Z | 2026-11-09T09:00:00.000 | open |
Check one row against the same bid on the website: the end date/time shown there should equal the "endAt in IST" column.

## 2. Bid documents (GET /showbidDocument/{id}) and our eligibility rules

### GEM/2026/R/765922 — LV7 TATA 033 000 1040 SOLENOID + 12 more items
- ❌ GeM did not return a PDF for this bid document

### GEM/2026/R/765921 — Anti-termites Valvi/Dimaka Nemotodes
- ❌ GeM did not return a PDF for this bid document

### GEM/2026/R/765923 — Interactive Display
- ❌ GeM did not return a PDF for this bid document

### GEM/2026/R/765924 — Composite Hollow Polymer Insulator To Drg No. 34780000466 Rev. 00 For 765kv Ct
- ❌ GeM did not return a PDF for this bid document

### GEM/2026/R/765931 — CLIMATE CONTROL SYSTEM + 4 more items
- ❌ GeM did not return a PDF for this bid document

## 3. Awarded bids (competitor intelligence, spec 003/US6)
- 10 awarded docs; fields: id, b_id, b_bid_number, b_category_name, b_total_quantity, b_status, b_bid_type, b_is_bunch, b_type, b_bid_to_ra, b_buyer_status, b_eval_type, final_start_date_sort, final_end_date_sort, bd_category_name, b_is_custom_item, b_bid_number_parent, b_id_parent, is_high_value, b_ra_to_bid, ra_b_status, b_is_inactive, ra_b_buyer_status, b_cat_id, b.b_created_by, ba_is_single_packet, ba_is_global_tendering, ba_is_limited_tendering, is_rc_bid, ba_official_details_minName, ba_official_details_deptName, bid_schedule, parent_bid_schedule, bd_details_is_boq, bd_details_new_boq

## Summary
- Listing reachable: **yes** · tenders parsed: **30/30**
- Bid documents fetched: **0/5** · possible extraction misses: **0**

Next: commit `fixtures/real-gem/2026-11-06T03-40-20` to a branch and tell me; I will fix the parser/rules against this real data and replace the synthetic fixtures.