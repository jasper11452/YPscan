# sync_mcn_inquiry_status

Risk tier: automatic Provider collection.

Call when the user asks to retrieve institutional responses after `create_with_distributions`. Pass the exact `requirement_id`, `project_id`, and complete Provider-resolved `supplierIds` from the current inquiry flow. For institutions originally supplied through `supplier_name`, use only the real IDs returned by distribution creation or sending evidence. Do not mix requirements, pass unresolved names, or add suppliers that were not part of that send.

Use only real returned `inquiry_ids`. A queued notification or a successful sync does not prove that the企微 message was delivered or that a supplier submitted creator data. Pass the exact IDs from this sync to `ingest_mcn_submissions`; do not use rank IDs or combine different sync responses.

Stop on a failed envelope, identity mismatch, or success without usable inquiry IDs.
