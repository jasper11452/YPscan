export const MANUAL_RESEARCH_PLATFORMS = Object.freeze(["xingtu", "pgy"]);

const PUBLIC_MANUAL_RESEARCH_OPERATIONS = Object.freeze([
  "start",
  "capture_list",
  "capture_detail",
  "finalize",
  "apply_reviews",
  "create_submission",
]);
const LEGACY_MANUAL_RESEARCH_OPERATIONS = Object.freeze([
  ...PUBLIC_MANUAL_RESEARCH_OPERATIONS,
  "collect",
]);

export const MANUAL_RESEARCH_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["operation", "requirement_id", "platform"],
  properties: {
    operation: {
      type: "string",
      enum: [...PUBLIC_MANUAL_RESEARCH_OPERATIONS],
      description:
        "Playwright 自助手扒协议：start 创建本地运行；Agent 先观察整页并等待重定向稳定，确认目标达人广场后关闭普通弹窗，再确认筛选区可用后筛选；随后操作固定 ypscan session，并把 run-code 读取的 list_snapshot/detail_snapshot 传给 capture_list/capture_detail；插件只校验和落盘，不执行 shell；finalize 生成 Excel。",
    },
    requirement_id: {
      type: "string",
      minLength: 1,
      description:
        "当前 requirement ID：优先使用 validate_requirement 返回的 data.requirement_id，缺失时兼容 data.id；绝不能使用 data.demand_id。只用于关联本次手扒结果。",
    },
    platform: {
      type: "string",
      enum: [...MANUAL_RESEARCH_PLATFORMS, "douyin", "xiaohongshu"],
      description: "xingtu/douyin 对应巨量星图，pgy/xiaohongshu 对应小红书蒲公英。",
    },
    run_id: {
      type: "string",
      minLength: 1,
      description:
        "capture_list/capture_detail/finalize/apply_reviews/create_submission 必传；使用 start 返回的 run_id。",
    },
    keyword: {
      type: "string",
      minLength: 1,
      description: "capture_list 当前页面实际使用的关键词。",
    },
    keyword_complete: {
      type: "boolean",
      description: "当前关键词无需继续翻页时传 true；不影响 Agent 后续重新采集。",
    },
    candidate_ref: {
      type: "string",
      minLength: 1,
      description: "capture_detail 当前已由 Agent 打开的达人引用。",
    },
    list_snapshot: {
      type: "object",
      description:
        "capture_list 必传；由 Agent 通过 YP Action Playwright run-code 从当前稳定列表页读取并原样传入。插件不执行 shell。",
      required: ["source_url", "rows"],
      properties: {
        source_url: { type: "string", minLength: 1 },
        page_number: { type: "integer", minimum: 1 },
        price_tier: { type: "string" },
        collection_source: { type: "string" },
        response_endpoint: { type: ["string", "null"] },
        response_path: { type: ["string", "null"] },
        challenge: { type: "boolean" },
        login: { type: "boolean" },
        rows: { type: "array", maxItems: 200, items: { type: "object" } },
      },
    },
    detail_snapshot: {
      type: "object",
      description:
        "capture_detail 必传；由 Agent 通过 YP Action Playwright run-code 从当前达人详情页读取并原样传入。插件不执行 shell。",
      required: ["url", "fields"],
      properties: {
        url: { type: "string", minLength: 1 },
        challenge: { type: "boolean" },
        login: { type: "boolean" },
        fields: { type: "object" },
      },
    },
    filter_evidence: {
      type: "array",
      maxItems: 30,
      description: "Agent 从当前页面观察到的已应用筛选证据；只作审计，不作为采集门禁。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fact", "verified"],
        properties: {
          fact: { type: "string", minLength: 1 },
          page_control: { type: "string" },
          selected_path: { type: "array", items: { type: "string" } },
          verified: { type: "boolean" },
          evidence: { type: "string" },
        },
      },
    },
    reviews: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      description: "Agent 对当前复核批次给出的纳入或淘汰结论。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidate_ref", "decision", "reasons", "evidence"],
        properties: {
          candidate_ref: { type: "string", minLength: 1 },
          decision: { type: "string", enum: ["include", "exclude"] },
          reasons: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        },
      },
    },
    facts: {
      type: "array",
      description: "start 必传的完整硬条件 facts；后续操作不得重传。",
      items: { type: "object" },
    },
    quote_type: {
      type: "string",
      enum: ["植入视频", "定制视频", "图文", "图文笔记", "视频", "视频笔记"],
      description: "start 可选；单次运行只允许一个平台报价类型。",
    },
    keywords: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      description: "start 必传的 1–4 个关键词；后续由 Agent 在同一 Playwright session 内切换。",
      items: { type: "string", minLength: 1 },
    },
    fresh_run: {
      type: "boolean",
      description: "仅 start 且用户明确要求重新实时手扒时传 true。",
    },
  },
});

