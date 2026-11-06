# GeM reality check — 2026-11-06T04:09:05.053Z

- Target: `https://bidplus.gem.gov.in`  ·  User-Agent: `TenderPilot/0.1 (+https://tenderpilot.in/bot; public BidPlus listings only)`
- Plan: 1 listing page(s), 5 bid document(s), ≤ 1 request / 1.5 s
- Node v22.22.3 on darwin

## 1. Listing (POST /all-bids-data)
- page 1: 10 raw docs, 46,464 open bids reported by GeM

### Raw fields GeM returned (frequency across all docs)
| field | in % of docs | sample value |
|---|---|---|
| `id` | 100% | "10135367" |
| `b_id` | 100% | [10135367] |
| `b_bid_number` | 100% | ["GEM/2026/R/765947"] |
| `b_category_name` | 100% | ["Hydraluic Press machine 80 TON with sensor as per specifications,Emb |
| `b_total_quantity` | 100% | [3] |
| `b_status` | 100% | [1] |
| `b_bid_type` | 100% | [2] |
| `b_is_bunch` | 100% | [3] |
| `b_type` | 100% | [0] |
| `b_bid_to_ra` | 100% | [1] |
| `b_buyer_status` | 100% | [0] |
| `b_eval_type` | 100% | [0] |
| `final_start_date_sort` | 100% | ["2026-11-07T10:00:00Z"] |
| `final_end_date_sort` | 100% | ["2026-11-09T10:00:00Z"] |
| `b_is_custom_item` | 100% | [1] |
| `b_bid_number_parent` | 100% | ["GEM/2026/B/7958327"] |
| `b_id_parent` | 100% | [9802953] |
| `is_high_value` | 100% | [false] |
| `b_ra_to_bid` | 100% | [1] |
| `ra_b_status` | 100% | [1] |
| `b_is_inactive` | 100% | [0] |
| `ra_b_buyer_status` | 100% | [2] |
| `b_cat_id` | 100% | ["home_univ_univ_univ_univ"] |
| `b.b_created_by` | 100% | ["teomeg_gem"] |
| `ba_is_single_packet` | 100% | [0] |
| `ba_is_global_tendering` | 100% | [0] |
| `ba_is_limited_tendering` | 100% | [0] |
| `is_rc_bid` | 100% | [0] |
| `ba_official_details_minName` | 100% | ["Ministry of Defence"] |
| `ba_official_details_deptName` | 100% | ["Department of Military Affairs"] |
| `bid_schedule` | 100% | [] |
| `parent_bid_schedule` | 100% | [] |
| `bd_category_name` | 90% | ["Hydraluic Press machine 80 TON with sensor as per specifications,Emb |
| `bd_details_is_boq` | 20% | [true] |
| `bd_details_new_boq` | 20% | [true] |

### What our parser could read (10 of 10 docs parsed)
| normalised field | filled | note |
|---|---|---|
| bidNumber | 10/10 (100%) |  |
| gemBidId | 10/10 (100%) |  |
| title | 10/10 (100%) |  |
| category | 10/10 (100%) |  |
| quantity | 10/10 (100%) |  |
| ministry | 10/10 (100%) |  |
| department | 10/10 (100%) |  |
| organisation | 0/10 (0%) | ⚠ never filled — field name or format differs from our assumption |
| buyerOffice | 0/10 (0%) | ⚠ never filled — field name or format differs from our assumption |
| state | 0/10 (0%) | ⚠ never filled — field name or format differs from our assumption |
| city | 0/10 (0%) | ⚠ never filled — field name or format differs from our assumption |
| startAt | 10/10 (100%) |  |
| endAt | 10/10 (100%) |  |
| emdAmount | 0/10 (0%) | ⚠ never filled — field name or format differs from our assumption |
| estimatedValue | 0/10 (0%) | ⚠ never filled — field name or format differs from our assumption |
| epbgPercent | 0/10 (0%) | ⚠ never filled — field name or format differs from our assumption |
| documentUrl | 10/10 (100%) |  |

### Dates (our assumption: GeM "…Z" timestamps are IST wall-clock times)
Now: 2026-11-06T04:09:06.642Z UTC = 2026-11-06T09:39:06.642 IST
| bid | raw start | raw end | parsed endAt (UTC) | endAt in IST | status |
|---|---|---|---|---|---|
| GEM/2026/R/765947 | 2026-11-07T10:00:00Z | 2026-11-09T10:00:00Z | 2026-11-09T04:30:00.000Z | 2026-11-09T10:00:00.000 | open |
| GEM/2026/R/765950 | 2026-11-07T10:00:00Z | 2026-11-09T10:00:00Z | 2026-11-09T04:30:00.000Z | 2026-11-09T10:00:00.000 | open |
| GEM/2026/R/765949 | 2026-11-07T10:00:00Z | 2026-11-09T10:00:00Z | 2026-11-09T04:30:00.000Z | 2026-11-09T10:00:00.000 | open |
| GEM/2026/R/765948 | 2026-11-07T10:00:00Z | 2026-11-09T10:00:00Z | 2026-11-09T04:30:00.000Z | 2026-11-09T10:00:00.000 | open |
| GEM/2026/R/765946 | 2026-11-07T10:00:00Z | 2026-11-09T10:00:00Z | 2026-11-09T04:30:00.000Z | 2026-11-09T10:00:00.000 | open |
| GEM/2026/R/765945 | 2026-11-07T10:00:00Z | 2026-11-09T10:00:00Z | 2026-11-09T04:30:00.000Z | 2026-11-09T10:00:00.000 | open |
Check one row against the same bid on the website: the end date/time shown there should equal the "endAt in IST" column.

## 2. Bid documents (route chosen per bid type: /showbidDocument, /showradocumentPdf, …) and our eligibility rules

### GEM/2026/R/765947 — Hydraluic Press machine 80 TON with sensor as per specifications + 8 more items
- saved `docs/GEM_2026_R_765947.pdf` (126 KB, 2 pages, 3,008 chars of text)
- our rules produced 8 requirement(s): bid_published_at×1, ministry×1, department×1, organisation×1, office×1, total_quantity×1, mse_exemption×1, startup_exemption×1
- ✅ every expected label that appears was extracted

### GEM/2026/R/765950 — Stitching and Tailoring Service - Cutting + Stitching + Tailoring + 2 more items
- saved `docs/GEM_2026_R_765950.pdf` (126 KB, 2 pages, 3,078 chars of text)
- our rules produced 9 requirement(s): bid_published_at×1, ministry×1, department×1, organisation×1, office×1, contract_period×1, turnover_min×1, mse_exemption×1, startup_exemption×1
- ✅ every expected label that appears was extracted

### GEM/2026/R/765949 — Chocolate + 9 more items
- saved `docs/GEM_2026_R_765949.pdf` (126 KB, 2 pages, 3,038 chars of text)
- our rules produced 9 requirement(s): bid_published_at×1, ministry×1, department×1, organisation×1, office×1, total_quantity×1, turnover_min×1, mse_exemption×1, startup_exemption×1
- ✅ every expected label that appears was extracted

### GEM/2026/R/765948 — N4220 000002 General Service Life Jacket Orally Inflated
- saved `docs/GEM_2026_R_765948.pdf` (126 KB, 2 pages, 2,856 chars of text)
- our rules produced 8 requirement(s): bid_published_at×1, ministry×1, department×1, organisation×1, office×1, total_quantity×1, mse_exemption×1, startup_exemption×1
- ✅ every expected label that appears was extracted

### GEM/2026/R/765946 — Fabrication and installation of Scaled Model of INS Vikrant
- saved `docs/GEM_2026_R_765946.pdf` (126 KB, 2 pages, 2,373 chars of text)
- our rules produced 9 requirement(s): bid_published_at×1, ministry×1, department×1, organisation×1, office×1, total_quantity×1, turnover_min×1, mse_exemption×1, startup_exemption×1
- ✅ every expected label that appears was extracted

## 3. Awarded bids (competitor intelligence, spec 003/US6)
- 10 awarded docs; fields: id, b_id, b_bid_number, b_category_name, b_total_quantity, b_status, b_bid_type, b_is_bunch, b_type, b_bid_to_ra, b_buyer_status, b_eval_type, final_start_date_sort, final_end_date_sort, bd_category_name, b_is_custom_item, b_bid_number_parent, b_id_parent, is_high_value, b_ra_to_bid, ra_b_status, b_is_inactive, ra_b_buyer_status, b_cat_id, b.b_created_by, ba_is_single_packet, ba_is_global_tendering, ba_is_limited_tendering, is_rc_bid, ba_official_details_minName, ba_official_details_deptName, bid_schedule, parent_bid_schedule, bd_details_is_boq, bd_details_new_boq

## Summary
- Listing reachable: **yes** · tenders parsed: **10/10**
- Bid documents fetched: **5/5** · possible extraction misses: **0**

Next: commit `fixtures/real-gem/2026-11-06T04-09-05` to a branch and tell me; I will fix the parser/rules against this real data and replace the synthetic fixtures.