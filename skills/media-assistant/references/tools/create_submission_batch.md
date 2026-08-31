# create_submission_batch

Risk tier: internal Provider export. No user confirmation.

Call when the user asks for an institutional submission table and [field selection](select_inquiry_form_fields.md) has been submitted for the current requirement. The Provider resolves the persisted fields by requirement association; the Agent does not retrieve them.

## Arguments

- `requirement_id`: exact current requirement ID.
- `submission_batche_page`: positive integer; use the requested page or `1` by default.

Do not pass `columns`, `size`, `demand_id`, `demand_version`, `platform`, or local state coordinates. Do not claim that Browser hand-pick data or historical batches are automatically merged.

After the Provider returns a valid positive integer batch and Excel URL, call `ypscan_save_excel_artifact` with `artifact_kind="submission_batch"`, the string form of that batch as `artifact_id`, the exact current `requirement_id`, and the current requirement platform as `platform="xhs"` or `platform="dy"`. This local-save metadata does not change the Provider call above. Display its exact `delivery.local_file_link` Markdown hyperlink instead of a bare path, and follow only the saver result's exact `delivery.next_args` if present. The saver offers creator enrichment for either verified platform; a missing platform ends after file delivery. A successful local save proves file delivery, not submission to an external system.