export const MANUAL_FILTER_SELECTION_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["requirement_id", "platform"],
  properties: {
    operation: {
      type: "string",
      enum: ["plan", "commit"],
      description:
        "默认 plan；v3 plan 只创建硬筛需求和关键词顺序，不决定元素动作，commit 只读复核并签发 selection_id。",
    },
    requirement_id: MANUAL_RESEARCH_PARAMETERS.properties.requirement_id,
    platform: MANUAL_RESEARCH_PARAMETERS.properties.platform,
    facts: {
      type: "array",
      description:
        "首次筛选必传的完整硬条件 facts；不得为规避页面控件删除受众或内容条件，工具会自动路由到页面筛选、详情硬审或语义复核。后续携带 run_id 时禁止重传。",
      items: { type: "object" },
    },
    keywords: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      description: "首次筛选可传 1–4 个关键词；后续从 run 读取。",
      items: { type: "string", minLength: 1 },
    },
    fresh_run: {
      type: "boolean",
      description: "仅首次筛选且用户明确要求重新实时手扒时传 true。",
    },
    run_id: {
      type: "string",
      minLength: 1,
      description: "后续关键词或恢复筛选时必传。",
    },
    branch_index: {
      type: "integer",
      minimum: 0,
      description: "后续筛选时必传，由抓取工具 next_selection_args 原样提供。",
    },
  },
});

function argumentError(message) {
  return Object.assign(new Error(message), { code: "YPSCAN_MANUAL_ARGUMENT_INVALID" });
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw argumentError(`${name} 不能为空`);
  return value.trim();
}

function normalizeManualSelectionFact(fact) {
  if (
    !fact ||
    typeof fact !== "object" ||
    Array.isArray(fact) ||
    Object.hasOwn(fact, "normalized_value") ||
    !Object.hasOwn(fact, "value")
  ) {
    return fact;
  }
  return { ...fact, normalized_value: fact.value };
}

export function validateCreatorPriceFact(fact) {
  if (!fact || fact.kind !== "creator_price") return;
  const value = fact.normalized_value ?? fact.value;
  const expandedRange = () => {
    throw argumentError("creator_price 必须传客户原始价格事实，不能传已扩展区间");
  };
  const missingValue = () => {
    throw argumentError("creator_price 缺少有限数值，请传 normalized_value（兼容 value）");
  };
  const finite = (value) =>
    value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  if (Object.hasOwn(fact, "min") || Object.hasOwn(fact, "max")) expandedRange();
  if (["exact", "lte", "gte"].includes(fact.operator)) {
    if (Array.isArray(value)) expandedRange();
    if (!finite(value)) missingValue();
    return;
  }
  if (fact.operator === "between") {
    if (!finite(fact.minimum) || !finite(fact.maximum)) missingValue();
    return;
  }
  throw argumentError("creator_price.operator 必须是 exact、lte、gte 或 between");
}

