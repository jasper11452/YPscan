# get_creator_detail_export

仅用于已成功发起的小红书达人信息补全。非小红书需求不得调用。

Risk tier: automatic Provider read. Use the exact batch from the current business flow; there is no local evidence gate.

## Remote arguments

| Argument | Constraint |
| --- | --- |
| `batch_id` | Provider-required integer batch ID; copy the exact positive batch from the current `create_submission_batch` result |

The string task ID sent to and echoed by `get_creator_detail` is not this integer ID and needs no conversion or lookup. Do not send `columns`, platform, creator IDs, callback URL, RPA type, or guessed fields. The Provider resolves fields through the batch's requirement association.

## Polling

- Immediately before the first poll, output `达人信息补全耗时较长，您可以先不用管，我会继续轮询。` This is a progress notice, not a question or confirmation: do not call `AskUserQuestion` and do not wait for a reply.
- This tool is both the readiness poll and the final export. After `get_creator_detail` is accepted, call it repeatedly with the same integer `batch_id` until it succeeds.
- The first immediate export call counts as poll 1. While the matching result is `BATCH_NOT_READY`, poll sequentially every 30 seconds with no additional user request or confirmation.
- Keep only the pending batch ID in the current execution context. Each run permits at most 10 polls and never redispatches `get_creator_detail`.
- Stop immediately when an Excel link succeeds or the user manually stops. Otherwise make at most 10 total export calls; after the 10th matching `BATCH_NOT_READY`, stop, report that processing is still incomplete, and preserve the same arguments for a later continuation.
- `BATCH_NOT_READY`, including remote status `0`, is an expected intermediate result. It does not mean the verified integer batch ID is the wrong kind of ID.
- After `BATCH_NOT_READY`, do not call `get_creator_detail` again, call `get_workflow_state`, or try, derive, enumerate, or guess another batch ID.

## Result

- `BATCH_NOT_READY` means processing continues; continue the polling loop above.
- Other failures: show the original code and message, then stop without trying another batch ID.
- Success requires the same batch, an HTTPS `excel_file_url`, a path-free `.xlsx` filename, and an optional non-negative row count.
- The response is a revised workbook, not per-creator JSON. Do not inspect the workbook or claim any predetermined field list.
- Render the original URL, then call `ypscan_save_excel_artifact` with `artifact_kind="creator_detail_export"`, the exact string form of `batch_id`, and that URL. Display the returned current-project workbook inline only after success. Never use Browser, shell, curl, `web_fetch`, Python, a fabricated `write` tool, or generic host file output.
