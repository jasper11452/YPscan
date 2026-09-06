# get_workflow_state

Risk tier: deprecated Provider read.

This tool is not maintained and is no longer the authoritative entry to the retrieval chain. The formal retrieval chain starts from `sync_mcn_inquiry_status`, which returns `inquiry_ids` directly. Do not use `get_workflow_state` to decide the ingest step.

Do not call it from the current flow, including when `create_with_distributions` reports that the project is not active. Preserve that Provider error and stop the send attempt.
