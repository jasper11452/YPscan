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
            "只读识别人工拓展 Browser 当前状态：错页、登录、加载、普通/受保护弹窗、验证码、达人广场、结果页或达人详情。任何 Browser 动作前先调用；不导航、不点击、不关闭弹窗、不返回原始 DOM。",
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
            "执行一个有后置验证的人工拓展语义动作。必须携带 inspect/上一动作返回的 expected_state_id；筛选动作必须引用 plan_action_id。登录、验证码和受保护弹窗作为状态立即暂停，绝不内部盲重试。",
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
            "人工拓展筛选凭证工具：operation=plan 只生成当前关键词分支的语义动作计划，不操作 Browser；Agent 用 inspect/action 逐步执行后，operation=commit 只读复核全部页面条件并签发 selection_id。",
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
            "人工拓展数据工具：新协议下每次 collect 只读取并持久化当前结果页或详情页证据，返回下一条精确工具调用；不执行导航、筛选、翻页或详情点击。apply_reviews 继续分批写回同一 run。",
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
