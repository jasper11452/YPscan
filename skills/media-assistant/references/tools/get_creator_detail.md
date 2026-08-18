# get_creator_detail

Only use for Xiaohongshu creator enrichment after the user explicitly requests it. Selecting “补充更新达人信息” in the post-submission question is that explicit request: call this tool directly without another question or field-selection step.

Risk tier: automatic Provider dispatch. The call starts asynchronous work; it does not return completed creator details.

Pass:

- `platform="xhs"`.
- the exact positive integer `batch_id` returned by the current `create_submission_batch` flow.

Do not call `select_inquiry_form_fields`, offer a creator-detail/column-selection choice, or ask which information to supplement. Do not pass `columns`, creator IDs, `requirement_id`, callback URLs, guessed fields, or IDs copied from another workflow. The Provider resolves the persisted field configuration through the batch's requirement association. An accepted result only means processing started. Poll the completed workbook through `get_creator_detail_export`; do not redispatch this tool while that export is pending.
