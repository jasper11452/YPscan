# rank_creators

Risk tier: automatic Provider operation.

Use for detailed ranking after the current institutional inquiry responses have been synchronized and ingested. Optional arguments are `inquiry_ids` and `requirement_id`; use only exact IDs from the current business flow. Do not pass local event IDs or a Provider `trace_id`.

Use the real `run_id`, `ranked_count`, and status returned by the Provider. Missing fields remain unknown. A failed or outcome-unknown ranking is not a reason to manufacture an inquiry or blindly repeat a side-effecting upstream call.
