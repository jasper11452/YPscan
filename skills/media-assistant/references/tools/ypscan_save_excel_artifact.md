# ypscan_save_excel_artifact

Risk tier: local trusted-endpoint save.

Use this tool after `rank_mcns`, `get_ingest_job`, `rank_creators`, `score_manual_source_csv`, `score_manual_source_csv_status`, `manual_source_creators`, or `manual_source_creators_status` returns a Provider Excel download URL. Never use this tool for the workbook returned by `search_creators`. For `rank_mcns`, first output the complete five-column Markdown table, then save without displaying the ranking URL; show its local link before the recipient question.

## Arguments

- `artifact_kind`: `mcn_ranking`, `mcn_creator_preview`, `manual_source`, `creator_detail_export`, or `ranked_submission`.
- `artifact_id`: caller correlation metadata. Use the current requirement ID for `mcn_ranking`, `mcn_creator_preview`, `manual_source`, and `ranked_submission`. `creator_detail_export` remains a compatibility artifact kind for legacy exports.
- `excel_file_url`: exact Provider download URL.
- `mcn_names`: only for `mcn_ranking`; pass the exact current institution names so the save result can return the recipient-selection dialog.

The caller cannot choose a destination or filename. The tool derives a safe `.xlsx` name from the URL and publishes it in the trusted current project.

## Safety

- The URL must use HTTPS on `eshypdata.com` or one of its subdomains, with the default port and no credentials or fragment.
- Redirects are forbidden. The total budget is 20 seconds and the maximum size is 20 MiB.
- Publication never overwrites different content and rejects symbolic-link or unsafe paths. Identical existing content is an idempotent success.
- Workbook contents are not parsed or treated as a source of creator IDs.

## Result

On success, show the returned absolute `delivery.local_file_link` at the point required by the flow.

- `mcn_ranking` may return `delivery.next_tool="AskUserQuestion"` and `delivery.next_args`; call it after showing the local link.
- `mcn_creator_preview` ends the Excel-save step only; the next fixed action is to save the same round's links CSV through `ypscan_save_csv_artifact`.
- `manual_source` is the final manual-sourcing delivery (scored workbook or compatibility Excel path); do not route it into `rank_creators` or any enrichment flow.
- `ranked_submission` is the final ranked institutional submission workbook and ends the inquiry-ranking branch after local delivery.

Stop on URL, size, response, path, symlink, or content-conflict errors. Do not fall back to Browser, shell, curl, `web_fetch`, Python, or a generic file writer.
