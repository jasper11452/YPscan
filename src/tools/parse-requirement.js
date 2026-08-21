import { isRecord, nonemptyString } from "../util/value.js";
import { hostToolResult } from "./tool-result.js";

export const REQUIREMENT_FACT_KINDS = Object.freeze([
  "brand_name",
  "project_name",
  "product_name",
  "creator_count",
  "submission_deadline",
  "schedule_window",
  "creator_price",
  "follower_count",
  "rebate_min",
  "content_direction",
  "content_format",
  "video_duration",
  "creator_gender",
  "creator_city",
  "audience_gender",
  "audience_city",
  "audience_female_rate",
  "audience_male_rate",
  "audience_age_l1_rate",
  "audience_age_l2_rate",
  "audience_age_l3_rate",
  "audience_age_l4_rate",
  "audience_age_l5_rate",
  "audience_age_l6_rate",
  "cpm_max",
  "cpe_max",
  "interaction_rate",
  "click_median",
  "view_median",
  "photo_view",
  "video_interact",
  "photo_interact",
  "user_like_count",
  "like_increment",
  "avg_view",
  "avg_like",
  "avg_comment",
  "avg_collect",
  "avg_interact",
  "has_order_30day",
  "has_social_30day",
  "content_feature",
  "content_theme",
  "creator_persona",
  "creator_type",
  "platform_creator_type",
  "growth_creator_type",
  "industry_tag",
  "ip_dependency",
  "creator_url_keyword",
  "organization_affiliation",
  "organization_name",
  "excluded_content",
  "preferred_content",
  "total_budget",
  "reference_creator",
  "route_constraint",
  "external_condition",
]);

const FACT_STATUSES = Object.freeze([
  "present",
  "missing",
  "ambiguous",
  "conflicting",
  "superseded",
]);
const FACT_STRENGTHS = Object.freeze(["hard", "soft", "context"]);
const FACT_SCOPES = Object.freeze(["shared", "xiaohongshu", "douyin"]);
const FACT_SUBJECTS = Object.freeze([
  "brand",
  "project",
  "creator",
  "audience",
  "content",
  "commercial",
  "route",
]);
const FACT_OPERATORS = Object.freeze([
  "exact",
  "lte",
  "gte",
  "between",
  "in",
  "not_in",
  "preference",
  "any",
]);
const FACT_QUALIFIERS = Object.freeze([
  "generic",
  "picture",
  "video",
  "duration_l1",
  "duration_l2",
  "duration_l3",
]);
const FACT_ROLES = Object.freeze([
  "generic",
  "target",
  "submission",
  "cooperation",
  "average",
  "ceiling",
]);
const CREATOR_PRICE_ROLES = Object.freeze(["generic", "target", "average", "ceiling"]);
const FACT_UNITS = Object.freeze([
  "text",
  "count",
  "yuan",
  "ratio",
  "percent",
  "datetime",
  "format",
  "duration_tier",
  "boolean",
]);

const EXPECTED_SUBJECT = Object.freeze({
  brand_name: "brand",
  project_name: "project",
  product_name: "project",
  creator_count: "creator",
  submission_deadline: "project",
  schedule_window: "route",
  creator_price: "commercial",
  follower_count: "creator",
  rebate_min: "commercial",
  content_direction: "content",
  content_format: "content",
  video_duration: "content",
  creator_gender: "creator",
  creator_city: "creator",
  audience_gender: "audience",
  audience_city: "audience",
  audience_female_rate: "audience",
  audience_male_rate: "audience",
  audience_age_l1_rate: "audience",
  audience_age_l2_rate: "audience",
  audience_age_l3_rate: "audience",
  audience_age_l4_rate: "audience",
  audience_age_l5_rate: "audience",
  audience_age_l6_rate: "audience",
  cpm_max: "commercial",
  cpe_max: "commercial",
  interaction_rate: "commercial",
  click_median: "commercial",
  view_median: "commercial",
  photo_view: "commercial",
  video_interact: "commercial",
  photo_interact: "commercial",
  user_like_count: "commercial",
  like_increment: "commercial",
  avg_view: "commercial",
  avg_like: "commercial",
  avg_comment: "commercial",
  avg_collect: "commercial",
  avg_interact: "commercial",
  has_order_30day: "commercial",
  has_social_30day: "commercial",
  content_feature: "content",
  content_theme: "content",
  creator_persona: "creator",
  creator_type: "creator",
  platform_creator_type: "creator",
  growth_creator_type: "creator",
  industry_tag: "content",
  ip_dependency: "creator",
  creator_url_keyword: "creator",
  organization_affiliation: "creator",
  organization_name: "creator",
  excluded_content: "content",
  preferred_content: "content",
  total_budget: "commercial",
  reference_creator: "creator",
  route_constraint: "route",
  external_condition: "project",
});
const EXPECTED_UNITS = Object.freeze({
  brand_name: ["text"],
  project_name: ["text"],
  product_name: ["text"],
  creator_count: ["count"],
  submission_deadline: ["datetime"],
  creator_price: ["yuan"],
  follower_count: ["count"],
  rebate_min: ["ratio", "percent"],
  content_direction: ["text"],
  content_format: ["format"],
  video_duration: ["duration_tier"],
  creator_gender: ["text"],
  creator_city: ["text"],
  audience_gender: ["text", "ratio", "percent"],
  audience_city: ["text"],
  audience_female_rate: ["ratio", "percent"],
  audience_male_rate: ["ratio", "percent"],
  audience_age_l1_rate: ["ratio", "percent"],
  audience_age_l2_rate: ["ratio", "percent"],
  audience_age_l3_rate: ["ratio", "percent"],
  audience_age_l4_rate: ["ratio", "percent"],
  audience_age_l5_rate: ["ratio", "percent"],
  audience_age_l6_rate: ["ratio", "percent"],
  cpm_max: ["yuan"],
  cpe_max: ["yuan"],
  interaction_rate: ["ratio", "percent"],
  click_median: ["count"],
  view_median: ["count"],
  photo_view: ["count"],
  video_interact: ["count"],
  photo_interact: ["count"],
  user_like_count: ["count"],
  like_increment: ["count"],
  avg_view: ["count"],
  avg_like: ["count"],
  avg_comment: ["count"],
  avg_collect: ["count"],
  avg_interact: ["count"],
  has_order_30day: ["boolean"],
  has_social_30day: ["boolean"],
  content_feature: ["text"],
  content_theme: ["text"],
  creator_persona: ["text"],
  creator_type: ["text"],
  platform_creator_type: ["text"],
  growth_creator_type: ["text"],
  industry_tag: ["text"],
  ip_dependency: ["text"],
  creator_url_keyword: ["text"],
  organization_affiliation: ["text"],
  organization_name: ["text"],
  excluded_content: ["text"],
  preferred_content: ["text"],
  total_budget: ["yuan"],
  reference_creator: ["text"],
  route_constraint: ["text"],
  external_condition: ["text"],
});

const NUMERIC_KINDS = new Set([
  "creator_count",
  "creator_price",
  "follower_count",
  "rebate_min",
  "cpm_max",
  "cpe_max",
  "total_budget",
  "audience_female_rate",
  "audience_male_rate",
  "audience_age_l1_rate",
  "audience_age_l2_rate",
  "audience_age_l3_rate",
  "audience_age_l4_rate",
  "audience_age_l5_rate",
  "audience_age_l6_rate",
  "interaction_rate",
  "click_median",
  "view_median",
  "photo_view",
  "video_interact",
  "photo_interact",
  "user_like_count",
  "like_increment",
  "avg_view",
  "avg_like",
  "avg_comment",
  "avg_collect",
  "avg_interact",
]);
const RATE_KINDS = new Set([
  "rebate_min",
  "audience_gender",
  "audience_female_rate",
  "audience_male_rate",
  "audience_age_l1_rate",
  "audience_age_l2_rate",
  "audience_age_l3_rate",
  "audience_age_l4_rate",
  "audience_age_l5_rate",
  "audience_age_l6_rate",
  "interaction_rate",
]);
const PROVIDER_RANGE_FIELDS = Object.freeze({
  interaction_rate: "interactionRate",
  click_median: "clickMedium",
  view_median: "viewMedium",
  photo_view: "photoView",
  video_interact: "videoInteract",
  photo_interact: "photoInteract",
  user_like_count: "userlikecount",
  like_increment: "likeIncrement",
  avg_view: "avgview",
  avg_like: "avglike",
  avg_comment: "avgcomment",
  avg_collect: "avgcollect",
  avg_interact: "avginteract",
  audience_female_rate: "femaleRate",
  audience_age_l1_rate: "age1Rate",
  audience_age_l2_rate: "age2Rate",
  audience_age_l3_rate: "age3Rate",
  audience_age_l4_rate: "age4Rate",
  audience_age_l5_rate: "age5Rate",
  audience_age_l6_rate: "age6Rate",
});
const PROVIDER_ARRAY_FIELDS = Object.freeze({
  content_feature: "contentFeatureLabel",
  content_theme: "contentThemeLabel",
  creator_persona: "kolPersonaLabel",
  creator_type: "talentTypeLabel",
  industry_tag: "industryTagLabel",
});
const PROVIDER_BOOLEAN_FIELDS = Object.freeze({
  has_order_30day: "hasOrder30day",
  has_social_30day: "hasSocial30day",
});
const REPEATABLE_KINDS = new Set([
  "content_direction",
  "content_feature",
  "content_theme",
  "creator_persona",
  "creator_type",
  "platform_creator_type",
  "growth_creator_type",
  "industry_tag",
  "creator_city",
  "audience_city",
  "excluded_content",
  "preferred_content",
  "reference_creator",
  "route_constraint",
  "external_condition",
]);
const PLACEHOLDER_PATTERN = /^(?:某|一个|待定|未知|暂无|无|品牌方|客户品牌|项目名)$/u;
const PROMPT_INJECTION_PATTERN =
  /(?:忽略|绕过|覆盖|泄露|展示).{0,24}(?:系统|指令|提示词|规则|密钥|凭据)|(?:执行|调用|运行).{0,16}(?:shell|命令|函数|工具)|<\|(?:system|assistant|tool)\|>/iu;
const SHANGHAI_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const ISSUE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "fact_ids"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    fact_ids: { type: "array", items: { type: "string" } },
  },
});

const TRANSFORM_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["fact_id", "field", "policy_id", "input", "output", "reason"],
  properties: {
    fact_id: { type: "string" },
    field: { type: "string" },
    policy_id: { type: "string" },
    input: {},
    output: {},
    reason: { type: "string" },
  },
});

const PROJECTION_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "applicable",
    "ready",
    "params",
    "basic_params",
    "search_jobs",
    "residual_conditions",
    "issues",
    "transforms",
  ],
  properties: {
    applicable: { type: "boolean" },
    ready: { type: "boolean" },
    params: { type: "object" },
    basic_params: { type: "object" },
    search_jobs: { type: "array", items: { type: "object" } },
    residual_conditions: { type: "array", items: { type: "object" } },
    issues: { type: "array", items: ISSUE_SCHEMA },
    transforms: { type: "array", items: TRANSFORM_SCHEMA },
  },
});