/** @param {unknown} value */
function normalizePlatform(value) {
  const platform = requiredString(value, "platform").toLowerCase();
  if (platform === "douyin") return "xingtu";
  if (platform === "xiaohongshu") return "pgy";
  if (!MANUAL_RESEARCH_PLATFORMS.includes(platform)) {
    throw argumentError(`不支持平台：${platform}`);
  }
  return platform;
}

/**
 * @param {Record<string, any>} [params]
 * @param {{allowLegacyProtocol?: boolean}} [options]
 */
export function validateManualResearchParams(params = {}, { allowLegacyProtocol = true } = {}) {
  const operation = params.operation ?? (allowLegacyProtocol ? "collect" : null);
  const allowedOperations = allowLegacyProtocol
    ? LEGACY_MANUAL_RESEARCH_OPERATIONS
    : PUBLIC_MANUAL_RESEARCH_OPERATIONS;
  if (!allowedOperations.includes(operation)) {
    throw argumentError("operation 不受支持");
  }
  const platform = normalizePlatform(params.platform);
  const requirementId = requiredString(params.requirement_id, "requirement_id");
  if (operation === "start") {
    if (!Array.isArray(params.facts)) throw argumentError("start 必须提供 facts");
    const facts = params.facts.map(normalizeManualSelectionFact);
    for (const fact of facts) validateCreatorPriceFact(fact);
    if (
      !Array.isArray(params.keywords) ||
      params.keywords.length < 1 ||
      params.keywords.length > 4
    ) {
      throw argumentError("start 的 keywords 必须包含 1–4 个关键词");
    }
    return {
      operation,
      requirement_id: requirementId,
      platform,
      facts,
      quote_type: params.quote_type ? requiredString(params.quote_type, "quote_type") : null,
      keywords: params.keywords.map((value, index) => requiredString(value, `keywords[${index}]`)),
      fresh_run: params.fresh_run === true,
    };
  }
  if (["capture_list", "capture_detail", "finalize"].includes(operation)) {
    return {
      operation,
      requirement_id: requirementId,
      platform,
      run_id: requiredString(params.run_id, "run_id"),
      ...(operation === "capture_list"
        ? {
            keyword: requiredString(params.keyword, "keyword"),
            keyword_complete: params.keyword_complete === true,
            filter_evidence: Array.isArray(params.filter_evidence) ? params.filter_evidence : [],
            list_snapshot:
              params.list_snapshot &&
              typeof params.list_snapshot === "object" &&
              !Array.isArray(params.list_snapshot) &&
              Array.isArray(params.list_snapshot.rows)
                ? params.list_snapshot
                : (() => {
                    throw argumentError("capture_list 必须提供含 rows 的 list_snapshot");
                  })(),
          }
        : {}),
      ...(operation === "capture_detail"
        ? {
            candidate_ref: requiredString(params.candidate_ref, "candidate_ref"),
            detail_snapshot:
              params.detail_snapshot &&
              typeof params.detail_snapshot === "object" &&
              !Array.isArray(params.detail_snapshot) &&
              params.detail_snapshot.fields &&
              typeof params.detail_snapshot.fields === "object" &&
              !Array.isArray(params.detail_snapshot.fields)
                ? params.detail_snapshot
                : (() => {
                    throw argumentError("capture_detail 必须提供含 fields 的 detail_snapshot");
                  })(),
          }
        : {}),
    };
  }
  if (operation === "create_submission") {
    return {
      operation,
      requirement_id: requirementId,
      platform,
      run_id: requiredString(params.run_id, "run_id"),
    };
  }
  if (operation === "apply_reviews") {
    if (!Array.isArray(params.reviews) || params.reviews.length < 1 || params.reviews.length > 20) {
      throw argumentError("reviews 必须包含 1–20 条复核结果");
    }
    const reviews = params.reviews.map((review, index) => {
      if (!review || !["include", "exclude"].includes(review.decision)) {
        throw argumentError(`reviews[${index}].decision 必须是 include 或 exclude`);
      }
      if (!Array.isArray(review.reasons) || !Array.isArray(review.evidence)) {
        throw argumentError(`reviews[${index}] 的 reasons 和 evidence 必须是数组`);
      }
      const reasons = review.reasons.map((value) => String(value).trim()).filter(Boolean);
      const evidence = review.evidence.map((value) => String(value).trim()).filter(Boolean);
      if (!reasons.length || !evidence.length) {
        throw argumentError(`reviews[${index}] 的 reasons 和 evidence 不能为空`);
      }
      return {
        candidate_ref: requiredString(review.candidate_ref, `reviews[${index}].candidate_ref`),
        decision: review.decision,
        reasons,
        evidence,
      };
    });
    return {
      operation,
      requirement_id: requirementId,
      platform,
      run_id: requiredString(params.run_id, "run_id"),
      reviews,
    };
  }
  if (!params.run_id) {
    const selectorArgs = {
      requirement_id: requirementId,
      platform,
      ...(Array.isArray(params.facts) ? { facts: params.facts } : {}),
      ...(Array.isArray(params.keywords) ? { keywords: params.keywords } : {}),
      ...(params.fresh_run === true ? { fresh_run: true } : {}),
    };
    return {
      operation: "legacy_collect",
      requirement_id: requirementId,
      platform,
      selector_args: selectorArgs,
    };
  }
  return {
    operation,
    requirement_id: requirementId,
    platform,
    run_id: requiredString(params.run_id, "run_id"),
    selection_id: params.selection_id ? requiredString(params.selection_id, "selection_id") : null,
  };
}

