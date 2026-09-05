# sync_mcn_inquiry_status

Risk tier: automatic Provider collection.

Call as the fixed first step of the retrieval chain after the institutions have submitted creator data (机构已回填). Pass the exact `requirement_id`, `project_id`, and complete Provider-resolved `supplierIds` from the current inquiry flow. For institutions originally supplied through `supplier_name`, use only the real IDs returned by distribution creation or sending evidence. Do not mix requirements, pass unresolved names, or add suppliers that were not part of that send.

A successful sync returns the inquiry mapping directly in `data.inquiries[].inquiry_id`. Use those exact `inquiry_ids` to call `ingest_mcn_submissions` immediately. Do not re-read `get_workflow_state` first and do not rank before ingest.

A queued notification or a successful sync does not prove that the WeCom message was delivered or that a supplier submitted creator data. Do not use rank IDs or combine different sync responses.

Stop on a failed envelope, identity mismatch, or a sync result with no usable `inquiry_ids` for the current retrieval.
