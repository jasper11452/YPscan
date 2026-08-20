# ypscan_save_excel_artifact

Risk tier: local trusted-endpoint save.

Use this tool after `search_creators`, `rank_mcns`, `create_submission_batch`, `get_creator_detail_export`, `get_ingest_job`, or `manual_source_creators` returns a Provider Excel download URL. For `search_creators`, save immediately without displaying the creator preview URL, then continue to `rank_mcns`. For `rank_mcns`, first output the complete five-column Markdown table, then save without displaying the ranking URL; show both local paths before the branch question.

## Arguments

- `artifact_kind`: `creator_preview`, `mcn_ranking`, `mcn_creator_preview`, `manual_source`, `submission_batch`, or `creator_detail_export`.
- `artifact_id`: caller correlation metadata; use the current requirement ID for `creator_preview`, `mcn_ranking`, and `mcn_creator_preview`, otherwise the non-empty batch/task identifier required by that flow.
- `excel_file_url`: exact Provider download URL.

The caller cannot choose a destination or filename. The tool derives a safe `.xlsx` name from the URL and publishes it in the trusted current project.

## Safety

- The URL must use HTTPS on `eshypdata.com` or one of its subdomains, with the default port and no credentials or fragment.
- Redirects are forbidden. The total budget is 20 seconds and the maximum size is 20 MiB.
- Browser handpick exports do not enter this tool; if the platform cannot export, deliver the conversational list instead.
- Publication never overwrites different content and rejects symbolic-link or unsafe paths. Identical existing content is an idempotent success.
- Workbook contents are not parsed or treated as a source of creator IDs.

## Result

On success, show the returned absolute `data.file_path` to the user at the point required by the flow. `creator_preview` continues to `rank_mcns`; `mcn_ranking` shows both retained local paths and then uses the exact branch `ASK_USER_QUESTION_ARGS` from the preceding `rank_mcns` result. `submission_batch` may return exact `delivery.next_args` for the optional enrichment question; `creator_detail_export` finishes without repeating it. Follow only the returned delivery data and do not invent recovery state.

Stop on URL, size, response, path, symlink, or content-conflict errors. Do not fall back to Browser, shell, curl, `web_fetch`, Python, or a generic file writer.
