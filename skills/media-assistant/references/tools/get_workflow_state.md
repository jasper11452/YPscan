# get_workflow_state

Risk tier: immediate Provider read (diagnostic only).

This tool is not maintained and is no longer the authoritative entry to the retrieval chain. The formal retrieval chain starts from `sync_mcn_inquiry_status`, which returns `inquiry_ids` directly. Do not use `get_workflow_state` to decide the ingest step.

It may still be used as a one-off diagnostic when `create_with_distributions` fails because the project is not active, but it does not recover local state and is not startup preparation. Pass the exact `requirement_id` and never substitute `demand_id`, `demand_version`, a host run ID, or a guessed ID.
