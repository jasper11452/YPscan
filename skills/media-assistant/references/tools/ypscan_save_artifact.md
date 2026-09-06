# ypscan_save_artifact

Risk tier: local trusted-endpoint save.

Use this single tool after `rank_mcns`, `get_ingest_job`, `rank_creators`, `score_manual_source_csv`, `score_manual_source_csv_status`, `manual_source_creators`, or `manual_source_creators_status` returns a Provider Excel or links CSV download URL. Never use it for the workbook returned by `search_creators`. For `rank_mcns`, first output the complete five-column Markdown table, then save without displaying the ranking URL; show its local link before the recipient question.

## Arguments

- `artifact_kind`: `mcn_ranking`, `mcn_creator_preview`, `manual_source`, `creator_detail_export`, `ranked_submission`, `manual_creator_links`, or `mcn_creator_links`. The kind uniquely determines whether the file must be `.xlsx` or `.csv`.
- `artifact_id`: caller correlation metadata. Use the current requirement ID except for the legacy `creator_detail_export` compatibility kind.
- `file_url`: exact Provider download URL. Do not rename it to a format-specific argument.
- `mcn_names`: only for `mcn_ranking`; pass the exact current institution names so the save result can return the recipient-selection dialog.

The caller cannot choose a destination or filename. The tool derives a safe name with the format required by `artifact_kind` and publishes it in the trusted current project. If the URL has no filename matching that format, the tool uses a deterministic local fallback name.

## Safety

- The URL must use HTTPS on `eshypdata.com` or one of its subdomains, with the default port and no credentials or fragment.
- Redirects are forbidden. The total budget is 20 seconds and the maximum size is 20 MiB.
- Publication never overwrites different content and rejects symbolic-link or unsafe paths. Identical existing content is an idempotent success.
- Workbook contents are not parsed or treated as a source of creator IDs.

## Result

Success echoes `data.artifact_kind` and `data.artifact_id` so the result hook can route even when the host omits call params.

On success, show the returned absolute `delivery.local_file_link` at the point required by the flow.

- `mcn_ranking` may return `delivery.next_tool="AskUserQuestion"` and `delivery.next_args`; call it after showing the local link.
- `mcn_creator_preview` registers its path and SHA-256 for this requirement. Ask whether to complete, then call `ypscan_save_creator_links` with `preview_file_path` and confirmed `platform` to directly parse xlsx and derive links. Generic text `read` does not parse xlsx.
- `manual_creator_links` continues the manual-sourcing completion branch after the local CSV link is shown. `mcn_creator_links` is a legacy kind no longer produced by the formal flow.
- `manual_source` is the final scored-and-sorted delivery (scored workbook or compatibility Excel path); do not route it into `rank_creators` or any enrichment flow.
- `ranked_submission` is a legacy final submission workbook kind; the formal flow no longer produces it.

Stop on URL, format, size, response, path, symlink, or content-conflict errors. Do not fall back to Browser, shell, curl, `web_fetch`, Python, or a generic file writer.
