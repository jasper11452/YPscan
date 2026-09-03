# ingest_mcn_submissions

Risk tier: automatic Provider collection.

Call after `get_workflow_state` returns non-empty `inquiry_ids` for the current retrieval (directly, or again after `sync_mcn_inquiry_status`). Pass the complete non-empty `inquiry_ids` array exactly as returned. Do not pass local event coordinates, Provider `trace_id`, rank IDs, or a mixture of different workflow-state rounds.

Use only real response fields such as `ingested` and `submission_count`; missing counts remain unknown. Stop on a failed envelope or mismatched IDs. Do not infer supplier response status from an ingest failure.

A successful call creates an asynchronous job; it is not the completed ingest result. Copy the exact returned `job_id` to `get_ingest_job` and poll it to a terminal `succeeded` or `partially_succeeded` state before `rank_creators`. Do not treat an Excel-like field in this response as final, save it, or continue to `rank_creators`.