export const PARSE_REQUIREMENT_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["original_brief", "platform", "facts"],
  properties: {
    original_brief: {
      type: "string",
      minLength: 1,
      maxLength: 20_000,
      description: "用户最初的完整原文；多平台拆分时每个平台仍传同一份完整原文",
    },
    platform: { type: "string", enum: ["xiaohongshu", "douyin"] },
    clarifications: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 10_000 },
      description: "按时间顺序的后续澄清或改口原文",
    },
    facts: {
      type: "array",
      maxItems: 100,
      description:
        "事实传 kind/quote/value；quote 是原文子串。图文视频均可拆成 picture/video 两条 content_format，共享价格只传一条。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "quote"],
        properties: {
          kind: { type: "string", enum: REQUIREMENT_FACT_KINDS },
          quote: { type: "string", minLength: 1, maxLength: 500 },
          status: { type: "string", enum: FACT_STATUSES },
          strength: { type: "string", enum: FACT_STRENGTHS },
          scope: { type: "string", enum: FACT_SCOPES },
          operator: {
            type: "string",
            enum: FACT_OPERATORS,
          },
          qualifier: {
            type: "string",
            enum: FACT_QUALIFIERS,
          },
          role: { type: "string", enum: FACT_ROLES },
          segment: { type: "string", maxLength: 120 },
          value: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "数值事实只与 exact/lte/gte 搭配使用，必须是已换算的有限数值；禁止“2w内”“1万-5万”等带单位字符串",
          },
          minimum: {
            type: "number",
            description: "仅与 operator=between 搭配使用",
          },
          maximum: {
            type: "number",
            description: "仅与 operator=between 搭配使用；lte 的原文上限应写成 value",
          },
        },
      },
    },
  },
});

export const PARSE_REQUIREMENT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "outcome", "platform", "facts", "projections", "audit"],
  properties: {
    schema_version: { type: "string", const: "requirement-search/v2" },
    outcome: { type: "string", enum: ["ready", "clarification_required"] },
    platform: { type: "string", enum: ["xiaohongshu", "douyin"] },
    facts: { type: "array", items: { type: "object" } },
    projections: {
      type: "object",
      additionalProperties: false,
      required: ["provider"],
      properties: {
        provider: PROJECTION_SCHEMA,
      },
    },
    audit: {
      type: "object",
      additionalProperties: false,
      required: [
        "semantic_ready",
        "conflicts",
        "unresolved_facts",
        "uncovered_segments",
        "security_flags",
        "clarification_questions",
      ],
      properties: {
        semantic_ready: { type: "boolean" },
        conflicts: { type: "array", items: ISSUE_SCHEMA },
        unresolved_facts: { type: "array", items: { type: "string" } },
        uncovered_segments: { type: "array", items: { type: "object" } },
        security_flags: { type: "array", items: { type: "object" } },
        clarification_questions: {
          type: "object",
          additionalProperties: false,
          required: ["provider"],
          properties: {
            provider: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
});

function issue(code, message, factIds = []) {
  return { code, message, fact_ids: factIds };
}

function transform(factId, field, policyId, input, output, reason) {
  return {
    fact_id: factId,
    field,
    policy_id: policyId,
    input,
    output,
    reason,
  };
}

const REBATE_REPAIR_EXAMPLE = Object.freeze({
  source_text: "返点30%以上",
  fact: {
    kind: "rebate_min",
    quote: "返点30%以上",
    value: 30,
  },
  expected_provider_params: { rebate: "[0.3,1]" },
});

const NUMERIC_RANGE_REPAIR_EXAMPLES = Object.freeze({
  creator_price: {
    source_text: "图文达人单价2万以内",
    fact: {
      kind: "creator_price",
      quote: "图文达人单价2万以内",
      value: 20_000,
    },
    expected_provider_params: { kolOfficialPriceL1: "[14000,24000]" },
  },
  cpm: {
    source_text: "图文CPM不超过100",
    fact: {
      kind: "cpm_max",
      quote: "图文CPM不超过100",
      value: 100,
    },
    expected_provider_params: { cpmL1: "[0,100]" },
  },
  cpe: {
    source_text: "图文CPE不超过20",
    fact: {
      kind: "cpe_max",
      quote: "图文CPE不超过20",
      value: 20,
    },
    expected_provider_params: { cpeL1: "[0,20]" },
  },
  rate: {
    source_text: "互动率5%以上",
    fact: {
      kind: "interaction_rate",
      quote: "互动率5%以上",
      value: 5,
    },
    expected_provider_params: { interactionRate: "[0.05,1]" },
  },
  female_rate: {
    source_text: "女粉占比70%以上",
    fact: {
      kind: "audience_female_rate",
      quote: "女粉占比70%以上",
      value: 70,
    },
    expected_provider_params: { femaleRate: "[0.7,1]" },
  },
});

function rebateRateViolation(path) {
  return `${path} 的返点比例必须在 0–1：若原文是“返点30%以上”，请传 value=30；工具会输出 rebate="[0.3,1]"。不要传小数 0.3 或 Provider 区间`;
}

function rateValueViolation(path, kind) {
  if (kind === "audience_female_rate") {
    return `${path} 的女粉比例必须在 0–1：若原文是“女粉占比70%以上”，请传 value=70；工具会输出 femaleRate="[0.7,1]"。不要传小数 0.7`;
  }
  if (kind === "interaction_rate") {
    return `${path} 的互动率必须在 0–1：若原文是“互动率5%以上”，请传 value=5；工具会输出 interactionRate="[0.05,1]"。不要传小数 0.05`;
  }
  return `${path} 的比例必须在 0–1：百分比原文保留百分数 value，例如 70% 应传 value=70，而不是小数 0.7`;
}

function violationCode(message) {
  if (/source_quote 不是/u.test(message)) return "SOURCE_QUOTE_NOT_EXACT";
  if (/数字值无法由 source_quote/u.test(message)) return "VALUE_NOT_SUPPORTED_BY_QUOTE";
  if (/返点比例/u.test(message)) return "REBATE_PERCENT_SCALE_INVALID";
  if (/女粉比例/u.test(message)) return "AUDIENCE_RATE_SCALE_INVALID";
  if (/互动率/u.test(message) && /0–1/u.test(message)) return "INTERACTION_RATE_SCALE_INVALID";
  if (/\.value 不是 picture\/video/u.test(message)) return "CONTENT_FORMAT_INVALID";
  if (/抖音时长档/u.test(message)) return "VIDEO_DURATION_INVALID";
  if (/必须是精确到秒的绝对时间/u.test(message)) return "DEADLINE_FORMAT_INVALID";
  if (/between 必须同时提供/u.test(message)) return "NUMERIC_RANGE_BOUNDS_MISSING";
  if (/\.value 必须是有限数字/u.test(message)) return "NUMERIC_VALUE_INVALID";
  if (/\.value 不得为空/u.test(message)) return "FACT_VALUE_MISSING";
  if (/不受支持/u.test(message)) return "FACT_ENUM_INVALID";
  return "FACT_INPUT_INVALID";
}

function violationExpected(code, message) {
  if (code === "CONTENT_FORMAT_INVALID") {
    return "value 必须是 picture 或 video；原文同时允许图文和视频时拆成两条 content_format fact";
  }
  if (code === "VIDEO_DURATION_INVALID") {
    return "value 必须是 duration_l1、duration_l2 或 duration_l3";
  }
  if (code === "NUMERIC_RANGE_BOUNDS_MISSING") {
    return "operator=between 时必须同时提供有限数字 minimum 和 maximum";
  }
  if (code === "NUMERIC_VALUE_INVALID") return "value 必须是已换算的有限数字";
  if (code === "FACT_VALUE_MISSING") return "present fact 必须提供非空 value";
  const expected = message.match(/(?:必须|应为|只允许|只接受)(.+)$/u)?.[1]?.trim();
  if (expected) return expected;
  if (/source_quote 不是/u.test(message)) return "quote 必须是用户原文中的连续逐字子串";
  if (/数字值无法由 source_quote/u.test(message)) return "value/minimum/maximum 必须能由对应原文数字直接换算得到";
  return "符合该 fact kind 的输入契约";
}

function violationContext(message, input) {
  const match = message.match(/^facts\[(\d+)\](?:\.([A-Za-z_]+))?/u);
  const rawFact = match && Array.isArray(input?.facts) ? input.facts[Number(match[1])] : null;
  const field = match?.[2] ?? null;
  const actual = isRecord(rawFact) && field ? rawFact[field] : rawFact;
  const percentage = String(rawFact?.quote ?? "").match(/(\d+(?:\.\d+)?)\s*%/u)?.[1];
  let replacement;
  if (percentage && RATE_KINDS.has(rawFact?.kind)) replacement = { value: Number(percentage) };
  else if (rawFact?.kind === "content_format") {
    const value = normalizedContentFormat(rawFact.value) ?? normalizedContentFormat(rawFact.quote);
    if (value) replacement = { value };
  } else if (rawFact?.kind === "video_duration") {
    const value = normalizedDurationTier(rawFact.value) ?? normalizedDurationTier(rawFact.quote);
    if (value) replacement = { value };
  }
  return { actual, replacement };
}

function violationDetail(message, input) {
  const path = message.match(/^(facts\[\d+\](?:\.[A-Za-z_]+)?)/u)?.[1] ?? "$";
  const code = violationCode(message);
  const { actual, replacement } = violationContext(message, input);
  const remove =
    !replacement && ["SOURCE_QUOTE_NOT_EXACT", "VALUE_NOT_SUPPORTED_BY_QUOTE"].includes(code);
  const expected = violationExpected(code, message);
  return {
    code,
    path,
    message,
    ...(actual !== undefined ? { actual } : {}),
    expected,
    repair: {
      action: remove ? "remove" : "replace",
      instruction: remove
        ? "删除这条无原文证据的 fact，或改用原文中真实存在且语义匹配的 quote/value 重新构造"
        : replacement
          ? `将 ${path} 按 replacement 精确替换；不要更改用户业务含义`
          : `将 ${path} 修正为：${expected}；不要更改用户业务含义`,
      ...(replacement ? { replacement } : {}),
    },
  };
}

function invalid(violations, input) {
  const violationDetails = violations.map((message) => violationDetail(message, input));
  return {
    success: false,
    error: {
      code: "YPSCAN_REQUIREMENT_INVALID",
      message:
        "需求事实输入无效；请逐项按 violations 修正 facts 后重试，不要把 Provider 参数倒填为事实",
      details: {
        outcome: "invalid_agent_input",
        violations,
        violation_details: violationDetails,
        repair: {
          instruction:
            "按 violation_details 一次性修正全部 facts；每个 code/path 组合只自动修复一次。百分比保留原始百分点，例如 70% 传 value=70。若相同 code/path 再次出现，停止重试并报告集成错误；新的 code/path 仍按本次 repair 继续一次有界修复。",
          retry_policy: {
            automatic_retries_per_code_path: 1,
            stop_on_repeated_code_path: true,
            ask_user_only_for_business_ambiguity: true,
          },
          rebate_example: REBATE_REPAIR_EXAMPLE,
          numeric_range_examples: NUMERIC_RANGE_REPAIR_EXAMPLES,
        },
      },
    },
  };
}

function sourceSegments(sourceId, text) {
  const segments = [];
  for (const match of text.matchAll(/[^，,。；;\n【】[\]（）()]+/gu)) {
    const value = match[0].trim().replace(/^[-*•\d.、)）\s]+/u, "");
    if (!value) continue;
    segments.push({ source_id: sourceId, text: value });
  }
  return segments;
}

function textValues(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function normalizedGender(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["男", "男性", "male"].includes(normalized)) return "男";
  if (["女", "女性", "female"].includes(normalized)) return "女";
  return null;
}

function normalizedContentFormat(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["picture", "图文", "笔记"].includes(normalized)) return "picture";
  if (["video", "视频"].includes(normalized)) return "video";
  if (/\d+\s*(?:s|秒)\s*(?:\+|以上)/iu.test(normalized)) return "video";
  return null;
}

function normalizedDurationTier(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["duration_l1", "l1", "1-20", "1–20", "1-20秒", "1–20秒"].includes(normalized)) {
    return "duration_l1";
  }
  if (["duration_l2", "l2", "21-60", "21–60", "21-60秒", "21–60秒"].includes(normalized)) {
    return "duration_l2";
  }
  if (["duration_l3", "l3", "60+", "60s+", "60秒以上", "60秒+"].includes(normalized)) {
    return "duration_l3";
  }
  if (/(?:^|[^\d])60\s*(?:s|秒)?\s*(?:\+|以上)/iu.test(normalized)) return "duration_l3";
  if (/(?:21\s*(?:-|–|~|～|至|到)\s*60)\s*(?:s|秒)?/iu.test(normalized)) {
    return "duration_l2";
  }
  if (/(?:1\s*(?:-|–|~|～|至|到)\s*20)\s*(?:s|秒)?/iu.test(normalized)) {
    return "duration_l1";
  }
  return null;
}

