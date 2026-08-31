# ypscan_save_excel_artifact

Risk tier: local trusted-endpoint save.

Use this tool after `rank_mcns`, `create_submission_batch`, `get_creator_detail_export`, `get_ingest_job`, or `manual_source_creators_status` returns a Provider Excel download URL. Never use it for the workbook returned by `search_creators`. For `rank_mcns`, first output the complete five-column Markdown table, then save without displaying the ranking URL; show its local path before the recipient question.

## Arguments

- `artifact_kind`: `mcn_ranking`, `mcn_creator_preview`, `manual_source`, `submission_batch`, or `creator_detail_export`.
- `artifact_id`: caller correlation metadata. Use the current requirement ID for `mcn_ranking`, `mcn_creator_preview`, and `manual_source` — the direct-sourcing save must carry the same requirement ID that the following `rank_creators` call will use. Use the non-empty batch/task identifier for `submission_batch` and `creator_detail_export`.
- `excel_file_url`: exact Provider download URL.
- `requirement_id`: pass the exact current requirement ID for `submission_batch` so the later `get_creator_detail` call can use the same association; omit it for other artifact kinds.
- `platform`: for `submission_batch`, pass the current requirement platform as `"xhs"` or `"dy"`. Either verified platform may produce the creator-enrichment question; a missing platform must not produce it or default to either platform.
- `mcn_names`: only for `mcn_ranking`; pass the exact current institution names so the save result can return the recipient-selection dialog.

The caller cannot choose a destination or filename. The tool derives a safe `.xlsx` name from the URL and publishes it in the trusted current project.

## Safety

- The URL must use HTTPS on `eshypdata.com` or one of its subdomains, with the default port and no credentials or fragment.
- Redirects are forbidden. The total budget is 20 seconds and the maximum size is 20 MiB.
- Browser handpick exports do not enter this tool; if the platform cannot export, deliver the conversational list instead.
- Publication never overwrites different content and rejects symbolic-link or unsafe paths. Identical existing content is an idempotent success.
- Workbook contents are not parsed or treated as a source of creator IDs.

## Result

On success, show the returned absolute `data.file_path` to the user at the point required by the flow. With non-empty `mcn_names`, `mcn_ranking` returns `delivery.next_tool="AskUserQuestion"` and the exact recipient-selection question in `delivery.next_args`; call it after showing the local link. `submission_batch` returns the optional enrichment question only when it has `platform="xhs"` or `platform="dy"`, a positive integer batch ID, and the exact current requirement ID. Missing-platform saves end after file delivery. Follow only returned delivery data and do not invent recovery state.

Stop on URL, size, response, path, symlink, or content-conflict errors. Do not fall back to Browser, shell, curl, `web_fetch`, Python, or a generic file writer.
