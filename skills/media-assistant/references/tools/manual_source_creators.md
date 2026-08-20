# manual_source_creators

人工拓展的默认入口。调用前必须先执行 `select_inquiry_form_fields`，原样展示 URL，并等待用户在页面提交字段后回复“好了”。随后使用同一真实 `requirement_id` 和用户要求的正整数交付人数 `size`，由 Provider 后台全自动完成手扒并在同一响应返回 Excel。若 Provider 返回 `REQUIREMENT_COLUMNS_NOT_CONFIGURED`，不得原参数重试；重新进入字段选择步骤。

成功后立即把返回的 Excel URL 作为 `ypscan_save_excel_artifact` 的内部参数，使用 `artifact_kind="manual_source"` 和返回的 `batch_id` 保存到当前项目。下载链接不作为最终交付；必须展示保存结果中的真实绝对 `file_path`。

只有本地保存成功后才提示用户：默认推荐直接使用该结果，也可以选择耗时更长的浏览器详细手扒；浏览器方式期间可能多次出现登录、验证或资质弹窗。用户没有明确选择浏览器方式时，不调用 `ypscan_manual_research`。