function numericCandidates(text, kind, unit) {
  const candidates = [];
  const multiplier = (suffix) => {
    const value = String(suffix ?? "").toLowerCase();
    if (value === "万" || value === "w") return 10_000;
    if (value === "千" || value === "k") return 1_000;
    return 1;
  };
  for (const match of text.matchAll(
    /(\d+(?:\.\d+)?)\s*(万|w|千|k)?\s*(?:-|~|～|—|至|到)\s*(\d+(?:\.\d+)?)\s*(万|w|千|k)?/giu,
  )) {
    const left = Number(match[1]);
    const right = Number(match[3]);
    const leftUnit = match[2] ?? "";
    const rightUnit = match[4] ?? "";
    if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
    let normalizedLeft = left * multiplier(leftUnit);
    let normalizedRight = right * multiplier(rightUnit);
    if (!leftUnit && rightUnit) {
      const sharedUnitLeft = left * multiplier(rightUnit);
      normalizedLeft = sharedUnitLeft <= normalizedRight ? sharedUnitLeft : left;
    } else if (leftUnit && !rightUnit) {
      const sharedUnitRight = right * multiplier(leftUnit);
      normalizedRight = normalizedLeft <= sharedUnitRight ? sharedUnitRight : right;
    }
    candidates.push(normalizedLeft, normalizedRight);
  }
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(万|w|千|k|%|成)?/giu)) {
    const number = Number(match[1]);
    const suffix = String(match[2] ?? "").toLowerCase();
    if (!Number.isFinite(number)) continue;
    if (suffix === "万" || suffix === "w") candidates.push(number * 10_000);
    else if (suffix === "千" || suffix === "k") candidates.push(number * 1_000);
    else if (suffix === "%") candidates.push(number / 100);
    else if (suffix === "成") candidates.push(number / 10);
    else if (unit === "percent" || kind === "rebate_min") candidates.push(number / 100, number);
    else candidates.push(number);
  }
  return candidates;
}

function nearlyEqual(left, right) {
  return Math.abs(left - right) <= Math.max(0.000_001, Math.abs(right) * 0.000_001);
}

function evidenceContext(source, quote) {
  const index = source.indexOf(quote);
  if (index < 0) return quote;
  const clauseStart = Math.max(
    source.lastIndexOf("，", index),
    source.lastIndexOf(",", index),
    source.lastIndexOf("。", index),
    source.lastIndexOf("；", index),
    source.lastIndexOf("\n", index),
  );
  const following = ["，", ",", "。", "；", "\n"]
    .map((token) => source.indexOf(token, index + quote.length))
    .filter((position) => position >= 0);
  const clauseEnd = following.length > 0 ? Math.min(...following) : source.length;
  return source.slice(clauseStart + 1, clauseEnd);
}

function rawNumericTargets(fact) {
  if (fact.operator === "between") return [fact.minimum, fact.maximum].map(Number);
  if (["exact", "lte", "gte"].includes(fact.operator)) return [Number(fact.value)];
  return [];
}

function normalizeNumericFact(fact) {
  if (fact.operator === "any") {
    return { value: null, minimum: null, maximum: null };
  }
  const ratio = RATE_KINDS.has(fact.kind) && fact.unit === "percent" ? 0.01 : 1;
  const scaled = (value) => {
    const normalized = Number(value) * ratio;
    return RATE_KINDS.has(fact.kind) ? Math.round(normalized * 1_000_000) / 1_000_000 : normalized;
  };
  if (fact.operator === "between") {
    const minimum = scaled(fact.minimum);
    const maximum = scaled(fact.maximum);
    return { value: null, minimum, maximum };
  }
  const value = scaled(fact.value);
  return { value, minimum: null, maximum: null };
}

function factComparable(fact) {
  return JSON.stringify({
    operator: fact.operator,
    qualifier: fact.qualifier,
    role: fact.role,
    segment: fact.segment,
    value: fact.normalized_value,
    minimum: fact.minimum,
    maximum: fact.maximum,
  });
}

function conflictKey(fact) {
  if (REPEATABLE_KINDS.has(fact.kind)) return null;
  return [
    fact.segment ?? "shared",
    fact.kind,
    [
      "creator_count",
      "creator_price",
      "cpm_max",
      "cpe_max",
      "content_format",
      "video_duration",
    ].includes(fact.kind)
      ? fact.qualifier
      : "generic",
    ["creator_count", "creator_price"].includes(fact.kind) ? fact.role : "generic",
  ].join(":");
}

function semanticEvidenceViolation(fact, context) {
  if (
    fact.kind === "creator_price" &&
    /(?:不是|并非|非|不要按|不按).{0,6}(?:单人|每人|每个达人)/u.test(context)
  ) {
    return "被否定的单人价格不得作为有效达人单价";
  }
  const requiredMarkers = {
    creator_price: /单价|均价|采买价|预算|价格|报价|一口价/u,
    follower_count: /粉(?:丝|量)?|量级/u,
    rebate_min: /返点|返佣|返利/u,
    cpm_max: /cpm/iu,
    cpe_max: /cpe/iu,
    interaction_rate: /互动率/u,
    click_median: /点击.{0,4}中位数|点击中位/u,
    view_median: /(?:阅读|播放|观看).{0,4}中位数/u,
    photo_view: /图文.{0,6}(?:阅读|浏览|观看)/u,
    video_interact: /视频.{0,6}互动/u,
    photo_interact: /图文.{0,6}互动/u,
    user_like_count: /获赞|点赞总数/u,
    like_increment: /点赞.{0,4}增量|涨赞/u,
    avg_view: /平均(?:阅读|播放|观看)|(?:阅读|播放|观看)均值/u,
    avg_like: /平均点赞|点赞均值/u,
    avg_comment: /平均评论|评论均值/u,
    avg_collect: /平均收藏|收藏均值/u,
    avg_interact: /平均互动|互动均值/u,
    audience_female_rate: /粉丝|受众|用户|女粉/u,
    audience_male_rate: /粉丝|受众|用户|男粉/u,
    audience_age_l1_rate: /粉丝|受众|用户|年龄/u,
    audience_age_l2_rate: /粉丝|受众|用户|年龄/u,
    audience_age_l3_rate: /粉丝|受众|用户|年龄/u,
    audience_age_l4_rate: /粉丝|受众|用户|年龄/u,
    audience_age_l5_rate: /粉丝|受众|用户|年龄/u,
    audience_age_l6_rate: /粉丝|受众|用户|年龄/u,
    has_order_30day: /近?30天|近一个月|商单/u,
    has_social_30day: /近?30天|近一个月|社交|内容/u,
  };
  const marker = requiredMarkers[fact.kind];
  if (marker && !marker.test(context)) return `${fact.kind} 的证据语义不匹配`;
  const hasLowerBound = /至少|不低于|以上|起(?:步)?|[≥>]/u.test(context);
  const hasUpperBound = /不超过|不高于|以内|以下|封顶|最高|低于|小于|[≤<]/u.test(context);
  const hasNegatedBound =
    /(?:大于|超过|高于|以上|低于|小于|以下|以内).{0,10}(?:不要|排除|不能|禁止)|(?:不要|排除|不能|禁止).{0,10}(?:大于|超过|高于|以上|低于|小于|以下|以内)/u.test(
      context,
    );
  if (fact.operator === "lte" && hasLowerBound && !hasUpperBound && !hasNegatedBound) {
    return "原文表达下限，不能映射为上限";
  }
  if (fact.operator === "gte" && hasUpperBound && !hasLowerBound && !hasNegatedBound) {
    return "原文表达上限，不能映射为下限";
  }
  if (fact.operator === "between" && !/(?:-|~|～|—|至|到)/u.test(context)) {
    return "between 必须由原文范围表达支持";
  }
  if (fact.kind === "creator_price" && /总(?:体|共)?预算|预算总共|项目预算/u.test(context)) {
    if (!/单价|达人价|达人报价|一口价|每人|每个/u.test(context)) {
      return "总预算不得映射为达人单价";
    }
  }
  if (fact.kind === "total_budget" && !/总(?:体|共)?预算|预算总共|项目预算/u.test(context)) {
    return "total_budget 必须由总预算语义支持";
  }
  if (fact.kind === "creator_gender") {
    if (/粉丝|受众|用户|男粉|女粉/u.test(context)) {
      return "粉丝/受众性别不得映射为达人本人性别";
    }
    if (/(?:不是|不要|非|不限|不限定).{0,8}(?:男|女).{0,4}(?:达人|博主|创作者)/u.test(context)) {
      return "被否定的达人性别不得作为有效硬条件";
    }
  }
  if (fact.kind === "audience_gender" && !/粉丝|受众|用户|男粉|女粉/u.test(context)) {
    return "audience_gender 必须由粉丝/受众语义支持";
  }
  if (fact.kind === "creator_city" && /粉丝|受众|用户|男粉|女粉/u.test(context)) {
    return "粉丝/受众地域不得映射为达人所在地";
  }
  if (fact.kind === "audience_city" && !/粉丝|受众|用户|男粉|女粉/u.test(context)) {
    return "audience_city 必须由粉丝/受众地域语义支持";
  }
  if (
    fact.kind === "creator_count" &&
    !/数量|[*×]\s*\d+|(?:合作|提报|招募)\s*\d+|\d+\s*(?:位|个|人|名)\s*(?:达人|博主|创作者|KOL|KOC|号)|达人.{0,6}\d/iu.test(
      context,
    )
  ) {
    return "creator_count 必须由明确达人数量语义支持";
  }
  if (fact.kind === "creator_count") {
    const roleEvidence = fact.source_quote || context;
    const mentionsSubmission = /提报/u.test(roleEvidence);
    const mentionsCooperation = /合作/u.test(roleEvidence);
    if (!(mentionsSubmission && mentionsCooperation)) {
      const inferredRole = mentionsSubmission
        ? "submission"
        : mentionsCooperation
          ? "cooperation"
          : "target";
      if (!["generic", inferredRole].includes(fact.role)) {
        return `creator_count.role 应为 ${inferredRole}`;
      }
    }
  }
  if (
    [
      "brand_name",
      "project_name",
      "product_name",
      "creator_city",
      "audience_city",
      "external_condition",
    ].includes(fact.kind)
  ) {
    const missingValue = textValues(fact.value).find((value) => !context.includes(value));
    if (missingValue) return `${fact.kind} 的值无法由引用原文支持`;
  }
  if (fact.kind === "content_direction" && /不要|排除|不能|不接受|禁止/u.test(context)) {
    return "排除内容不得映射为必选内容方向";
  }
  return null;
}

