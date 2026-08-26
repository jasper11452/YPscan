import { registerFlowDirectiveHooks } from "./src/hooks/register-flow-directives.js";
import {
  createRequirementParser,
  PARSE_REQUIREMENT_OUTPUT_SCHEMA,
  PARSE_REQUIREMENT_PARAMETERS,
} from "./src/tools/parse-requirement.js";
import { createExcelArtifactSaver } from "./src/tools/save-excel-artifact.js";
import { resolveTestAdapterBaseUrl } from "./src/tools/test-adapter.js";

/** Entry point for the YPscan client integration layer. */
export default {
  id: "ypscan",
  register(api) {
    const testAdapterBaseUrl = resolveTestAdapterBaseUrl(api.pluginConfig ?? {});
    const parseRequirement = createRequirementParser({
      fetchImpl: api.fetch ?? globalThis.fetch,
    });
    const hookRuntime = registerFlowDirectiveHooks(api);

    api.registerTool({
      name: "ypscan_parse_requirement",
      description:
        '将当前单个平台的完整最新需求交给固定解析 Workflow，并在 data.outputs 中完整透传原始输出。解析返回的八个 Label 数组和 contentTag 合法非 null 时直接原样采用，不向用户确认；缺失或 null 的可选 Label 直接省略，但当前平台主达人类型字段例外：小红书 pgyBloggerTypeLabel 或抖音 xtTalentTypeLabel 解析为 null 时必须调用 AskUserQuestion 确认，并把答案写入对应顶层标签数组，用户未回答前禁止调用 validate_requirement。用户明确品牌优先；没有明确品牌时，当前平台品牌候选唯一、非空且不是 null/未知等占位值才直接采用。数值字段先合并用户原文和最新有效 clarification，只有仍缺失、模糊或冲突时才调用 AskUserQuestion。抖音报价、CPM、CPE 按视频类型映射：L2=植入视频，L3=定制视频，不使用 L1；解析片段带旧档位名但视频类型明确时保持数值不变并确定性路由，不重复询问。同平台多个达人类型只有总量时只创建一个 requirement，保留原始总量并合并全部类型标签和条件，不拆分子需求、不重复落库或重复搜索；无明确重点时仍保留各类型标签，不询问每类人数。进入 validate_requirement 前，所有数值筛选字段全部准备为无空格 JSON 区间字符串 "[min,max]"，返点固定为 "[min,1]"，不得靠 Provider 报错试类型。首次需求必调；后续单次修改只涉及一个条件时由 Agent 直接更新，涉及两个及以上条件时只用用户原始表述和后续改口重建完整需求再调用，禁止把旧解析输出或 Provider 归一化值回填。',
      parameters: PARSE_REQUIREMENT_PARAMETERS,
      outputSchema: PARSE_REQUIREMENT_OUTPUT_SCHEMA,
      async execute(_id, params) {
        return parseRequirement(params);
      },
    });

    api.registerTool(
      (context) => {
        const saveExcelArtifact = createExcelArtifactSaver({
          workspaceDir: context?.workspaceDir,
          fetchImpl: api.fetch ?? globalThis.fetch,
          testAdapterBaseUrl,
        });
        return {
          name: "ypscan_save_excel_artifact",
          description:
            "将 eshypdata.com 主域下的 Excel 受控保存到当前项目；成功后必须向用户原样展示 delivery.local_file_link Markdown 超链接，确保点击即可打开本地 Excel，不得只输出裸 file_path；临时下载故障采用有限重试。",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["artifact_kind", "artifact_id", "excel_file_url"],
            properties: {
              artifact_kind: {
                type: "string",
                enum: [
                  "submission_batch",
                  "creator_detail_export",
                  "mcn_ranking",
                  "mcn_creator_preview",
                  "manual_source",
                ],
              },
              artifact_id: {
                type: "string",
                minLength: 1,
                description: "调用方用于关联结果的 requirement_id、task_id 或 batch_id",
              },
              excel_file_url: {
                type: "string",
                minLength: 1,
                description: "Provider 返回的原始 Excel 下载 URL",
              },
              mcn_count: {
                type: "integer",
                minimum: 0,
                description:
                  "仅 mcn_ranking 使用；当前排序结果的真实机构数量，用于保存后生成下一步弹窗",
              },
            },
          },
          async execute(_id, params) {
            return saveExcelArtifact(params);
          },
        };
      },
      { name: "ypscan_save_excel_artifact" },
    );

    api.on("gateway_start", async () => {
      hookRuntime.resetTransientState();
    });
    api.on("gateway_stop", async () => {
      hookRuntime.resetTransientState();
    });
  },
};
