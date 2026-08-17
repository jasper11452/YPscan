# get_workflow_state

Risk tier: immediate Provider read.

Call this tool only when the current business flow actually needs the Provider's workflow status; it is not startup preparation and does not recover local state.

Pass the exact `requirement_id` returned by `validate_requirement`. Never substitute `demand_id`, `demand_version`, a host run ID, or a guessed recent ID.

Use only fields present in the real response, such as `workflow_state`, `allowed_actions`, platform inquiry IDs, ranking status, or Provider batch information. Aggregate counts do not prove which earlier call produced them. A missing or ambiguous ID remains unresolved; do not infer identity or blindly resubmit a side-effecting request.