function sourceIdForQuote(sources, quote) {
  for (const [sourceId, source] of [...sources.entries()].reverse()) {
    if (quote && source.includes(quote)) return sourceId;
  }
  return "original_brief";
}

function defaultUnitFor(kind) {
  if (RATE_KINDS.has(kind) && kind !== "audience_gender") return "percent";
  return EXPECTED_UNITS[kind]?.[0] ?? "text";
}

function inferredOperator(rawFact, quote) {
  const maximumMetric = ["cpm_max", "cpe_max"].includes(rawFact.kind);
  if (rawFact.operator !== undefined) {
    return maximumMetric && rawFact.operator === "exact" ? "lte" : rawFact.operator;
  }
  if (rawFact.minimum !== undefined && rawFact.maximum !== undefined) return "between";
  if (rawFact.value === undefined && /不限|不限制|无要求/u.test(quote)) return "any";
  if (rawFact.kind === "excluded_content") return "not_in";
  if (rawFact.kind === "preferred_content") return "preference";
  const lowerRejected =
    /(?:低于|小于|少于|不足|以下|以内).{0,10}(?:不要|排除|不能|禁止)|(?:不要|排除|不能|禁止).{0,10}(?:低于|小于|少于|不足|以下|以内)/u.test(
      quote,
    );
  const upperRejected =
    /(?:大于|超过|高于|以上|起(?:步)?).{0,10}(?:不要|排除|不能|禁止)|(?:不要|排除|不能|禁止).{0,10}(?:大于|超过|高于|以上|起(?:步)?)/u.test(
      quote,
    );
  if (lowerRejected) return "gte";
  if (upperRejected) return "lte";
  if (/至少|不低于|以上|起(?:步)?|[≥>＞]/u.test(quote)) return "gte";
  if (/不超过|不高于|以内|以下|封顶|最高|低于|小于|[≤<＜]/u.test(quote)) return "lte";
  if (maximumMetric) return "lte";
  if (rawFact.kind === "rebate_min") return "gte";
  return "exact";
}

function inferredQualifier(rawFact, quote) {
  if (rawFact.qualifier !== undefined) return rawFact.qualifier;
  if (rawFact.kind === "content_format") {
    const format = normalizedContentFormat(rawFact.value);
    if (format) return format;
  }
  const mentionsPicture = /图文/u.test(quote);
  const mentionsVideo = /视频/u.test(quote);
  if (mentionsPicture && mentionsVideo) return "generic";
  if (mentionsPicture) return "picture";
  if (mentionsVideo) return "video";
  return "generic";
}

function inferredRole(rawFact, quote) {
  if (rawFact.role !== undefined) return rawFact.role;
  if (rawFact.kind === "creator_count") {
    if (/提报/u.test(quote) && !/合作/u.test(quote)) return "submission";
    if (/合作/u.test(quote) && !/提报/u.test(quote)) return "cooperation";
    return "target";
  }
  return rawFact.kind === "creator_price" ? "target" : "generic";
}

function compactFactValue(rawFact, quote) {
  if (rawFact.kind === "video_duration" && rawFact.value === undefined) {
    return normalizedDurationTier(rawFact.qualifier) ?? normalizedDurationTier(quote) ?? undefined;
  }
  return rawFact.value;
}

function isQualitativeAudiencePreference(rawFact, quote) {
  return (
    ["audience_female_rate", "audience_male_rate"].includes(rawFact.kind) &&
    rawFact.strength !== "hard" &&
    /偏多|为主|较多|倾向|优先|可放宽/u.test(quote) &&
    !/\d|%|成/u.test(quote)
  );
}

function derivedDurationFact(rawFact, quote, platform, hasDurationFact) {
  if (hasDurationFact || platform !== "douyin" || rawFact.kind !== "content_format") return null;
  const duration = normalizedDurationTier(rawFact.value) ?? normalizedDurationTier(quote);
  if (!duration) return null;
  return {
    kind: "video_duration",
    quote,
    value: duration,
    scope: rawFact.scope,
    strength: rawFact.strength,
  };
}

function expandCompactFacts(input, sources) {
  const inputFacts = Array.isArray(input.facts) ? input.facts : [];
  const hasDurationFact = inputFacts.some(
    (fact) => isRecord(fact) && fact.kind === "video_duration",
  );
  const expandedFacts = inputFacts.flatMap((rawFact) => {
    if (!isRecord(rawFact)) return [rawFact];
    const quote = String(rawFact.quote ?? "").trim();
    const derived = derivedDurationFact(rawFact, quote, input.platform, hasDurationFact);
    return derived ? [rawFact, derived] : [rawFact];
  });
  return {
    ...input,
    facts: expandedFacts.map((rawFact, index) => {
      if (!isRecord(rawFact)) return rawFact;
      const quote = String(rawFact.quote ?? "").trim();
      const kind = rawFact.kind;
      const qualitativeAudiencePreference = isQualitativeAudiencePreference(rawFact, quote);
      return {
        id: `fact-${index + 1}`,
        kind,
        status: rawFact.status ?? "present",
        strength: rawFact.strength ?? "hard",
        scope: rawFact.scope ?? "shared",
        operator: qualitativeAudiencePreference
          ? "preference"
          : inferredOperator({ ...rawFact, kind }, quote),
        qualifier: inferredQualifier(rawFact, quote),
        role: inferredRole({ ...rawFact, kind }, quote),
        segment: rawFact.segment,
        unit: defaultUnitFor(kind),
        value: qualitativeAudiencePreference
          ? undefined
          : compactFactValue({ ...rawFact, kind }, quote),
        minimum: rawFact.minimum,
        maximum: rawFact.maximum,
        source_id: sourceIdForQuote(sources, quote),
        source_quote: quote,
      };
    }),
  };
}

