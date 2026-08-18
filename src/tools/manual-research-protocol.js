export const MANUAL_RESEARCH_PLATFORMS = Object.freeze(["xingtu", "pgy"]);

const LEGACY_COLLECTION_PROPERTIES = Object.freeze({
  page_url: {
    type: "string",
    minLength: 1,
    description: "旧一体化调用兼容字段；收到后只返回筛选工具迁移参数，不操作 Browser。",
  },
  original_brief: {
    type: "string",
    minLength: 1,
    description: "旧一体化调用兼容字段；运行时不读取。",
  },
  facts: {
    type: "array",
    description: "旧一体化调用兼容字段；应改传给 ypscan_manual_select_filters。",
    items: { type: "object" },
  },
  keywords: {
    type: "array",
    minItems: 1,
    maxItems: 4,
    uniqueItems: true,
    items: { type: "string", minLength: 1 },
  },
  resume_from_branch: { type: "integer", minimum: 0 },
  fresh_run: { type: "boolean" },
});

export const MANUAL_RESEARCH_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["requirement_id", "platform"],
  properties: {
    operation: {
      type: "string",
      enum: ["collect", "apply_reviews"],
      description:
        "默认 collect；collect 必须使用 ypscan_manual_select_filters 返回的 run_id/selection_id，详情完成后用 apply_reviews 分批写回复核结论。",
    },
    requirement_id: {
      type: "string",
      minLength: 1,
      description: "当前 Provider 需求 ID，只用于关联本次手扒结果。",
    },
    platform: {
      type: "string",
      enum: [...MANUAL_RESEARCH_PLATFORMS, "douyin", "xiaohongshu"],
      description: "xingtu/douyin 对应巨量星图，pgy/xiaohongshu 对应小红书蒲公英。",
    },
    run_id: {
      type: "string",
      minLength: 1,
      description: "collect/apply_reviews 必传；使用筛选工具或 collect 返回的 run_id。",
    },
    selection_id: {
      type: "string",
      minLength: 1,
      description: "首次 collect 必传；后续增量 collect 可从 run 的最新已验证分支恢复。",
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
    ...LEGACY_COLLECTION_PROPERTIES,
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
      description: "默认 plan；plan 只创建动作计划，commit 只读复核并签发 selection_id。",
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
    if (Array.isArray(fact.normalized_value)) expandedRange();
    if (!finite(fact.normalized_value)) missingValue();
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

/** @param {Record<string, any>} [params] */
export function validateManualResearchParams(params = {}) {
  const operation = params.operation ?? "collect";
  if (!["collect", "apply_reviews"].includes(operation)) {
    throw argumentError("operation 必须是 collect 或 apply_reviews");
  }
  const platform = normalizePlatform(params.platform);
  const requirementId = requiredString(params.requirement_id, "requirement_id");
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
