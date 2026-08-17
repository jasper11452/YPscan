# create_submission_batch

Risk tier: internal Provider export. No user confirmation.

Call when the user asks for an institutional submission table and [field selection](select_inquiry_form_fields.md) has been submitted for the current requirement. The Provider resolves the persisted fields by requirement association; the Agent does not retrieve them.

## Arguments

- `requirement_id`: exact current requirement ID.
- `submission_batche_page`: positive integer; use the requested page or `1` by default.

Do not pass `columns`, `size`, `demand_id`, `demand_version`, `platform`, or local state coordinates. Do not claim that Browser hand-pick data or historical batches are automatically merged.

After the Provider returns a valid batch and Excel URL, call `ypscan_save_excel_artifact` with `artifact_kind="submission_batch"`, show its absolute local path, and follow only the saver result's exact `delivery.next_args` if present. A successful local save proves file delivery, not submission to an external system.
