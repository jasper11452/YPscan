# Requirement compiler evaluation

Date: 2026-08-15

## Dataset

The customer-provided local CSV was read in place and was not copied into the repository. It contains 248 non-empty rows and 228 unique briefs. A quote-aware CSV reader was used because most briefs span multiple physical lines.

Observed coverage among the 228 unique briefs:

| Signal                                   | Briefs |
| ---------------------------------------- | -----: |
| Price / budget                           |    208 |
| Content / creator type / persona / scene |    201 |
| Creator or submission/cooperation count  |    167 |
| Deadline / schedule                      |    128 |
| Multi-tier or multi-group wording        |     89 |
| Follower threshold                       |     86 |
| Rebate                                   |     62 |
| Performance metrics                      |     48 |
| Reference account/link                   |     33 |
| Audience demographics                    |     32 |

Twenty-four evenly distributed unique briefs were manually inspected for recurring failure modes. Regression tests use synthetic equivalents rather than retaining customer text.

## Post-change result

- Requirement compiler tests: 21/21 passed.
- Common mixed-unit evidence forms covered: `2-3w`, `5000-1万`, `10万+`, `30%+`, `3k-1w`.
- Finite Provider mapping test covers the currently published search fields for prices, CPM/CPE, followers, audience shares, performance ranges, label arrays, organization, recent-order/content flags, IP dependency, and URL keyword.
- Adversarial tests cover total-budget/unit-price confusion, audience/creator confusion, negation, prompt injection, hard conflicts, soft preferences, cooperation/submission count separation, and multi-group count isolation.

Scores:

| Dimension                         |      Score | Notes                                                                                                         |
| --------------------------------- | ---------: | ------------------------------------------------------------------------------------------------------------- |
| Provider field alignment          |      23/25 | Static reviewed field map; no runtime capability endpoint. Label value vocabulary is still Provider-owned.    |
| Semantic safety                   |      22/25 | High-cost confusions fail closed; unsupported wording is preserved instead of guessed.                        |
| Chinese numeric/count handling    |      18/20 | Common mixed units and count roles covered; highly irregular prose still depends on correct Agent extraction. |
| Multi-group and residual handling |      18/20 | Independent jobs and counts; soft/unsupported conditions remain structured residuals.                         |
| Simplicity and operability        |       9/10 | No demand hash or coverage gate; execution params are hidden until ready.                                     |
| Deterministic compiler total      | **90/100** | Up from the previous 45/100 assessment.                                                                       |

End-to-end Agent-plus-compiler accuracy is provisionally **82/100**, not 90/100. The compiler is deterministic, but this repository has no batch model runner to measure whether the Agent extracts every fact correctly from all 228 unique briefs. Claiming 90% end-to-end accuracy would therefore be unsupported.

## Remaining risks and next optimization

1. Build a de-identified gold set of 40-60 briefs with expected facts, segments, Provider filters, and residuals, then run the actual production Agent prompt against it.
2. Calibrate the finite label value vocabulary offline from Provider documentation or an approved export. Do not add a runtime read-only capability probe.
3. Add focused gold cases for relative dates, ratio-based content-form allocation, nested category/price/count tiers, and multi-platform briefs.
4. Track field precision/recall, segment exact match, hard/soft classification, and unsafe-map count separately; a single pass rate hides the costly errors.
