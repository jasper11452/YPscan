# ypscan_save_creator_links

Risk tier: local trusted-endpoint save.

Use this tool in the institutional inquiry-retrieval chain after `read` reads the saved preview Excel. It converts the extracted creator identifiers into a controlled links CSV for the current requirement, which `file_bridge` accepts as its `links_csv_path` source.

## Arguments

- `requirement_id`: exact current requirement ID.
- `rows`: non-empty array of creator identifiers read from the preview Excel. Each row has `creator_id` (required, the normalized platform creator ID such as 小红书 `kw_uid` or 抖音星图 ID), `url` (required, the creator homepage URL), and optionally `source_record_id`.

The tool deduplicates rows by `creator_id`, writes a `source_record_id,creator_id,url` CSV locally, and registers it as a controlled links source for the current requirement.

## Result

On success, show the returned `delivery.local_file_link`, then run platform-native creator completion in batches of 20, followed by `file_bridge(flow="manual_source")` and `score_manual_source_csv`.

## Safety

Rows must have non-empty `creator_id` and `url`, and must not contain control characters. The tool never downloads from a URL, never overwrites different content, and never treats workbook contents as a source of creator IDs beyond the explicitly provided rows.

Stop on invalid rows, an empty deduplicated row set, or a workspace error. Do not fall back to Browser, shell, Python, or a generic file writer.