function normalizeFacts(input, sources) {
  const violations = [];
  const issues = [];
  const ids = new Set();
  const facts = [];
  const inputFacts = Array.isArray(input.facts) ? input.facts : [];
  inputFacts.forEach((rawFact, index) => {
    const path = `facts[${index}]`;
    if (!isRecord(rawFact)) {
      violations.push(`${path} 必须是对象`);
      return;
    }
    const fact = {
      id: String(rawFact.id ?? "").trim(),
      kind: String(rawFact.kind ?? "").trim(),
      status: String(rawFact.status ?? "present").trim(),
      strength: String(rawFact.strength ?? "hard").trim(),
      scope: String(rawFact.scope ?? "shared").trim(),
      subject: String(EXPECTED_SUBJECT[rawFact.kind] ?? rawFact.subject ?? "project").trim(),
      operator: String(rawFact.operator ?? "exact").trim(),
      qualifier: String(rawFact.qualifier ?? "generic").trim(),
      role: String(
        rawFact.role ??
          (rawFact.kind === "creator_count" || rawFact.kind === "creator_price"
            ? "target"
            : "generic"),
      ).trim(),
      segment: String(rawFact.segment ?? "").trim(),
      unit: String(rawFact.unit ?? EXPECTED_UNITS[rawFact.kind]?.[0] ?? "text").trim(),
      value: rawFact.value,
      minimum: rawFact.minimum,
      maximum: rawFact.maximum,
      source_id: String(rawFact.source_id ?? "").trim(),
      source_quote: String(rawFact.source_quote ?? "").trim(),
    };
    if (!fact.id || !/^[A-Za-z0-9._:-]+$/u.test(fact.id)) violations.push(`${path}.id 无效`);
    else if (ids.has(fact.id)) violations.push(`${path}.id 重复：${fact.id}`);
    else ids.add(fact.id);
    if (!REQUIREMENT_FACT_KINDS.includes(fact.kind)) violations.push(`${path}.kind 不受支持`);
    if (!FACT_STATUSES.includes(fact.status)) violations.push(`${path}.status 不受支持`);
    if (!FACT_STRENGTHS.includes(fact.strength)) violations.push(`${path}.strength 不受支持`);
    if (!FACT_SCOPES.includes(fact.scope)) violations.push(`${path}.scope 不受支持`);
    if (!FACT_SUBJECTS.includes(fact.subject)) violations.push(`${path}.subject 不受支持`);
    if (!FACT_OPERATORS.includes(fact.operator)) violations.push(`${path}.operator 不受支持`);
    if (!FACT_QUALIFIERS.includes(fact.qualifier)) violations.push(`${path}.qualifier 不受支持`);
    if (!FACT_ROLES.includes(fact.role)) violations.push(`${path}.role 不受支持`);
    if (fact.kind === "creator_price" && !CREATOR_PRICE_ROLES.includes(fact.role)) {
      violations.push(`${path}.role 应为 ${CREATOR_PRICE_ROLES.join("/")}`);
    }
    if (fact.segment.length > 120) violations.push(`${path}.segment 过长`);
    if (!FACT_UNITS.includes(fact.unit)) violations.push(`${path}.unit 不受支持`);
    if (EXPECTED_UNITS[fact.kind] && !EXPECTED_UNITS[fact.kind].includes(fact.unit)) {
      violations.push(`${path}.unit 应为 ${EXPECTED_UNITS[fact.kind].join("/")}`);
    }
    const source = sources.get(fact.source_id);
    if (fact.status !== "missing" || fact.source_quote) {
      if (!source) violations.push(`${path}.source_id 不存在：${fact.source_id}`);
      else if (!fact.source_quote || !source.includes(fact.source_quote)) {
        violations.push(`${path}.source_quote 不是 source_id 对应用户原文的精确子串`);
      }
    }

    let normalizedValue = rawFact.value ?? null;
    let minimum = null;
    let maximum = null;
    const numericFact =
      NUMERIC_KINDS.has(fact.kind) ||
      (fact.kind === "audience_gender" && ["ratio", "percent"].includes(fact.unit));
    const qualitativeRatePreference =
      fact.status === "present" &&
      numericFact &&
      fact.strength !== "hard" &&
      fact.operator === "preference" &&
      (fact.value === null || fact.value === undefined || fact.value === "");
    if (qualitativeRatePreference) {
      normalizedValue = fact.source_quote;
    } else if (fact.status === "present" && numericFact) {
      if (fact.operator === "between") {
        if (!Number.isFinite(Number(fact.minimum)) || !Number.isFinite(Number(fact.maximum))) {
          violations.push(`${path} 的 between 必须同时提供有限 minimum/maximum`);
        }
      } else if (
        !["any"].includes(fact.operator) &&
        (fact.value === null ||
          fact.value === undefined ||
          fact.value === "" ||
          !Number.isFinite(Number(fact.value)))
      ) {
        const fallback =
          fact.operator === "lte"
            ? Number(fact.maximum)
            : fact.operator === "gte"
              ? Number(fact.minimum)
              : NaN;
        if (Number.isFinite(fallback)) {
          fact.value = fallback;
        } else {
          violations.push(`${path}.value 必须是有限数字`);
        }
      }
      ({ value: normalizedValue, minimum, maximum } = normalizeNumericFact(fact));
      const values = [normalizedValue, minimum, maximum].filter((value) => value !== null);
      if (
        values.some((value) => value < 0) ||
        (minimum !== null && maximum !== null && minimum > maximum)
      ) {
        violations.push(`${path} 的数字范围无效`);
      }
      if (RATE_KINDS.has(fact.kind)) {
        if (values.some((value) => value > 1)) {
          const rawTargets = rawNumericTargets(fact);
          const candidates = source
            ? numericCandidates(evidenceContext(source, fact.source_quote), fact.kind, fact.unit)
            : [];
          const sourceContainsInvalidRate = rawTargets.some(
            (target) =>
              target > 100 &&
              candidates.some(
                (value) => nearlyEqual(value, target) || nearlyEqual(value, target / 100),
              ),
          );
          if (sourceContainsInvalidRate) {
            issues.push(
              issue(
                "RATE_VALUE_OUT_OF_RANGE",
                `比例必须在 0%–100% 之间；当前原文“${fact.source_quote}”超出合法范围`,
                [fact.id],
              ),
            );
          } else {
            violations.push(
              fact.kind === "rebate_min"
                ? rebateRateViolation(path)
                : rateValueViolation(path, fact.kind),
            );
          }
        }
      }
      if (source && fact.source_quote && fact.operator !== "any") {
        const context = evidenceContext(source, fact.source_quote);
        const candidates = numericCandidates(context, fact.kind, fact.unit);
        const targets = rawNumericTargets(fact).map((value) =>
          RATE_KINDS.has(fact.kind) && fact.unit === "percent" ? value / 100 : value,
        );
        if (
          targets.some((target) => !candidates.some((candidate) => nearlyEqual(candidate, target)))
        ) {
          violations.push(`${path} 的数字值无法由 source_quote 所在原文片段支持`);
        }
      }
    } else if (fact.status === "present") {
      if (["has_order_30day", "has_social_30day"].includes(fact.kind)) {
        if (typeof rawFact.value !== "boolean") violations.push(`${path}.value 必须是 boolean`);
        normalizedValue = rawFact.value;
      }
      const values = textValues(rawFact.value);
      if (
        !["has_order_30day", "has_social_30day"].includes(fact.kind) &&
        values.length === 0 &&
        fact.operator !== "any"
      ) {
        violations.push(`${path}.value 不得为空`);
      }
      if (!["has_order_30day", "has_social_30day"].includes(fact.kind)) {
        normalizedValue = Array.isArray(rawFact.value) ? values : (values[0] ?? null);
      }
      if (fact.kind === "creator_gender" && !normalizedGender(normalizedValue)) {
        violations.push(`${path}.value 不是可识别的达人性别`);
      }
      if (fact.kind === "content_format" && !normalizedContentFormat(normalizedValue)) {
        violations.push(`${path}.value 不是 picture/video`);
      } else if (fact.kind === "content_format") {
        normalizedValue = normalizedContentFormat(normalizedValue);
      }
      if (fact.kind === "video_duration" && !normalizedDurationTier(normalizedValue)) {
        violations.push(`${path}.value 不是可识别的抖音时长档`);
      } else if (fact.kind === "video_duration") {
        normalizedValue = normalizedDurationTier(normalizedValue);
      }
      if (fact.kind === "submission_deadline") {
        const text = String(normalizedValue ?? "");
        if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?$/u.test(text)) {
          issues.push(
            issue(
              "DEADLINE_ABSOLUTE_TIME_REQUIRED",
              `提报截止时间必须是精确到秒的未来绝对时间；当前值“${text || fact.source_quote}”无法直接落库`,
              [fact.id],
            ),
          );
        }
      }
    }
    if (source && fact.source_quote && fact.status === "present") {
      const context = evidenceContext(source, fact.source_quote);
      const semanticViolation = semanticEvidenceViolation(fact, context);
      if (semanticViolation) violations.push(`${path}: ${semanticViolation}`);
    }
    const securityExcluded = Boolean(
      source &&
      fact.source_quote &&
      PROMPT_INJECTION_PATTERN.test(evidenceContext(source, fact.source_quote)),
    );
    const activeScope = fact.scope === "shared" || fact.scope === input.platform;
    const disposition = securityExcluded
      ? "security_excluded"
      : fact.status === "superseded"
        ? "superseded"
        : fact.status !== "present"
          ? "unresolved"
          : activeScope
            ? "active"
            : "out_of_scope";
    facts.push({
      id: fact.id,
      kind: fact.kind,
      status: fact.status,
      strength: fact.strength,
      scope: fact.scope,
      subject: fact.subject,
      operator: fact.operator,
      qualifier: fact.qualifier,
      role: fact.role,
      segment: fact.segment || null,
      unit: fact.unit,
      normalized_value: normalizedValue,
      minimum,
      maximum,
      source: { id: fact.source_id, quote: fact.source_quote },
      disposition,
    });
  });
  return { facts, violations, issues };
}

function collectConflicts(facts) {
  const groups = new Map();
  for (const fact of facts.filter(
    (item) => item.disposition === "active" && item.strength === "hard",
  )) {
    const key = conflictKey(fact);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fact);
  }
  const conflicts = [];
  for (const [key, group] of groups) {
    if (new Set(group.map(factComparable)).size > 1) {
      conflicts.push(
        issue(
          "REQUIREMENT_FACT_CONFLICT",
          `${key} 存在多个不一致的有效值；必须明确当前值或标记旧值 superseded`,
          group.map((fact) => fact.id),
        ),
      );
    }
  }
  for (const fact of facts.filter(
    (item) => item.status === "conflicting" && item.strength === "hard",
  )) {
    conflicts.push(
      issue("REQUIREMENT_FACT_CONFLICT", `${fact.kind} 已标记为 conflicting`, [fact.id]),
    );
  }
  return conflicts;
}

function collectCoverage(sources, facts, platform) {
  const uncoveredSegments = [];
  const securityFlags = [];
  for (const [sourceId, source] of sources) {
    for (const segment of sourceSegments(sourceId, source)) {
      if (PROMPT_INJECTION_PATTERN.test(segment.text)) {
        securityFlags.push({
          source_id: sourceId,
          text: segment.text,
          action: "excluded_from_business_projection",
        });
        continue;
      }
      const covered = facts.some((fact) => {
        const quote = fact.source.quote;
        return (
          fact.source.id === sourceId &&
          quote &&
          (quote.length >= 2 || quote === segment.text) &&
          (segment.text.includes(quote) || quote.includes(segment.text))
        );
      });
      const platformOnly =
        /平台/u.test(segment.text) &&
        (platform === "xiaohongshu" ? /小红书|xiaohongshu|xhs/iu : /抖音|douyin|dy/iu).test(
          segment.text,
        );
      // 不做业务信号词闸门：任何未被事实引用的原文段落都要浮出，避免漏提档期/女粉等条款。
      if (!covered && !platformOnly && segment.text.length >= 3) {
        uncoveredSegments.push(segment);
      }
    }
  }
  return { uncoveredSegments, securityFlags };
}

function factList(facts, kind) {
  return facts.filter((fact) => fact.disposition === "active" && fact.kind === kind);
}

function firstFact(facts, kind) {
  return factList(facts, kind)[0] ?? null;
}

function factListForSegment(facts, kind, segment) {
  const items = factList(facts, kind);
  if (!segment) return items;
  const scoped = items.filter((fact) => fact.segment === segment);
  const shared = items.filter((fact) => !fact.segment);
  if (scoped.length === 0) return shared;
  return REPEATABLE_KINDS.has(kind) ? [...shared, ...scoped] : scoped;
}

function providerFactList(facts, kind, segment = null) {
  return factListForSegment(facts, kind, segment).filter((fact) => fact.strength === "hard");
}

function firstProviderFact(facts, kind, segment = null) {
  return providerFactList(facts, kind, segment)[0] ?? null;
}

function providerTextFactValues(facts, kind, segment = null) {
  return [
    ...new Set(
      providerFactList(facts, kind, segment).flatMap((fact) => textValues(fact.normalized_value)),
    ),
  ];
}

function referenceCreatorParams(facts, segment = null) {
  const generic = providerTextFactValues(facts, "reference_creator", segment);
  const nicknames = generic.filter((value) => !isHttpUrl(value));
  const urls = generic.filter(isHttpUrl);
  return {
    nickname: [...new Set(nicknames)][0] ?? null,
    url: [...new Set(urls)][0] ?? null,
  };
}

function numericRange(fact, { unrestrictedMaximum = 999_999_999 } = {}) {
  if (!fact) return null;
  if (fact.operator === "any") return { minimum: 0, maximum: unrestrictedMaximum };
  if (fact.operator === "between") return { minimum: fact.minimum, maximum: fact.maximum };
  if (fact.operator === "lte") return { minimum: 0, maximum: fact.normalized_value };
  if (fact.operator === "gte")
    return { minimum: fact.normalized_value, maximum: unrestrictedMaximum };
  if (fact.operator === "exact") {
    return { minimum: fact.normalized_value, maximum: fact.normalized_value };
  }
  return null;
}

