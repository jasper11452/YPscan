# ingest_mcn_submissions

Risk tier: automatic Provider collection.

Call after `sync_mcn_inquiry_status` returns the inquiry IDs for the current retrieval. Pass the complete non-empty `inquiry_ids` array exactly as returned. Do not pass local event coordinates, Provider `trace_id`, rank IDs, or a mixture of different sync rounds.

Use only real response fields such as `ingested` and `submission_count`; missing counts remain unknown. Stop on a failed envelope or mismatched IDs. Do not infer supplier response status from an ingest failure.
