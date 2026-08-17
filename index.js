import { fileURLToPath } from "node:url";
import { registerWecomConfirmationOnlyHooks } from "./src/hooks/register-wecom-confirmation-only.js";
import {
  createRequirementParser,
  PARSE_REQUIREMENT_OUTPUT_SCHEMA,
  PARSE_REQUIREMENT_PARAMETERS,
} from "./src/tools/parse-requirement.js";
import { createExcelArtifactSaver } from "./src/tools/save-excel-artifact.js";
import {
  createManualFilterSelection,
  MANUAL_FILTER_SELECTION_PARAMETERS,
} from "./src/tools/manual-filter-selection.js";
import { createManualResearch, MANUAL_RESEARCH_PARAMETERS } from "./src/tools/manual-research.js";
import { resolveTestAdapterBaseUrl } from "./src/tools/test-adapter.js";

const MEDIA_ASSISTANT_SKILL_PATH = fileURLToPath(
  new URL("./skills/media-assistant/SKILL.md", import.meta.url),
);

/** Entry point for the YPscan client integration layer. */
export default {
  id: "ypscan",
  register(api) {
    const testAdapterBaseUrl = resolveTestAdapterBaseUrl(api.pluginConfig ?? {});
    const parseRequirement = createRequirementParser();
    const hookRuntime = registerWecomConfirmationOnlyHooks(api, {
      skillPath: MEDIA_ASSISTANT_SKILL_PATH,
    });

    api.registerTool(
      (context) => {
        const selectFilters = createManualFilterSelection({
          browserCdpUrl: api.pluginConfig?.browserCdpUrl,
          workspaceDir: context?.workspaceDir,
        });
        return {
          name: "ypscan_manual_select_filters",
          description:
            "人工拓展筛选阶段：首次必须保留完整硬条件 facts，工具按单个关键词分支自动拆分页面筛选、详情硬审和语义复核；不要为规避不稳定控件删除受众或内容条件。页面条件逐项真实回读后才生成 selection_id；任何未提交筛选都会阻止抓取。只负责筛选，不读取候选、翻页、详情或导出。",
          parameters: MANUAL_FILTER_SELECTION_PARAMETERS,
          async execute(_id, params) {
            return selectFilters(params);
          },
        };
      },
      { name: "ypscan_manual_select_filters" },
    );

    api.registerTool(
      (context) => {
        const manualResearch = createManualResearch({
          browserCdpUrl: api.pluginConfig?.browserCdpUrl,
          workspaceDir: context?.workspaceDir,
        });
        return {
          name: "ypscan_manual_research",
          description:
            "人工拓展抓取阶段：只接受 ypscan_manual_select_filters 返回的 run_id/selection_id，先只读复核当前页面筛选状态，再分页抓取、去重、补详情、增量保存 checkpoint 并生成五表 Excel。抓取阶段绝不重置、搜索或修改筛选；状态漂移时拒绝抓取。apply_reviews 继续分批写回同一 run。",
          parameters: MANUAL_RESEARCH_PARAMETERS,
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
                enum: ["submission_batch", "creator_detail_export", "creator_preview"],
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
    });
  },
};
