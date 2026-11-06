# GeM reality check — 2026-11-06T10:38:48.357Z

- Target: `https://bidplus.gem.gov.in`  ·  User-Agent: `TenderPilot/0.1 (+https://tenderpilot.in/bot; public BidPlus listings only)`
- Plan: 1 listing page(s), 4 bid document(s), ≤ 1 request / 1.5 s
- Node v22.22.3 on darwin

## 1. Listing (POST /all-bids-data)
- page 1: 10 raw docs, 46,870 open bids reported by GeM

### Raw fields GeM returned (frequency across all docs)
| field | in % of docs | sample value |
|---|---|---|
| `id` | 100% | "10138459" |
| `b_id` | 100% | [10138459] |
| `b_bid_number` | 100% | ["GEM/2026/R/766334"] |
| `b_category_name` | 100% | ["649-SI0064 (Printing and supply of\" Serviceable\" tag Size: 90mm x  |
| `b_total_quantity` | 100% | [450000] |
| `b_status` | 100% | [1] |
| `b_bid_type` | 100% | [2] |
| `b_is_bunch` | 100% | [1] |
| `b_type` | 100% | [0] |
| `b_bid_to_ra` | 100% | [1] |
| `b_buyer_status` | 100% | [0] |
| `b_eval_type` | 100% | [0] |
| `final_start_date_sort` | 100% | ["2026-11-07T16:00:00Z"] |
| `final_end_date_sort` | 100% | ["2026-11-09T16:00:00Z"] |
| `b_is_custom_item` | 100% | [1] |
| `b_bid_number_parent` | 100% | ["GEM/2026/B/8046327"] |
| `b_id_parent` | 100% | [9904205] |
| `is_high_value` | 100% | [false] |
| `b_ra_to_bid` | 100% | [1] |
| `ra_b_status` | 100% | [1] |
| `b_is_inactive` | 100% | [0] |
| `ra_b_buyer_status` | 100% | [2] |
| `b_cat_id` | 100% | ["home_univ_univ_univ_univ"] |
| `b.b_created_by` | 100% | ["buyer278.halh.or@gembuyer.in"] |
| `ba_is_single_packet` | 100% | [0] |
| `ba_is_global_tendering` | 100% | [0] |
| `ba_is_limited_tendering` | 100% | [0] |
| `is_rc_bid` | 100% | [0] |
| `ba_official_details_deptName` | 100% | ["Department of Defence Production"] |
| `bid_schedule` | 100% | [] |
| `parent_bid_schedule` | 100% | [] |
| `bd_category_name` | 90% | ["649-SI0064 (Printing and supply of\" Serviceable\" tag Size: 90mm x  |
| `ba_official_details_minName` | 90% | ["Ministry of Defence"] |
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
| ministry | 9/10 (90%) |  |
| department | 10/10 (100%) |  |
| organisation | 0/10 (0%) | ⚠ never filled — field name or format differs from our assumption |
| buyerOffice | 0/10 (0%) | ⚠ never filled — field name or format differs from our assumption |
| state | 1/10 (10%) | sparse |
| city | 0/10 (0%) | ⚠ never filled — field name or format differs from our assumption |
| startAt | 10/10 (100%) |  |
| endAt | 10/10 (100%) |  |
| emdAmount | 0/10 (0%) | ⚠ never filled — field name or format differs from our assumption |
| estimatedValue | 0/10 (0%) | ⚠ never filled — field name or format differs from our assumption |
| epbgPercent | 0/10 (0%) | ⚠ never filled — field name or format differs from our assumption |
| documentUrl | 10/10 (100%) |  |

### Dates (our assumption: GeM "…Z" timestamps are IST wall-clock times)
Now: 2026-11-06T10:38:51.133Z UTC = 2026-11-06T16:08:51.133 IST
| bid | raw start | raw end | parsed endAt (UTC) | endAt in IST | status |
|---|---|---|---|---|---|
| GEM/2026/R/766334 | 2026-11-07T16:00:00Z | 2026-11-09T16:00:00Z | 2026-11-09T10:30:00.000Z | 2026-11-09T16:00:00.000 | open |
| GEM/2026/R/766359 | 2026-11-07T16:00:00Z | 2026-11-09T16:00:00Z | 2026-11-09T10:30:00.000Z | 2026-11-09T16:00:00.000 | open |
| GEM/2026/R/766358 | 2026-11-07T16:00:00Z | 2026-11-09T16:00:00Z | 2026-11-09T10:30:00.000Z | 2026-11-09T16:00:00.000 | open |
| GEM/2026/R/766356 | 2026-11-07T16:00:00Z | 2026-11-09T16:00:00Z | 2026-11-09T10:30:00.000Z | 2026-11-09T16:00:00.000 | open |
| GEM/2026/R/766355 | 2026-11-07T16:00:00Z | 2026-11-11T16:00:00Z | 2026-11-11T10:30:00.000Z | 2026-11-11T16:00:00.000 | open |
| GEM/2026/R/766354 | 2026-11-07T16:00:00Z | 2026-11-09T16:00:00Z | 2026-11-09T10:30:00.000Z | 2026-11-09T16:00:00.000 | open |
Check one row against the same bid on the website: the end date/time shown there should equal the "endAt in IST" column.

## 2. Bid documents (route chosen per bid type: /showbidDocument, /showradocumentPdf, …) and our eligibility rules

### GEM/2026/R/766334 — 649-SI0064 (Printing and supply of" Serviceable" tag Size: 90mm x 140 mm)
- reverse auction → following parent bid GEM/2026/B/8046327 (https://bidplus.gem.gov.in/showbidDocument/9904205)
- saved `docs/GEM_2026_R_766334.pdf` (106 KB, 8 pages, 19,521 chars of text)
- our rules produced 19 requirement(s): bid_end×1, bid_opening×1, offer_validity×1, ministry×1, department×1, organisation×1, office×1, total_quantity×1, mse_exemption×1, startup_exemption×1, bid_published_at×1, bid_to_ra×1, bid_type×1, evaluation_method×1, mii×1, mse_purchase_preference×1, delivery_days×1, document×2
- Possible misses (label present in the PDF, requirement not extracted):
  - ❌ **EMD amount** is in the document but rule `emd` found nothing. Context: “…Clause No /Mediation Clause No    /Bid Details     /EMD Detail P /Required No 2 / 8   /ePBG Detail P /Required No   > / Bid splitting not applied.     /MII Purchase Preference   /MII Purchase Preference No     /MSE Purchase Preference   /MSE Purchase Prefe…”
  - ❌ **ePBG percentage** is in the document but rule `epbg` found nothing. Context: “…/Bid Details     /EMD Detail P /Required No 2 / 8   /ePBG Detail P /Required No   > / Bid splitting not applied.     /MII Purchase Preference   /MII Purchase Preference No     /MSE Purchase Preference   /MSE Purchase Preference Yes ^ ` % / 5  * 5 , > V L1+X%…”
  - ❌ **OEM authorisation** is in the document but rule `oem_auth` found nothing. Context: “… Purchase preference, the bidder must be the manufacturer / OEM of the offered product on GeM. In respect of bid for Services, the bidder must be the Service provider of the offered Service. Traders are excluded from the purview of Public Procurement Policy for Micro and Small En…”

### GEM/2026/R/766359 — Mackeral + 9 more items
- reverse auction → following parent bid GEM/2026/B/7958542 (https://bidplus.gem.gov.in/showbidDocument/9803209)
- saved `docs/GEM_2026_R_766359.pdf` (160 KB, 14 pages, 33,622 chars of text)
- our rules produced 32 requirement(s): bid_end×1, bid_opening×1, offer_validity×1, ministry×1, department×1, organisation×1, office×1, total_quantity×1, turnover_min×1, oem_turnover×1, bid_published_at×1, experience_years×1, mse_exemption×1, startup_exemption×1, past_performance×1, bid_to_ra×1, bid_type×1, evaluation_method×1, emd×1, epbg×1, epbg_duration×1, mii×1, mse_purchase_preference×1, delivery_days×1, document×6, certificate×1, consignee_state×1
- Possible misses (label present in the PDF, requirement not extracted):
  - ❌ **Estimated bid value** is in the document but rule `estimated_value` found nothing. Context: “…proved by Buyer after evaluation of documents submitted. 9. Estimated Bid Value indicated above is being declared solely for the purpose of guidance on EMD amount and for determining the Eligibility Criteria related to Turn Over, Past Performance and Project / Past Experience etc…”
  - ❌ **OEM authorisation** is in the document but rule `oem_auth` found nothing. Context: “…f the bidder (For 3 Years) 27 Lakh (s) % % % % (( 33 > > ))/OEM Average Turnover (Last 3 Years) 27 Lakh (s)  @ /Bid Number: GEM/2026/B/7958542 A /Dated: 22-09-2026   ' ' / Bid Document 1 / 14 :  : / -I -I   % %/Years of Past Experience Required for same/similar service 3 Y…”

### GEM/2026/R/766358 — Electrometer with Resistivity Test fixture + 1 more item
- reverse auction → following parent bid GEM/2026/B/7872292 (https://bidplus.gem.gov.in/showbidDocument/9704409)
- saved `docs/GEM_2026_R_766358.pdf` (115 KB, 9 pages, 23,230 chars of text)
- our rules produced 19 requirement(s): bid_end×1, bid_opening×1, offer_validity×1, ministry×1, department×1, organisation×1, office×1, total_quantity×1, bid_published_at×1, bid_to_ra×1, bid_type×1, evaluation_method×1, emd×1, epbg×1, epbg_duration×1, mii×1, mse_purchase_preference×1, document×2
- Possible misses (label present in the PDF, requirement not extracted):
  - ❌ **OEM authorisation** is in the document but rule `oem_auth` found nothing. Context: “…y and technical specifications. If the bidder itself is MSE OEM of the offered products, it would be relaxed from the "OEM Average Turnover" criteria also subject to meeting of quality and technical specifications. The bidder seeking Relaxation from Turnover, shall upload the sup…”

### GEM/2026/R/766356 — Fruit - Chickoos Kalipati + 40 more items
- reverse auction → following parent bid GEM/2026/B/7994135 (https://bidplus.gem.gov.in/showbidDocument/9844145)
- ❌ GeM unreachable: document download timed out  (tried https://bidplus.gem.gov.in/showbidDocument/9844145)
- probe: {"probeError":"terminated"}

## 3. Awarded bids (competitor intelligence, spec 003/US6)
- 10 awarded docs; fields: id, b_id, b_bid_number, b_category_name, b_total_quantity, b_status, b_bid_type, b_is_bunch, b_type, b_bid_to_ra, b_buyer_status, b_eval_type, final_start_date_sort, final_end_date_sort, bd_category_name, b_is_custom_item, b_bid_number_parent, b_id_parent, is_high_value, b_ra_to_bid, ra_b_status, b_is_inactive, ra_b_buyer_status, b_cat_id, b.b_created_by, ba_is_single_packet, ba_is_global_tendering, ba_is_limited_tendering, is_rc_bid, ba_official_details_deptName, bid_schedule, parent_bid_schedule, ba_official_details_minName, bd_details_is_boq, bd_details_new_boq

## Summary
- Listing reachable: **yes** · tenders parsed: **10/10**
- Bid documents fetched: **3/4** · possible extraction misses: **6**

Next: commit `fixtures/real-gem/2026-11-06T10-38-48` to a branch and tell me; I will fix the parser/rules against this real data and replace the synthetic fixtures.