# sync_mcn_inquiry_status

Risk tier: automatic Provider collection.

Call only when `get_workflow_state` reports empty `inquiry_ids` for the current already-distributed project. Pass the exact `requirement_id`, `project_id`, and complete Provider-resolved `supplierIds` from the current inquiry flow. For institutions originally supplied through `supplier_name`, use only the real IDs returned by distribution creation or sending evidence. Do not mix requirements, pass unresolved names, or add suppliers that were not part of that send.

After a successful sync, do not ingest directly and do not rank: call `get_workflow_state` again with the same requirement ID, and only after it returns non-empty `inquiry_ids` proceed to `ingest_mcn_submissions`.

A queued notification or a successful sync does not prove that the WeCom message was delivered or that a supplier submitted creator data. Do not use rank IDs or combine different sync responses.

Stop on a failed envelope, identity mismatch, or a sync result with no usable evidence for the current retrieval.