function maximumMetricRange(fact) {
  if (!fact) return null;
  if (fact.operator === "any") return { minimum: 0, maximum: 999_999_999 };
  if (fact.operator === "gte") return null;
  const maximum = fact.operator === "between" ? fact.maximum : fact.normalized_value;
  return typeof maximum === "number" && Number.isFinite(maximum) && maximum >= 0
    ? { minimum: 0, maximum }
    : null;
}

function inverseRateRange(fact) {
  const range = numericRange(fact, { unrestrictedMaximum: 1 });
  if (!range) return null;
  const complement = (value) => Math.round((1 - value) * 1_000_000) / 1_000_000;
  return {
    minimum: complement(range.maximum),
    maximum: complement(range.minimum),
  };
}

function serializeRange(range) {
  return JSON.stringify([range.minimum, range.maximum]);
}

function priceTiersForFact(fact, platform, durationFacts, formatFacts = []) {
  if (platform === "xiaohongshu") {
    const formats = [
      ...new Set(
        formatFacts.map((item) => normalizedContentFormat(item.normalized_value)).filter(Boolean),
      ),
    ];
    const selectedFormats = fact.qualifier === "generic" ? formats : [fact.qualifier];
    if (selectedFormats.length === 0) return ["kolOfficialPriceL1"];
    return [
      ...new Set(
        selectedFormats
          .map((format) =>
            format === "picture"
              ? "kolOfficialPriceL1"
              : format === "video"
                ? "kolOfficialPriceL2"
                : null,
          )
          .filter(Boolean),
      ),
    ];
  }
  const durationTiers = [
    ...new Set(
      durationFacts.map((item) => normalizedDurationTier(item.normalized_value)).filter(Boolean),
    ),
  ];
  const qualifier =
    ["generic", "video"].includes(fact.qualifier) && durationTiers.length === 1
      ? durationTiers[0]
      : fact.qualifier;
  if (qualifier === "generic") return [];
  const field = {
    duration_l1: "kolOfficialPriceL1",
    duration_l2: "kolOfficialPriceL2",
    duration_l3: "kolOfficialPriceL3",
  }[qualifier];
  return field ? [field] : [];
}

function metricTiersForFact(fact, platform, durationFacts, formatFacts = []) {
  return priceTiersForFact(fact, platform, durationFacts, formatFacts).map((priceTier) =>
    priceTier.replace("kolOfficialPrice", ""),
  );
}

function providerPriceRange(fact) {
  const raw =
    fact.operator === "between"
      ? { minimum: fact.minimum, maximum: fact.maximum }
      : { minimum: fact.normalized_value, maximum: fact.normalized_value };
  return {
    minimum: Math.floor(raw.minimum * 0.7),
    maximum: Math.ceil(raw.maximum * 1.2),
  };
}

function priceFactsForProjection(facts, segment = null) {
  const allPriceFacts = providerFactList(facts, "creator_price", segment).filter((fact) =>
    CREATOR_PRICE_ROLES.includes(fact.role),
  );
  const preferredPriceRoles = allPriceFacts.filter((fact) =>
    ["target", "average", "generic"].includes(fact.role),
  );
  return preferredPriceRoles.length > 0
    ? preferredPriceRoles
    : allPriceFacts.filter((fact) => fact.role === "ceiling");
}

function countResolution(facts, segment = null) {
  const allCounts = providerFactList(facts, "creator_count", segment).filter(
    (fact) => fact.role !== "cooperation",
  );
  const explicitRoles = new Set(
    allCounts.map((fact) => fact.role).filter((role) => ["target", "submission"].includes(role)),
  );
  if (explicitRoles.size > 1) {
    return {
      value: null,
      issue: issue(
        "CREATOR_COUNT_ROLE_CONFLICT",
        "目标合作数量与提报数量同时存在，必须明确 Provider 本次应搜索的数量",
        allCounts.filter((fact) => explicitRoles.has(fact.role)).map((fact) => fact.id),
      ),
    };
  }
  const role = allCounts.some((fact) => fact.role === "submission")
    ? "submission"
    : allCounts.some((fact) => fact.role === "target")
      ? "target"
      : "generic";
  let counts = allCounts.filter((fact) => fact.role === role);
  counts = [
    ...new Map(
      counts.map((fact) => [
        `${fact.qualifier}:${fact.operator}:${fact.normalized_value}:${fact.minimum}:${fact.maximum}`,
        fact,
      ]),
    ).values(),
  ];
  const nonExact = counts.filter((fact) => fact.operator !== "exact");
  if (nonExact.length > 0) {
    return {
      value: null,
      issue: issue(
        "CREATOR_COUNT_NOT_EXACT",
        "Provider 提报数量必须是明确整数；“至少/N+”需先确认最终提报数",
        nonExact.map((fact) => fact.id),
      ),
    };
  }
  const invalidExact = counts.filter(
    (fact) => !Number.isSafeInteger(fact.normalized_value) || fact.normalized_value <= 0,
  );
  if (invalidExact.length > 0) {
    return {
      value: null,
      issue: issue(
        "CREATOR_COUNT_MUST_BE_POSITIVE_INTEGER",
        "需要的达人数必须是大于 0 的明确整数",
        invalidExact.map((fact) => fact.id),
      ),
    };
  }
  const generic = counts.filter((fact) => fact.qualifier === "generic");
  const qualified = counts.filter((fact) => fact.qualifier !== "generic");
  if (generic.length > 0 && qualified.length > 0) {
    return {
      value: null,
      issue: issue(
        "CREATOR_COUNT_SCOPE_AMBIGUOUS",
        "总数量与分内容形式/时长数量同时存在，必须明确是否相加",
        counts.map((fact) => fact.id),
      ),
    };
  }
  if (generic.length > 0) return { value: generic[0].normalized_value, issue: null };
  if (qualified.length > 0) {
    return {
      value: qualified.reduce((sum, fact) => sum + fact.normalized_value, 0),
      issue: null,
    };
  }
  return { value: null, issue: null };
}