/** @param {Record<string, any>} [params] */
export function validateManualFilterSelectionParams(params = {}) {
  const platform = normalizePlatform(params.platform);
  const requirementId = requiredString(params.requirement_id, "requirement_id");
  const operation = params.operation ?? "plan";
  if (!["plan", "commit"].includes(operation)) {
    throw argumentError("operation 必须是 plan 或 commit");
  }
  const hasRun = params.run_id !== undefined;
  if (operation === "commit" && !hasRun) {
    throw argumentError("commit 必须携带 run_id 和 branch_index");
  }
  if (hasRun) {
    if (
      params.facts !== undefined ||
      params.keywords !== undefined ||
      params.fresh_run !== undefined
    ) {
      throw argumentError("携带 run_id 时禁止重传 facts、keywords 或 fresh_run");
    }
    if (!Number.isInteger(params.branch_index) || params.branch_index < 0) {
      throw argumentError("携带 run_id 时 branch_index 必须是大于等于 0 的整数");
    }
    return {
      operation,
      requirement_id: requirementId,
      platform,
      run_id: requiredString(params.run_id, "run_id"),
      branch_index: params.branch_index,
      initial: false,
    };
  }
  if (!Array.isArray(params.facts)) throw argumentError("首次筛选 facts 必须是数组");
  const facts = params.facts.map(normalizeManualSelectionFact);
  for (const fact of facts) validateCreatorPriceFact(fact);
  if (
    params.keywords !== undefined &&
    (!Array.isArray(params.keywords) || params.keywords.length < 1 || params.keywords.length > 4)
  ) {
    throw argumentError("keywords 必须包含 1–4 个关键词");
  }
  if (params.branch_index !== undefined) {
    throw argumentError("首次筛选不传 branch_index");
  }
  if (params.fresh_run !== undefined && typeof params.fresh_run !== "boolean") {
    throw argumentError("fresh_run 必须是布尔值");
  }
  return {
    operation,
    requirement_id: requirementId,
    platform,
    facts,
    keywords: params.keywords?.map((value, index) => requiredString(value, `keywords[${index}]`)),
    fresh_run: params.fresh_run === true,
    branch_index: 0,
    initial: true,
  };
}
