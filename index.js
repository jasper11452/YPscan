import { fileURLToPath } from "node:url";
import { registerWecomConfirmationOnlyHooks } from "./src/hooks/register-wecom-confirmation-only.js";
import {
  createRequirementParser,
  PARSE_REQUIREMENT_OUTPUT_SCHEMA,
  PARSE_REQUIREMENT_PARAMETERS,
} from "./src/tools/parse-requirement.js";
import { createExcelArtifactSaver } from "./src/tools/save-excel-artifact.js";
import {
  createManualBrowserAction,
  MANUAL_BROWSER_ACTION_PARAMETERS,
} from "./src/tools/manual-browser-action.js";
import {
  createManualBrowserInspector,
  MANUAL_BROWSER_INSPECT_PARAMETERS,
} from "./src/tools/manual-browser-inspect.js";
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
        const inspectBrowser = createManualBrowserInspector({
          browserCdpUrl: api.pluginConfig?.browserCdpUrl,
          workspaceDir: context?.workspaceDir,
        });
        return {
          name: "ypscan_manual_browser_inspect",
          description:
            "一次性只读观测人工拓展 Browser 的整体状态和当前标签页全部可见可交互元素。返回 observation_id、稳定页面上下文、重定向/登录/弹窗/验证码信号、区域与 element_id；不等待具体元素、不决定下一步、不返回原始 DOM。",
          parameters: MANUAL_BROWSER_INSPECT_PARAMETERS,
          async execute(_id, params) {
            return inspectBrowser(params);
          },
        };
      },
      { name: "ypscan_manual_browser_inspect" },
    );

    api.registerTool(
      (context) => {
        const browserAction = createManualBrowserAction({
          browserCdpUrl: api.pluginConfig?.browserCdpUrl,
          workspaceDir: context?.workspaceDir,
        });
        return {
          name: "ypscan_manual_browser_action",
          description:
            "执行一个带局部后置验证的人工拓展元素语义动作。v3 必须引用 Observer 的 observation_id/element_id，并声明 purpose/expected_effect；页面其他元素变化不阻止动作，目标变化则要求重新观测。禁止 selector 和坐标。",
          parameters: MANUAL_BROWSER_ACTION_PARAMETERS,
          async execute(_id, params) {
            return browserAction(params);
          },
        };
      },
      { name: "ypscan_manual_browser_action" },
    );

    api.registerTool(
      (context) => {
        const selectFilters = createManualFilterSelection({
          browserCdpUrl: api.pluginConfig?.browserCdpUrl,
          workspaceDir: context?.workspaceDir,
        });
        return {
          name: "ypscan_manual_select_filters",
          description:
            "人工拓展筛选凭证工具：v3 plan 只返回硬筛需求和关键词顺序，不指定页面控件；Agent 观测全页元素后逐项操作。首关键词硬筛完成后最后提交关键词，后续关键词继承筛选集只换关键词；commit 复核后签发 selection_id。",
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
            "人工拓展数据工具：collect 只读取并持久化当前结果页或详情页证据，返回下一条精确工具调用；apply_reviews 分批写回复核结论；复核完成后 create_submission 从同一 run 生成独立本地提报表。",
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
                enum: [
                  "submission_batch",
                  "creator_detail_export",
                  "creator_preview",
                  "mcn_creator_preview",
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
    });
  },
};
