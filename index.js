import { registerFlowDirectiveHooks } from "./src/hooks/register-flow-directives.js";
import {
  createRequirementParser,
  PARSE_REQUIREMENT_OUTPUT_SCHEMA,
  PARSE_REQUIREMENT_PARAMETERS,
} from "./src/tools/parse-requirement.js";
import { ARTIFACT_KINDS, saveArtifact } from "./src/tools/save-artifact.js";
import { fileBridge } from "./src/tools/file-bridge.js";
import { saveCreatorLinks } from "./src/tools/save-creator-links.js";
import { resolveTestAdapterBaseUrl } from "./src/tools/test-adapter.js";

/** Entry point for the YPscan client integration layer. */
export default {
  id: "ypscan",
  register(api) {
    const pluginConfig = api.pluginConfig ?? {};
    const testAdapterBaseUrl = resolveTestAdapterBaseUrl(pluginConfig);
    const fetchImpl = api.fetch ?? globalThis.fetch;
    const parseRequirement = createRequirementParser({
      fetchImpl,
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
        return {
          name: "ypscan_save_artifact",
          description:
            "将 eshypdata.com 主域下的 Excel 或 links CSV 受控保存到当前项目；格式由 artifact_kind 唯一决定。成功后必须向用户原样展示 delivery.local_file_link Markdown 超链接，不得只输出裸 file_path；临时下载故障采用有限重试。",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["artifact_kind", "artifact_id", "file_url"],
            properties: {
              artifact_kind: {
                type: "string",
                enum: ARTIFACT_KINDS,
              },
              artifact_id: {
                type: "string",
                minLength: 1,
                description:
                  "调用方关联 ID：除 creator_detail_export 使用 batch/task ID 外，其余 artifact_kind 使用当前 requirement_id",
              },
              file_url: {
                type: "string",
                minLength: 1,
                description: "Provider 返回的原始 Excel 或 CSV 下载 URL",
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
            const result = await saveArtifact(params, {
              workspaceDir: context?.workspaceDir,
              fetchImpl,
              testAdapterBaseUrl,
            });
            hookRuntime.recordSavedCsvArtifact(
              params.artifact_kind,
              params.artifact_id,
              result,
              context?.workspaceDir,
            );
            return result;
          },
        };
      },
      { name: "ypscan_save_artifact" },
    );

    api.registerTool(
      (context) => ({
        name: "ypscan_save_creator_links",
        description:
          "将机构回填 Excel 中 read 得到的达人标识（source_record_id / creator_id / url）受控保存为本轮 links CSV，登记为当前 requirement 的合法 links 来源，供 file_bridge 合并使用。成功后必须向用户原样展示 delivery.local_file_link Markdown 超链接。",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["requirement_id", "rows"],
          properties: {
            requirement_id: {
              type: "string",
              minLength: 1,
              description: "当前 requirement_id",
            },
            rows: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["creator_id", "url"],
                properties: {
                  source_record_id: { type: "string" },
                  creator_id: { type: "string", minLength: 1 },
                  url: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
        async execute(_id, params) {
          const result = await saveCreatorLinks(params, {
            workspaceDir: context?.workspaceDir,
          });
          const filePath = result?.details?.file_path;
          if (filePath) {
            hookRuntime.recordLinksCsv(params.requirement_id, filePath, context?.workspaceDir);
          }
          return result;
        },
      }),
      { name: "ypscan_save_creator_links" },
    );

    api.registerTool(
      (context) => ({
        name: "file_bridge",
        description:
          "将当前 requirement 的 links CSV 与一批或多批达人补全 CSV 合并为本地文件；manual_source、mcn_rank 在不超过 500 行时继续上传 OSS 并返回 csv_file_path，mcn_complete_only 只交付本地文件。",
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
          return fileBridge(params, {
            workspaceDir: context?.workspaceDir,
            pluginConfig,
            fetchImpl,
            allowedLinksCsvPaths: hookRuntime.linksCsvPathsFor,
            allowedCompletionCsvPaths: hookRuntime.completionCsvPathsFor,
          });
        },
      }),
      { name: "file_bridge" },
    );

    api.on("gateway_start", async () => {
      hookRuntime.resetTransientState();
    });
    api.on("gateway_stop", async () => {
      hookRuntime.resetTransientState();
    });
  },
};
