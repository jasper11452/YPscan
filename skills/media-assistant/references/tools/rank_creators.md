# rank_creators

Risk tier: automatic Provider operation.

Use for detailed ranking only after the current institutional inquiry responses have been synchronized and ingested. Direct-sourcing Excel is already the final manual result and must not enter this tool. Optional arguments are `inquiry_ids` and `requirement_id`; use only exact IDs from the current inquiry flow. Do not pass local event IDs or a Provider `trace_id`.

Use the real `run_id`, `ranked_count`, and status returned by the Provider. Missing fields remain unknown. A failed or outcome-unknown ranking is not a reason to manufacture an inquiry or blindly repeat a side-effecting upstream call.
