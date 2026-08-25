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
    const parseRequirement = createRequirementParser({
      fetchImpl: api.fetch ?? globalThis.fetch,
    });
    const hookRuntime = registerFlowDirectiveHooks(api);
    const manualBrowserRuntime = createManualBrowserRuntime({
      browserCdpUrl: api.pluginConfig?.browserCdpUrl,
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
            "仅在用户明确要求浏览器手扒后使用的双平台 Runner：Agent 先启动宿主 Browser，start/resume 通过 CDP 复用其登录态并保存原始详情 HTML；普通手扒、手动拓展、人工拓展、直接手扒和手捞筛选必须改用 MCP manual_source_creators。",
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
        "将当前单个平台的完整最新需求直连固定 Dify Workflow，在 data.outputs 中完整透传原始 Workflow 输出。Dify 负责标签、品牌、粉丝、返点、报价、CPM 和 CPE；首次需求必调，后续单次修改只涉及一个条件时由 Agent 直接更新，涉及两个及以上条件时只用用户原始表述和后续改口重建完整需求再调用，禁止把 Dify 输出或 Provider 归一化值回填给 Dify。Dify 输出不得猜测或重算，其余 Provider 字段由 Agent 按 media-assistant 解析参考补齐。",
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
