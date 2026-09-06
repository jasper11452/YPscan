# rank_creators

Risk tier: automatic Provider operation.

Deprecated in the formal retrieval chain. The institutional inquiry-retrieval chain now uses `sync_mcn_inquiry_status → ingest_mcn_submissions → get_ingest_job → save preview → ypscan_save_creator_links → native completion → file_bridge(flow=manual_source) → score_manual_source_csv` instead of `rank_creators`. Do not call this tool in the current flow.

The tool itself remains exposed by the Provider, but no new work should route into it. A failed or outcome-unknown ranking is not a reason to manufacture an inquiry or blindly repeat a side-effecting upstream call.
