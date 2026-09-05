# ingest_mcn_submissions

Risk tier: automatic Provider collection.

Call after `sync_mcn_inquiry_status` returns non-empty `inquiry_ids`. Pass the complete non-empty `inquiry_ids` array exactly as returned. Do not pass local event coordinates, Provider `trace_id`, rank IDs, or a mixture of different sync rounds.

Use only real response fields such as `ingested` and `submission_count`; missing counts remain unknown. Stop on a failed envelope or mismatched IDs. Do not infer supplier response status from an ingest failure.

A successful call creates an asynchronous job; it is not the completed ingest result. Copy the exact returned `job_id` to `get_ingest_job` and poll it to a terminal `succeeded` or `partially_succeeded` state before saving the preview Excel. Do not treat an Excel-like field in this response as final, save it, or rank it.
