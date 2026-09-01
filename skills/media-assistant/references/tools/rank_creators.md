# rank_creators

Risk tier: automatic Provider operation.

Use for detailed ranking only after the current institutional inquiry responses have been synchronized and ingested. Direct-sourcing Excel is already the final manual result and must not enter this tool. Optional arguments are `inquiry_ids` and `requirement_id`; use only exact IDs from the current inquiry flow. Do not pass local event IDs or a Provider `trace_id`.

Use the real `run_id`, `ranked_count`, and status returned by the Provider when reporting this ranking result. Missing fields remain unknown. `run_id` identifies the ranking run only: never copy it into `create_submission_batch.submission_batche_page`, even when it is a positive integer. The first submission-table call uses the literal page number `1`. A failed or outcome-unknown ranking is not a reason to manufacture an inquiry or blindly repeat a side-effecting upstream call.