function deadlineValue(fact) {
  if (!fact) return null;
  const value = String(fact.normalized_value);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return value.replace("T", " ");
  const parsed = new Date(value.replace(" ", "T"));
  if (!Number.isFinite(parsed.getTime())) return value.replace("T", " ");
  const parts = Object.fromEntries(
    SHANGHAI_DATE_TIME_FORMATTER.formatToParts(parsed).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function deadlineInstant(fact) {
  const value = String(fact.normalized_value).replace(" ", "T");
  return new Date(/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ? value : `${value}+08:00`);
}

function activeFactSummary(facts) {
  return [
    ...new Set(
      facts
        .filter((fact) => fact.disposition === "active")
        .map((fact) => fact.source.quote)
        .filter(Boolean),
    ),
  ]
    .join("；")
    .slice(0, 1000);
}

function baseProjectionIssues(conflicts, unresolvedFacts, uncoveredSegments) {
  const issues = [...conflicts];
  if (unresolvedFacts.length > 0) {
    issues.push(
      issue(
        "REQUIREMENT_FACT_UNRESOLVED",
        "存在 ambiguous/conflicting 状态的需求事实",
        unresolvedFacts,
      ),
    );
  }
  void uncoveredSegments;
  return issues;
}

function providerJobProjection(input, facts, now, globalIssues, segment) {
  const issues = [...globalIssues];
  const transforms = [];
  const params = {};
  const required = [
    ["brand_name", "品牌名"],
    ["project_name", "项目名"],
    ["creator_count", "达人数量"],
    ["submission_deadline", "提报截止时间"],
    ["rebate_min", "最低返点"],
    ["follower_count", "粉丝量范围"],
    ["content_direction", "内容方向"],
    ["creator_price", "达人单价"],
  ];
  for (const [kind, label] of required) {
    const candidates =
      kind === "creator_price"
        ? priceFactsForProjection(facts, segment)
        : ["brand_name", "project_name", "submission_deadline"].includes(kind)
          ? factListForSegment(facts, kind, segment)
          : providerFactList(facts, kind, segment);
    const available = candidates.filter((fact) => {
      if (kind === "creator_count") return fact.role !== "cooperation";
      if (kind === "creator_price") {
        return fact.role !== "ceiling" || providerFactList(facts, kind, segment).length === 1;
      }
      return true;
    });
    if (available.length === 0) {
      issues.push(issue("PROVIDER_REQUIRED_FACT_MISSING", `Provider 缺少${label}`, []));
    }
  }
  const brand = firstFact(facts, "brand_name");
  const project = firstFact(facts, "project_name");
  if (brand) {
    const value = String(brand.normalized_value);
    if (PLACEHOLDER_PATTERN.test(value)) {
      issues.push(issue("BRAND_PLACEHOLDER", "品牌名仍是占位值", [brand.id]));
    } else params.brandName = value;
  }
  if (project) {
    const value = String(project.normalized_value);
    if (PLACEHOLDER_PATTERN.test(value)) {
      issues.push(issue("PROJECT_PLACEHOLDER", "项目名仍是占位值", [project.id]));
    } else params.projectName = value;
  }
  const product = firstFact(facts, "product_name");
  if (product) params.product = String(product.normalized_value);
  const count = countResolution(facts, segment);
  if (count.issue) issues.push(count.issue);
  if (count.value !== null) {
    params.quantityTotal = String(count.value);
    const countFacts = providerFactList(facts, "creator_count", segment).filter(
      (fact) => fact.role !== "cooperation",
    );
    if (countFacts.length > 1) {
      transforms.push(
        transform(
          countFacts.map((fact) => fact.id).join(","),
          "quantityTotal",
          "qualified-count-sum/v1",
          countFacts.map((fact) => fact.normalized_value),
          params.quantityTotal,
          "分内容形式/时长数量相加得到 Provider 总数量",
        ),
      );
    }
  }
  const deadline = firstFact(facts, "submission_deadline");
  if (deadline) {
    const deadlineText = String(deadline.normalized_value ?? "");
    const absolute = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?$/u.test(
      deadlineText,
    );
    if (absolute) {
      params.submissionDeadlineAt = deadlineValue(deadline);
      const parsed = deadlineInstant(deadline);
      if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
        issues.push(
          issue(
            "DEADLINE_NOT_FUTURE",
            `提报截止时间必须晚于当前时间；当前值为“${params.submissionDeadlineAt}”`,
            [deadline.id],
          ),
        );
      }
    }
  }
  const rebate = firstProviderFact(facts, "rebate_min", segment);
  if (rebate) {
    let minimum = null;
    const supportedOperator = ["any", "gte", "exact"].includes(rebate.operator);
    if (rebate.operator === "any") minimum = 0;
    else if (
      ["gte", "exact"].includes(rebate.operator) &&
      rebate.normalized_value >= 0 &&
      rebate.normalized_value <= 1
    ) {
      minimum = rebate.normalized_value;
    }
    if (minimum === null && !supportedOperator) {
      issues.push(
        issue(
          "REBATE_SEMANTICS_UNSUPPORTED",
          '最低返点必须是单一最低值或不限，不能使用区间或上限；例如“返点30%以上”编译为 rebate="[0.3,1]"',
          [rebate.id],
        ),
      );
    } else if (minimum !== null) {
      params.rebate = JSON.stringify([minimum, 1]);
      transforms.push(
        transform(
          rebate.id,
          "rebate",
          "provider-rebate-min/v1",
          rebate.normalized_value ?? rebate.minimum,
          params.rebate,
          "Provider 返点字段固定表达为 [最小值,1]",
        ),
      );
    }
  }
  const followers = firstProviderFact(facts, "follower_count", segment);
  const followerRange = numericRange(followers);
  if (followers && followerRange) {
    params.followercount = serializeRange(followerRange);
    transforms.push(
      transform(
        followers.id,
        "followercount",
        "provider-follower-range/v1",
        followers.normalized_value ?? [followers.minimum, followers.maximum],
        params.followercount,
        "补齐未指定的粉丝量边界；不限使用技术全范围",
      ),
    );
  }
  const contentTags = providerTextFactValues(facts, "content_direction", segment);
  if (contentTags.length > 0) params.contentTag = contentTags.join(",");
  const creatorGender = firstProviderFact(facts, "creator_gender", segment);
  if (creatorGender) params.kwGender = normalizedGender(creatorGender.normalized_value);
  const organization = firstProviderFact(facts, "organization_affiliation", segment);
  if (organization) {
    const value = String(organization.normalized_value).toLowerCase();
    if (["institution", "机构", "机构达人"].includes(value)) params.hasOrganization = "true";
    else if (["independent", "个人", "个人达人"].includes(value)) {
      params.hasOrganization = "false";
    }
  }
  const organizationName = firstProviderFact(facts, "organization_name", segment);
  if (organizationName) params.organization = String(organizationName.normalized_value);
  const ipDependency = firstProviderFact(facts, "ip_dependency", segment);
  if (ipDependency) params.kwIpDependency = String(ipDependency.normalized_value);
  const creatorUrlKeyword = firstProviderFact(facts, "creator_url_keyword", segment);
  if (creatorUrlKeyword) params.kwUserUrl = String(creatorUrlKeyword.normalized_value);
  const durationFacts = providerFactList(facts, "video_duration", segment);
  const formatFacts = providerFactList(facts, "content_format", segment);
  const projectedPrices = new Map();
  const priceFacts = priceFactsForProjection(facts, segment);
  for (const price of priceFacts) {
    if (price.operator === "any") {
      issues.push(issue("CREATOR_PRICE_UNRESOLVED", "达人单价不能为不限", [price.id]));
      continue;
    }
    const fields = priceTiersForFact(price, input.platform, durationFacts, formatFacts);
    if (fields.length === 0) {
      issues.push(
        issue(
          "PRICE_TIER_AMBIGUOUS",
          input.platform === "douyin"
            ? "抖音达人单价缺少明确视频时长档"
            : "小红书达人单价内容形式无效",
          [price.id],
        ),
      );
      continue;
    }
    const range = providerPriceRange(price);
    const output = serializeRange(range);
    for (const field of fields) {
      if (projectedPrices.has(field) && projectedPrices.get(field) !== output) {
        issues.push(issue("PRICE_FIELD_CONFLICT", `${field} 被多个不同价格事实占用`, [price.id]));
        continue;
      }
      projectedPrices.set(field, output);
      params[field] = output;
      transforms.push(
        transform(
          price.id,
          field,
          "provider-price-retrieval-70-120/v1",
          price.operator === "between" ? [price.minimum, price.maximum] : price.normalized_value,
          output,
          "仅供 Provider 供给检索：用户单价外沿扩展一次至 70%–120%",
        ),
      );
      if (input.platform === "xiaohongshu" && price.qualifier === "generic") {
        transforms.push(
          transform(
            price.id,
            field,
            "provider-xhs-generic-price-compat/v1",
            "generic",
            field,
            fields.length > 1
              ? "明确接受多个内容形式，共享单价写入对应的多个 Provider 价档"
              : formatFacts.length === 1
                ? "未在价格事实中限定内容形式，按唯一 campaign 内容形式选择 Provider 价档"
                : "未限定内容形式的小红书单价写入 L1 只是 Provider 兼容编码，不代表图文需求",
          ),
        );
      }
    }
  }
  for (const metricKind of ["cpm_max", "cpe_max"]) {
    for (const metric of providerFactList(facts, metricKind, segment)) {
      if (metric.operator === "gte") {
        const label = metricKind === "cpm_max" ? "CPM" : "CPE";
        issues.push(
          issue(
            `${label}_MAXIMUM_REQUIRED`,
            `${label} 只支持最大可接受值；当前原文表达为下限，请确认 ${label} 上限`,
            [metric.id],
          ),
        );
        continue;
      }
      const suffixes = metricTiersForFact(metric, input.platform, durationFacts, formatFacts);
      if (suffixes.length === 0) {
        issues.push(
          issue("METRIC_TIER_AMBIGUOUS", `${metricKind} 缺少内容形式/时长档`, [metric.id]),
        );
        continue;
      }
      const range = maximumMetricRange(metric);
      if (!range) {
        issues.push(
          issue(
            "MAXIMUM_METRIC_RANGE_INVALID",
            `${metricKind === "cpm_max" ? "CPM" : "CPE"} 最大值必须是非负有限数字`,
            [metric.id],
          ),
        );
        continue;
      }
      for (const suffix of suffixes) {
        const field = `${metricKind === "cpm_max" ? "cpm" : "cpe"}${suffix}`;
        params[field] = serializeRange(range);
      }
    }
  }
  for (const [kind, field] of Object.entries(PROVIDER_RANGE_FIELDS)) {
    const range = numericRange(firstProviderFact(facts, kind, segment), {
      unrestrictedMaximum: RATE_KINDS.has(kind) ? 1 : 999_999_999,
    });
    if (range && RATE_KINDS.has(kind) && (range.minimum < 0 || range.maximum > 1)) continue;
    if (range) params[field] = serializeRange(range);
  }
  const maleRate = firstProviderFact(facts, "audience_male_rate", segment);
  const maleRateRange = numericRange(maleRate, { unrestrictedMaximum: 1 });
  if (
    maleRate &&
    maleRateRange &&
    maleRateRange.minimum >= 0 &&
    maleRateRange.maximum <= 1 &&
    params.femaleRate === undefined
  ) {
    const range = inverseRateRange(maleRate);
    if (range) {
      const output = serializeRange(range);
      params.femaleRate = output;
      transforms.push(
        transform(
          maleRate.id,
          "femaleRate",
          "provider-male-rate-inverse/v2",
          maleRate.normalized_value ?? [maleRate.minimum, maleRate.maximum],
          output,
          "按 男粉+女粉≈100% 假设换算：男粉占比区间 [a,b] → femaleRate 区间 [1-b,1-a]",
        ),
      );
    }
  }
  const schedule = firstProviderFact(facts, "schedule_window", segment);
  if (schedule) {
    const window = parseScheduleMonth(schedule.normalized_value);
    if (window) {
      params.projectStartStart = window.start;
      params.projectStartEnd = window.end;
      transforms.push(
        transform(
          schedule.id,
          "projectStartStart/projectStartEnd",
          "provider-schedule-window/v1",
          schedule.normalized_value,
          [window.start, window.end],
          "档期 YYYY-MM 归一化为项目起止时间落库",
        ),
      );
    }
  }
  for (const [kind, field] of Object.entries(PROVIDER_BOOLEAN_FIELDS)) {
    const booleanFact = firstProviderFact(facts, kind, segment);
    if (booleanFact) params[field] = String(Boolean(booleanFact.normalized_value));
  }
  for (const [kind, field] of Object.entries(PROVIDER_ARRAY_FIELDS)) {
    const values = providerTextFactValues(facts, kind, segment);
    if (values.length > 0) params[field] = values;
  }
  const platformCreatorTypes = providerTextFactValues(facts, "platform_creator_type", segment);
  if (platformCreatorTypes.length > 0) {
    params[input.platform === "xiaohongshu" ? "pgyBloggerTypeLabel" : "xtTalentTypeLabel"] =
      platformCreatorTypes;
  }
  const growthCreatorTypes = providerTextFactValues(facts, "growth_creator_type", segment);
  if (growthCreatorTypes.length > 0) {
    params[input.platform === "xiaohongshu" ? "growBloggerTypeLabel" : "growTalentTypeLabel"] =
      growthCreatorTypes;
  }
  const referenceCreator = referenceCreatorParams(facts, segment);
  if (referenceCreator.nickname) params.refNickname = referenceCreator.nickname;
  if (referenceCreator.url) params.refUrl = referenceCreator.url;
  params.platform = input.platform;
  params.rawMessagesJson = JSON.stringify([{ role: "user", content: input.original_brief }]);
  params.description = activeFactSummary(facts);
  params.originalBrief = input.original_brief;
  const ready = issues.length === 0;
  if (ready) params.status = "ready";
  const filterFields = new Set([
    "rebate",
    "followercount",
    "contentTag",
    "kwGender",
    "kwIpDependency",
    "kwUserUrl",
    "organization",
    "hasOrganization",
    ...Object.values(PROVIDER_RANGE_FIELDS),
    ...Object.values(PROVIDER_BOOLEAN_FIELDS),
    ...Object.values(PROVIDER_ARRAY_FIELDS),
    "pgyBloggerTypeLabel",
    "growBloggerTypeLabel",
    "xtTalentTypeLabel",
    "growTalentTypeLabel",
    "cpeL1",
    "cpeL2",
    "cpeL3",
    "cpmL1",
    "cpmL2",
    "cpmL3",
    "kolOfficialPriceL1",
    "kolOfficialPriceL2",
    "kolOfficialPriceL3",
  ]);
  const filters = Object.fromEntries(
    Object.entries(params).filter(([field]) => filterFields.has(field)),
  );
  const basicParams = Object.fromEntries(
    Object.entries(params).filter(([field]) => !filterFields.has(field)),
  );
  return {
    id: segment ? `segment:${segment}` : "default",
    segment,
    ready,
    params: ready ? params : {},
    basic_params: basicParams,
    filters,
    issues,
    transforms,
  };
}

const PROVIDER_HANDLED_KINDS = new Set([
  "brand_name",
  "project_name",
  "product_name",
  "creator_count",
  "submission_deadline",
  "creator_price",
  "follower_count",
  "rebate_min",
  "content_direction",
  "content_format",
  "video_duration",
  "creator_gender",
  "organization_affiliation",
  "organization_name",
  "ip_dependency",
  "creator_url_keyword",
  "platform_creator_type",
  "growth_creator_type",
  "reference_creator",
  "cpm_max",
  "cpe_max",
  ...Object.keys(PROVIDER_RANGE_FIELDS),
  ...Object.keys(PROVIDER_ARRAY_FIELDS),
  ...Object.keys(PROVIDER_BOOLEAN_FIELDS),
]);
const PROVIDER_BASIC_KINDS = new Set([
  "brand_name",
  "project_name",
  "product_name",
  "submission_deadline",
  "reference_creator",
]);

function parseScheduleMonth(value) {
  const match = String(value ?? "")
    .trim()
    .match(/^(\d{4})-(\d{2})$/u);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${match[1]}-${match[2]}-01 00:00:00`,
    end: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")} 23:59:59`,
  };
}

