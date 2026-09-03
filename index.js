import { registerFlowDirectiveHooks } from "./src/hooks/register-flow-directives.js";
import {
  createRequirementParser,
  PARSE_REQUIREMENT_OUTPUT_SCHEMA,
  PARSE_REQUIREMENT_PARAMETERS,
} from "./src/tools/parse-requirement.js";
import { createExcelArtifactSaver } from "./src/tools/save-excel-artifact.js";
import { createCsvArtifactSaver } from "./src/tools/save-csv-artifact.js";
import { createCreatorCsvMerger } from "./src/tools/merge-creator-csv.js";
import { createCreatorCsvUploader } from "./src/tools/upload-creator-csv.js";
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
        "解析当前单个平台的完整最新需求。business_mode 来自用户明确表达，未明确或语义冲突时通过模式选择确定。data.outputs 只返回当前 Provider 契约消费的标签、品牌、粉丝/返点和报价/CPM/CPE 字段；未命中字段省略。具体复核、缺失值处理、需求修改和自动放宽规则统一按 media-assistant Skill 执行。",
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
                  "creator_detail_export",
                  "mcn_ranking",
                  "mcn_creator_preview",
                  "manual_source",
                  "ranked_submission",
                ],
              },
              artifact_id: {
                type: "string",
                minLength: 1,
                description:
                  "调用方关联 ID：mcn_ranking、mcn_creator_preview、manual_source 和 ranked_submission 使用 requirement_id；creator_detail_export 使用 batch/task ID",
              },
              excel_file_url: {
                type: "string",
                minLength: 1,
                description: "Provider 返回的原始 Excel 下载 URL",
              },
              mcn_names: {
                type: "array",
                items: { type: "string", minLength: 1 },
                description:
                  "仅 mcn_ranking 使用；当前排序结果中的机构名称，用于保存后选择询价收件机构",
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

    api.registerTool(
      (context) => {
        const saveCsvArtifact = createCsvArtifactSaver({
          workspaceDir: context?.workspaceDir,
          fetchImpl: api.fetch ?? globalThis.fetch,
          testAdapterBaseUrl,
        });
        return {
          name: "ypscan_save_csv_artifact",
          description:
            "将 eshypdata.com 主域下的 links CSV 受控保存到当前项目；成功后必须向用户原样展示 delivery.local_file_link Markdown 超链接。",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["artifact_kind", "artifact_id", "csv_file_url"],
            properties: {
              artifact_kind: {
                type: "string",
                enum: ["manual_creator_links", "mcn_creator_links"],
              },
              artifact_id: {
                type: "string",
                minLength: 1,
                description: "当前 requirement_id",
              },
              csv_file_url: {
                type: "string",
                minLength: 1,
                description: "Provider 返回的原始 CSV 下载 URL",
              },
            },
          },
          async execute(_id, params) {
            return saveCsvArtifact(params);
          },
        };
      },
      { name: "ypscan_save_csv_artifact" },
    );

    api.registerTool(
      (context) => {
        const mergeCreatorCsv = createCreatorCsvMerger({
          workspaceDir: context?.workspaceDir,
        });
        return {
          name: "ypscan_merge_creator_csv",
          description:
            "合并当前 requirement 的 links CSV 与一批或多批 YP Action 达人补全 CSV，输出保持 links 原顺序的 merged CSV。",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: [
              "requirement_id",
              "platform",
              "flow",
              "links_csv_path",
              "completion_csv_paths",
            ],
            properties: {
              requirement_id: { type: "string", minLength: 1 },
              platform: { type: "string", enum: ["xiaohongshu", "douyin"] },
              flow: { type: "string", enum: ["manual_source", "mcn_rank", "mcn_complete_only"] },
              links_csv_path: { type: "string", minLength: 1 },
              completion_csv_paths: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
            },
          },
          async execute(_id, params) {
            return mergeCreatorCsv(params);
          },
        };
      },
      { name: "ypscan_merge_creator_csv" },
    );

    api.registerTool({
      name: "ypscan_upload_creator_csv",
      description:
        "显式校验并上传当前 merged CSV；在评分前阻断超过 500 行的数据，并返回 Provider 评分工具消费的 csv_file_path。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["requirement_id", "flow", "merged_csv_path"],
        properties: {
          requirement_id: { type: "string", minLength: 1 },
          flow: { type: "string", enum: ["manual_source", "mcn_rank"] },
          merged_csv_path: { type: "string", minLength: 1 },
        },
      },
      async execute(_id, params) {
        const uploadCreatorCsv = createCreatorCsvUploader({
          fetchImpl: api.fetch ?? globalThis.fetch,
          testAdapterBaseUrl,
        });
        return uploadCreatorCsv(params);
      },
    });

    api.on("gateway_start", async () => {
      hookRuntime.resetTransientState();
    });
    api.on("gateway_stop", async () => {
      hookRuntime.resetTransientState();
    });
  },
};
