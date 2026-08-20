import { registerFlowDirectiveHooks } from "./src/hooks/register-flow-directives.js";
import {
  createRequirementParser,
  PARSE_REQUIREMENT_OUTPUT_SCHEMA,
  PARSE_REQUIREMENT_PARAMETERS,
} from "./src/tools/parse-requirement.js";
import { createExcelArtifactSaver } from "./src/tools/save-excel-artifact.js";
import {
  createManualResearchRunner,
  MANUAL_RESEARCH_RUNNER_PARAMETERS,
} from "./src/tools/manual-research-runner.js";
import { createManualBrowserRuntime } from "./src/tools/manual-research/browser-runtime.js";
import { resolveTestAdapterBaseUrl } from "./src/tools/test-adapter.js";

/** Entry point for the YPscan client integration layer. */
export default {
  id: "ypscan",
  register(api) {
    const testAdapterBaseUrl = resolveTestAdapterBaseUrl(api.pluginConfig ?? {});
    const parseRequirement = createRequirementParser();
    const hookRuntime = registerFlowDirectiveHooks(api);
    const manualBrowserRuntime = createManualBrowserRuntime({
      profileDir: api.pluginConfig?.manualBrowserProfileDir,
    });

    api.registerTool(
      (context) => {
        const manualResearch = createManualResearchRunner({
          workspaceDir: context?.workspaceDir,
          browserRuntime: manualBrowserRuntime,
        });
        return {
          name: "ypscan_manual_research",
          description:
            "产物优先的双平台手扒 Runner：start/resume 控制专用持久 Chrome 并保存原始详情 HTML；read_detail_html 分块交给 Agent 提炼，apply_reviews 回写字段和逐字证据；create_submission 为可选后续。",
          parameters: MANUAL_RESEARCH_RUNNER_PARAMETERS,
          async execute(_id, params) {
            return manualResearch(params);
          },
        };
      },
      { name: "ypscan_manual_research" },
    );

    api.registerTool({
      name: "ypscan_parse_requirement",
      description:
        "需求解析入口：传紧凑证据 facts，工具补齐元数据并输出 Provider 参数、搜索分组和 residual_conditions。必须随后调用 validate_requirement；不启动 Browser、不创建需求。",
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
            "将 eshypdata.com 主域下的 Excel 受控保存到当前项目；成功后必须向用户原样展示返回的绝对 file_path，临时下载故障采用有限重试。",
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
                  "creator_preview",
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
      await manualBrowserRuntime.close();
    });
  },
};