const RESIDUAL_CHANNEL_HINTS = Object.freeze({
  audience_gender: "达人库无男粉占比字段，女粉占比走 audience_female_rate/femaleRate",
  audience_male_rate: "按 男粉+女粉≈100% 假设换算为 femaleRate 区间落库",
  audience_female_rate: "femaleRate 区间参与硬筛",
  audience_city: "达人库无粉丝城市字段，不能映射为达人所在地",
  schedule_window: "已写入 projectStartStart/projectStartEnd，是否参与搜索过滤以 Provider 实现为准",
  external_condition: "无安全字段映射，待后筛/人工核验",
  preferred_content: "排序偏好，不进入硬过滤",
  rebate_min: "rebate 参与硬筛",
});

function channelHint(kind) {
  if (kind?.startsWith("audience_age_l") && kind.endsWith("_rate")) {
    return "age1-6Rate 参与 Provider 硬筛";
  }
  return RESIDUAL_CHANNEL_HINTS[kind] ?? null;
}

function providerResidualConditions(facts, segment, uncoveredSegments = []) {
  const residuals = [];
  for (const fact of facts.filter(
    (item) => !["superseded", "out_of_scope", "security_excluded"].includes(item.disposition),
  )) {
    if (segment && fact.segment && fact.segment !== segment) continue;
    let reason = null;
    if (fact.disposition === "unresolved") {
      reason = "该条件仍不明确，保留并仅在其会改变搜索结果时澄清";
    } else if (fact.kind === "creator_count" && fact.role === "cooperation") {
      reason = "合作数量不是本次达人库提报搜索数量，保留用于最终组合";
    } else if (
      fact.kind === "creator_price" &&
      fact.role === "ceiling" &&
      factList(facts, "creator_price").some((item) =>
        ["target", "average", "generic"].includes(item.role),
      )
    ) {
      reason = "同时存在目标/均价时，额外价格上限保留为结果后筛条件";
    } else if (fact.strength !== "hard") {
      reason =
        fact.strength === "soft"
          ? "软偏好不写成达人库硬过滤条件，保留用于排序"
          : "上下文信息不写成达人库硬过滤条件，保留用于说明";
    } else if (fact.kind === "audience_male_rate") {
      reason =
        "男粉占比已按 男粉+女粉≈100% 假设换算为 femaleRate 区间参与检索；换算假设不成立时需后筛核验";
    } else if (fact.kind === "schedule_window") {
      reason = parseScheduleMonth(fact.normalized_value)
        ? "档期已归一化为 projectStartStart/projectStartEnd 落库；是否参与达人库搜索过滤以 Provider 实际实现为准"
        : "档期无法归一化为 YYYY-MM，保留人工核验";
    } else if (!PROVIDER_HANDLED_KINDS.has(fact.kind)) {
      reason = "当前 Provider 没有已确认的安全字段映射，保留用于后筛或人工核验";
    }
    if (reason) {
      residuals.push({
        fact_id: fact.id,
        kind: fact.kind,
        segment: fact.segment,
        requirement: fact.source.quote,
        strength: fact.strength,
        operator: fact.operator,
        value: fact.normalized_value,
        minimum: fact.minimum,
        maximum: fact.maximum,
        unit: fact.unit,
        role: fact.role,
        reason,
        ...(channelHint(fact.kind) ? { channel_hint: channelHint(fact.kind) } : {}),
      });
    }
  }
  for (const segmentItem of uncoveredSegments) {
    residuals.push({
      fact_id: null,
      kind: "unparsed",
      segment,
      requirement: segmentItem.text,
      strength: "context",
      reason: "原文片段未映射到已知 Provider 字段，保留而不阻止初始搜索",
    });
  }
  return [
    ...new Map(
      residuals.map((item) => [
        `${item.fact_id ?? "unparsed"}:${item.segment ?? "shared"}:${item.requirement}`,
        item,
      ]),
    ).values(),
  ];
}

function providerProjection(input, facts, now, globalIssues, uncoveredSegments = []) {
  const segments = [
    ...new Set(
      facts
        .filter(
          (fact) =>
            fact.disposition === "active" &&
            fact.strength === "hard" &&
            fact.segment &&
            PROVIDER_HANDLED_KINDS.has(fact.kind) &&
            !PROVIDER_BASIC_KINDS.has(fact.kind) &&
            !(fact.kind === "creator_count" && fact.role === "cooperation"),
        )
        .map((fact) => fact.segment),
    ),
  ];
  const jobSegments = segments.length > 0 ? segments : [null];
  const searchJobs = jobSegments.map((segment) => {
    const jobFacts = facts.filter((fact) => !fact.segment || fact.segment === segment);
    const jobFactIds = new Set(jobFacts.map((fact) => fact.id));
    const relevantIssues = globalIssues.filter(
      (item) => item.fact_ids.length === 0 || item.fact_ids.some((id) => jobFactIds.has(id)),
    );
    if (
      jobSegments.length > 1 &&
      !jobFacts.some(
        (fact) =>
          fact.disposition === "active" &&
          fact.strength === "hard" &&
          fact.kind === "creator_count" &&
          fact.role !== "cooperation" &&
          fact.segment === segment,
      )
    ) {
      relevantIssues.push(
        issue(
          "SEGMENT_CREATOR_COUNT_MISSING",
          `${segment} 缺少独立提报数量；多个搜索分组不能重复使用一个共享总量`,
        ),
      );
    }
    const job = providerJobProjection(input, jobFacts, now, relevantIssues, segment);
    return {
      ...job,
      residual_conditions: providerResidualConditions(jobFacts, segment, uncoveredSegments),
    };
  });
  const issues = [
    ...new Map(
      searchJobs
        .flatMap((job) => job.issues)
        .map((item) => [`${item.code}:${item.message}:${item.fact_ids.join(",")}`, item]),
    ).values(),
  ];
  const residualConditions = [
    ...new Map(
      searchJobs
        .flatMap((job) => job.residual_conditions)
        .map((item) => [`${item.fact_id}:${item.segment}:${item.requirement}`, item]),
    ).values(),
  ];
  const ready = searchJobs.length > 0 && searchJobs.every((job) => job.ready);
  const basicParams = Object.fromEntries(
    Object.entries(searchJobs[0]?.basic_params ?? {}).filter(([field, value]) =>
      searchJobs.every(
        (job) =>
          Object.hasOwn(job.basic_params, field) &&
          JSON.stringify(job.basic_params[field]) === JSON.stringify(value),
      ),
    ),
  );
  return {
    applicable: true,
    ready,
    params: ready && searchJobs.length === 1 ? searchJobs[0].params : {},
    basic_params: basicParams,
    search_jobs: searchJobs,
    residual_conditions: residualConditions,
    issues,
    transforms: searchJobs.flatMap((job) => job.transforms),
  };
}

function questionsFor(projection) {
  return [...new Set(projection.issues.map((item) => item.message))];
}

/**
 * Compile evidence-backed user facts into the Provider search projection.
 * A successful compile can still be not-ready; business ambiguities are returned as
 * projection issues, while malformed or unsupported evidence fails the call.
 *
 * @param {any} input
 * @param {{ now?: Date }} [options]
 */
export function compileRequirementFacts(input, { now = new Date() } = {}) {
  if (!isRecord(input)) return invalid(["输入必须是对象"], input);
  const violations = [];
  if (!nonemptyString(input.original_brief)) violations.push("original_brief 必须是非空字符串");
  if (!["xiaohongshu", "douyin"].includes(input.platform)) {
    violations.push("platform 只允许 xiaohongshu 或 douyin");
  }
  if (!Array.isArray(input.facts) || input.facts.length > 100) {
    violations.push("facts 必须是不超过 100 项的数组");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) violations.push("now 无效");
  const sources = new Map();
  if (nonemptyString(input.original_brief)) sources.set("original_brief", input.original_brief);
  const clarifications = input.clarifications ?? [];
  if (!Array.isArray(clarifications) || clarifications.length > 50) {
    violations.push("clarifications 必须是不超过 50 项的数组");
  } else {
    clarifications.forEach((message, index) => {
      if (!nonemptyString(message)) {
        violations.push(`clarifications[${index}] 必须是非空字符串`);
        return;
      }
      sources.set(`clarification-${index + 1}`, message);
    });
  }
  const normalized = normalizeFacts(expandCompactFacts(input, sources), sources);
  violations.push(...normalized.violations);
  if (violations.length > 0) return invalid(violations, input);
  const facts = normalized.facts;
  const conflicts = collectConflicts(facts);
  const unresolvedFacts = facts
    .filter((fact) => ["ambiguous", "conflicting"].includes(fact.status))
    .map((fact) => fact.id);
  const blockingUnresolvedFacts = facts
    .filter(
      (fact) => fact.strength === "hard" && ["ambiguous", "conflicting"].includes(fact.status),
    )
    .map((fact) => fact.id);
  const coverage = collectCoverage(sources, facts, input.platform);
  const globalIssues = baseProjectionIssues(
    conflicts,
    blockingUnresolvedFacts,
    coverage.uncoveredSegments,
  );
  globalIssues.push(...normalized.issues);
  const provider = providerProjection(input, facts, now, globalIssues, coverage.uncoveredSegments);
  const data = {
    schema_version: "requirement-search/v2",
    outcome: provider.ready ? "ready" : "clarification_required",
    platform: input.platform,
    facts,
    projections: { provider },
    audit: {
      semantic_ready: globalIssues.length === 0,
      conflicts,
      unresolved_facts: unresolvedFacts,
      uncovered_segments: coverage.uncoveredSegments,
      security_flags: coverage.securityFlags,
      clarification_questions: {
        provider: questionsFor(provider),
      },
    },
  };
  return { success: true, data };
}

/** @param {{ now?: () => Date }} [options] */
export function createRequirementParser({ now = () => new Date() } = {}) {
  return async function parseRequirement(params) {
    const result = compileRequirementFacts(params, { now: now() });
    return hostToolResult(result, {
      ...(result.success ? { details: result.data } : {}),
      isError: result.success === false,
      compact: result.success,
    });
  };
}
