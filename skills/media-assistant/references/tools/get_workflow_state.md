# get_workflow_state

Risk tier: immediate Provider read.

When the user says the institutions have submitted creator data (机构已回填), this is the fixed first step of the retrieval chain. Call it with the exact current `requirement_id` before any ingest, rank, or sync action. It is not startup preparation and does not recover local state.

Pass the exact `requirement_id` returned by `validate_requirement`. Never substitute `demand_id`, `demand_version`, a host run ID, or a guessed recent ID.

## inquiry_ids handling

Read the real `inquiry_ids` from the response and act on its three states:

- Non-empty `inquiry_ids`: proceed to `ingest_mcn_submissions({inquiry_ids})`, then poll `get_ingest_job`.
- Empty `inquiry_ids` for an already-distributed project (including the `mcn_planning` state): call `sync_mcn_inquiry_status({requirement_id, project_id, supplierIds})` first, then call `get_workflow_state` again with the same requirement ID and ingest only the newly returned non-empty `inquiry_ids`. Never ingest directly after the sync.
- A `mcn_planning` state alone does not mean ranking is allowed; it only identifies the empty-inquiry, already-distributed case above.

Use only fields present in the real response, such as `workflow_state`, `allowed_actions`, platform inquiry IDs, ranking status, or Provider batch information. Aggregate counts do not prove which earlier call produced them. A missing or ambiguous ID remains unresolved; do not infer identity or blindly resubmit a side-effecting request.
