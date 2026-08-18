import { chromium } from "playwright-core";
import { inspectManualBrowser } from "./manual-browser-state.js";
import {
  applyManualResearchReviews,
  createManualResearchStore,
  loadManualResearchRun,
  MANUAL_RESEARCH_PREVIEW_LIMIT,
} from "./manual-research-artifact.js";
import { mergeManualCandidates } from "./manual-research-plan.js";
import { checkCandidatePrice } from "./manual-research-price-check.js";
import {
  MANUAL_RESEARCH_PARAMETERS,
  MANUAL_RESEARCH_PLATFORMS,
  validateManualResearchParams,
} from "./manual-research-protocol.js";
import { manualBrowserError, pageMatches, PLATFORM_RULES } from "./manual-research/common.js";
import { createPgyAdapter } from "./manual-research/pgy-adapter.js";
import { createXingtuAdapter } from "./manual-research/xingtu-adapter.js";
import { hostToolResult } from "./tool-result.js";
import {
  candidateReference,
  detailGroupsForPlan,
  detailQueueLimit,
  evaluateCandidateList,
  evaluateCandidateDetail,
  mergeDetailRecords,
  mergeReviewRecords,
  reviewBatch,
} from "./manual-research-detail.js";
import {
  detailGroupHasEvidence,
  readCreatorDetailSnapshot,
} from "./manual-research/detail-page.js";

export { MANUAL_RESEARCH_PARAMETERS, MANUAL_RESEARCH_PLATFORMS };

const DEFAULT_CDP_URL = "http://127.0.0.1:18800";
const MAX_PAGES_PER_BRANCH = 25;

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw manualBrowserError("YPSCAN_MANUAL_CONFIG_INVALID", `${name} 不能为空`);
  }
  return value.trim();
}

async function preferredPage(pages) {
  let focusedPage = null;
  let visiblePage = null;
  for (const candidate of pages) {
    const state =
      typeof candidate.evaluate === "function"
        ? await candidate
            .evaluate(() => ({
              focused: globalThis.document.hasFocus(),
              visible: globalThis.document.visibilityState === "visible",
            }))
            .catch(() => ({ focused: false, visible: false }))
        : { focused: false, visible: false };
    if (state.focused) focusedPage = candidate;
    if (state.visible) visiblePage = candidate;
  }
  return focusedPage ?? visiblePage ?? pages[0] ?? null;
}

function pageHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/** @param {import("playwright-core").Browser} browser */
export async function resolveManualResearchPage(browser, platform) {
  const targetUrl = PLATFORM_RULES[platform].url;
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());
  const exact = pages.find((page) => page.url() === targetUrl);
  if (exact) {
    await exact.bringToFront?.().catch(() => {});
    return exact;
  }

  const sameMarketPages = pages.filter((page) => pageMatches(platform, page.url()));
  const sameHostPages = pages.filter(
    (page) => pageHost(page.url()) === PLATFORM_RULES[platform].host,
  );
  const blankPages = pages.filter((page) => page.url() === "about:blank");
  let page = await preferredPage(
    sameMarketPages.length ? sameMarketPages : sameHostPages.length ? sameHostPages : blankPages,
  );
  let created = false;
  if (!page) {
    const context = contexts[0];
    if (!context || typeof context.newPage !== "function") {
      throw manualBrowserError(
        "YPSCAN_MANUAL_PAGE_OPEN_FAILED",
        `无法打开${platform === "xingtu" ? "星图" : "蒲公英"}达人广场`,
        { target_url: targetUrl },
      );
    }
    page = await context.newPage();
    created = true;
  }

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await page.bringToFront?.().catch(() => {});
    return page;
  } catch (error) {
    if (created) await page.close?.().catch(() => {});
    throw manualBrowserError(
      "YPSCAN_MANUAL_PAGE_OPEN_FAILED",
      `打开${platform === "xingtu" ? "星图" : "蒲公英"}达人广场失败`,
      {
        target_url: targetUrl,
        reason: error?.message ?? String(error),
      },
    );
  }
}

function pageSignature(pageData) {
  return (pageData.rows ?? [])
    .slice(0, 5)
    .map((row) => row.platform_id ?? row.detail_url ?? row.nickname ?? row.raw_text)
    .join("|");
}

/**
 * @param {any} row
 * @param {{platform: string, branchId: string, pageNumber: number, priceTier: string|null, sourceUrl: string}} source
 */
function candidateFromRow(row, source) {
  const listFields = Object.fromEntries(
    ["ordinal", "related_posts", "read_median", "interaction_median", "quote_fields"]
      .map((key) => [key, row[key]])
      .filter(([, value]) => value !== null && value !== undefined && value !== ""),
  );
  return {
    platform: source.platform,
    platform_id: row.platform_id ?? null,
    nickname: clean(row.nickname) || null,
    detail_url: row.detail_url ?? null,
    source_url: row.source_url ?? source.sourceUrl,
    source_branches: [source.branchId],
    source_pages: [source.pageNumber],
    quote_tier: row.format ?? source.priceTier,
    price_raw: row.price_raw ?? null,
    followers_raw: row.followers_raw ?? null,
    cpm_raw: row.cpm_raw ?? null,
    cpe_raw: row.cpe_raw ?? null,
    interaction_rate: row.interaction_rate ?? null,
    expected_views: row.expected_views ?? null,
    creator_gender: row.creator_gender ?? null,
    city: row.city ?? null,
    content_type: row.content_type ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    list_fields: listFields,
    evidence: [
      {
        branch_id: source.branchId,
        page_number: source.pageNumber,
        source_url: row.source_url ?? source.sourceUrl,
        quote_tier: row.format ?? source.priceTier,
      },
    ],
  };
}

function publicCandidate(candidate) {
  const listFields = Object.fromEntries(
    Object.entries(candidate.list_fields ?? {}).filter(([key]) => key !== "quote_fields"),
  );
  return Object.fromEntries(
    Object.entries({
      ...candidate,
      list_fields: undefined,
      ...(Object.keys(listFields).length ? { list_fields: listFields } : {}),
      evidence: undefined,
    }).filter(
      ([, value]) =>
        value !== null &&
        value !== undefined &&
        value !== "" &&
        (!Array.isArray(value) || value.length > 0),
    ),
  );
}

function partitionCandidatesByPrice(candidates, plan) {
  const eligible = [];
  const rejected = [];
  const needsReview = [];
  for (const candidate of candidates) {
    const value = { ...candidate, price_check: checkCandidatePrice(candidate, plan) };
    if (["passed", "not_required"].includes(value.price_check.status)) eligible.push(value);
    else if (value.price_check.status === "rejected") rejected.push(value);
    else needsReview.push(value);
  }
  return { eligible, rejected, needsReview };
}

function partitionCandidatesByListHard(candidates, plan) {
  const passed = [];
  const rejected = [];
  const pending = [];
  for (const candidate of candidates) {
    const value = { ...candidate, list_hard_evaluation: evaluateCandidateList(candidate, plan) };
    if (value.list_hard_evaluation.status === "pass") passed.push(value);
    else if (value.list_hard_evaluation.status === "fail") rejected.push(value);
    else pending.push(value);
  }
  return { passed, rejected, pending, viable: [...passed, ...pending] };
}

export function createManualResearchAdapter(platform, page, options) {
  return platform === "xingtu"
    ? createXingtuAdapter(page, { now: options.now })
    : createPgyAdapter(page, { workspaceDir: options.workspaceDir, now: options.now });
}

/**
 * @param {any} adapter
 * @param {any} selection
 * @param {any} plan
 * @param {string} platform
 */
async function collectSelectedBranch(
  adapter,
  selection,
  plan,
  platform,
  onPage = async (_checkpoint) => {},
) {
  const branch = selection.branch;
  const actualFilters = selection.verification?.actual_filters ?? [];
  const unexpressedFilters = selection.verification?.unexpressed_filters ?? [];
  const search = selection.verification?.keyword ?? {};
  const priceView = selection.verification?.price_view ?? {};

  const pages = [];
  const candidates = [];
  const seen = new Set();
  let stopReason = "end_of_results";
  for (let pageNumber = 1; pageNumber <= MAX_PAGES_PER_BRANCH; pageNumber += 1) {
    const pageData = await adapter.readPage(
      pageNumber,
      pageNumber === 1 ? (selection.list_snapshot ?? null) : null,
    );
    const signature = pageSignature(pageData);
    if (seen.has(signature)) {
      stopReason = "repeated_page_signature";
      break;
    }
    seen.add(signature);
    const pageRecord = {
      page_number: pageNumber,
      row_count: pageData.rows.length,
      first_candidate:
        pageData.rows[0]?.platform_id ??
        pageData.rows[0]?.detail_url ??
        pageData.rows[0]?.nickname ??
        null,
      source_url: pageData.source_url,
      price_tier: pageData.price_tier,
      collection_source: pageData.collection_source ?? "dom",
      response_endpoint: pageData.response_endpoint ?? null,
      response_path: pageData.response_path ?? null,
    };
    pages.push(pageRecord);
    const pageCandidates = pageData.rows.map((row) =>
      candidateFromRow(row, {
        platform,
        branchId: branch.branch_id,
        pageNumber,
        priceTier: pageData.price_tier,
        sourceUrl: pageData.source_url,
      }),
    );
    candidates.push(...pageCandidates);
    await onPage({ branch, page: pageRecord, candidates: pageCandidates });
    const merged = mergeManualCandidates(candidates);
    if (partitionCandidatesByListHard(merged, plan).viable.length >= plan.per_branch_target) {
      stopReason = "candidate_target_reached";
      break;
    }
    const next = await adapter.nextPage();
    const advanced = typeof next === "boolean" ? next : Boolean(next?.advanced);
    if (!advanced) {
      stopReason = typeof next === "object" && next?.reason ? next.reason : "end_of_results";
      break;
    }
    if (pageNumber === MAX_PAGES_PER_BRANCH) stopReason = "page_limit_reached";
  }
  const collectionStatus =
    candidates.length > 0 || search.result_count === 0 ? "complete" : "incomplete";
  return {
    branch: {
      ...branch,
      ...(selection.verification?.recovery ? { recovery: selection.verification.recovery } : {}),
      actual_filters: actualFilters,
      unexpressed_filters: unexpressedFilters,
      price_view: { requested: plan.price_view, ...priceView },
      result_count: search.result_count ?? null,
      page_count: pages.length,
      pages,
      collection: {
        status: collectionStatus,
        stop_reason: stopReason,
        candidate_count: candidates.length,
        page_limit: MAX_PAGES_PER_BRANCH,
      },
      export: {
        status: "skipped",
        reason: "browser_list_primary_path",
        quota_consumed: false,
      },
    },
    candidates,
  };
}

function requiresUserAction(error) {
  return /LOGIN|CAPTCHA|DETAIL_RISK/u.test(error?.code ?? "");
}

function requiresFatalStop(error) {
  return /CHECKPOINT|ARTIFACT|WORKSPACE/u.test(error?.code ?? "");
}

function requiresImmediateBranchStop(error) {
  return error?.code === "YPSCAN_MANUAL_PRICE_VIEW_NOT_APPLIED";
}

async function collectSelectedBranchWithRecovery(adapter, selection, plan, platform, onPage) {
  const failures = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await collectSelectedBranch(adapter, selection, plan, platform, onPage);
      if (failures.length) {
        result.branch.recovery = {
          attempted: true,
          attempts: attempt,
          previous_errors: failures,
        };
      }
      return result;
    } catch (error) {
      if (
        requiresUserAction(error) ||
        requiresFatalStop(error) ||
        requiresImmediateBranchStop(error)
      )
        throw error;
      failures.push({
        attempt,
        code: error?.code ?? "YPSCAN_MANUAL_BRANCH_FAILED",
        message: error?.message ?? String(error),
      });
      if (attempt < 2) await adapter.recover?.(error);
      else {
        error.recovery = { attempted: true, attempts: attempt, errors: failures };
        throw error;
      }
    }
  }
  throw manualBrowserError("YPSCAN_MANUAL_BRANCH_FAILED", "已验证关键词分支未能完成抓取");
}

async function collectDetailWithRecovery(adapter, candidate, groups) {
  const failures = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const detail = await adapter.collectDetail(candidate, { groups });
      return failures.length ? { ...detail, recovery: { attempts: attempt, failures } } : detail;
    } catch (error) {
      if (requiresUserAction(error) || requiresFatalStop(error)) throw error;
      failures.push({
        attempt,
        code: error?.code ?? "YPSCAN_MANUAL_DETAIL_FAILED",
        message: error?.message ?? String(error),
      });
      if (attempt < 2) await adapter.recover?.(error);
    }
  }
  return {
    candidate_ref: candidateReference(candidate),
    platform_id: candidate.platform_id ?? null,
    nickname: candidate.nickname ?? null,
    detail_url: candidate.detail_url ?? null,
    status: "partial",
    reason: "detail_collection_failed",
    fields: {},
    recovery: { attempts: 2, failures },
  };
}

function exportFallbackReasons(plan, branches, candidates, details = []) {
  const reasons = [];
  if (branches.some((branch) => branch.collection?.status === "incomplete")) {
    reasons.push("list_collection_incomplete");
  }
  const merged = mergeManualCandidates(candidates);
  const eligible = partitionCandidatesByListHard(merged, plan).viable;
  const platformMayHaveResults = branches.some(
    (branch) => branch.result_count === null || branch.result_count > 0,
  );
  if (plan.target_count && eligible.length < plan.target_count && platformMayHaveResults) {
    reasons.push("candidate_target_not_met");
  }
  const requiredFields = {
    follower_count: ["followers_raw", "followers_raw"],
    creator_price: ["price_raw", "price_picture_raw", "price_video_raw"],
    cpm: ["cpm_raw", "cpm_raw"],
    cpe: ["cpe_raw", "cpe_raw"],
    interaction_rate: ["interaction_rate", "interaction_rate_raw"],
  };
  const detailMap = new Map(
    mergeDetailRecords(details).map((detail) => [detail.candidate_ref, detail]),
  );
  for (const control of new Set(plan.filters.map((filter) => filter.control))) {
    const fields = requiredFields[control];
    if (
      fields &&
      merged.length > 0 &&
      !merged.some((candidate) => {
        const detailFields = detailMap.get(candidateReference(candidate))?.fields ?? {};
        return fields.some((field) => candidate[field] || detailFields[field]);
      })
    ) {
      reasons.push(`required_field_missing:${fields[0]}`);
    }
  }
  return reasons;
}

function interruptionFor(error, params, phase, branchIndex = null, candidate = null) {
  const detailPhase = phase === "detail";
  return {
    phase,
    branch_index: branchIndex,
    candidate_ref: candidate ? candidateReference(candidate) : null,
    evidence: error?.details ?? {},
    resume_tool: detailPhase ? "ypscan_manual_research" : "ypscan_manual_select_filters",
    resume_args: detailPhase
      ? {
          operation: "collect",
          requirement_id: params.requirement_id,
          platform: params.platform,
          run_id: params.run_id,
          selection_id: params.selection_id,
        }
      : {
          requirement_id: params.requirement_id,
          platform: params.platform,
          run_id: params.run_id,
          branch_index: branchIndex ?? 0,
        },
  };
}

function outputPayload({
  params,
  plan,
  branches,
  candidates,
  status,
  error = null,
  exportFallback = { status: "skipped", reason: "not_evaluated", quota_consumed: false },
  artifact = null,
  details = [],
  reviews = [],
  interruption = null,
}) {
  const merged = mergeManualCandidates(candidates);
  const partitioned = partitionCandidatesByPrice(merged, plan);
  const listPartitioned = partitionCandidatesByListHard(merged, plan);
  const annotatedCandidates = merged.map((candidate) => ({
    ...candidate,
    price_check: checkCandidatePrice(candidate, plan),
    list_hard_evaluation: evaluateCandidateList(candidate, plan),
  }));
  const publicCandidates = annotatedCandidates.map(publicCandidate);
  const previewLimit = plan.target_count > 20 ? 10 : MANUAL_RESEARCH_PREVIEW_LIMIT;
  const candidatePreview = publicCandidates.slice(0, previewLimit);
  const mergedDetails = mergeDetailRecords(details);
  const mergedReviews = mergeReviewRecords(reviews);
  const detailMap = new Map(mergedDetails.map((detail) => [detail.candidate_ref, detail]));
  const reviewMap = new Map(mergedReviews.map((review) => [review.candidate_ref, review]));
  const finalCandidateCount = annotatedCandidates.filter((candidate) => {
    const reference = candidateReference(candidate);
    return (
      detailMap.get(reference)?.hard_evaluation?.status === "pass" &&
      reviewMap.get(reference)?.decision === "include"
    );
  }).length;
  const deliveryShortfall = plan.target_count
    ? Math.max(plan.target_count - finalCandidateCount, 0)
    : 0;
  const runtimeUnexpressed = branches.flatMap((branch) => branch.unexpressed_filters ?? []);
  const pendingReview = reviewBatch(annotatedCandidates, mergedDetails, mergedReviews, {
    requirements: plan.review_requirements,
  });
  const deliveryStatus = plan.target_count
    ? pendingReview.remaining > 0
      ? "pending_review"
      : deliveryShortfall > 0
        ? "shortfall"
        : "target_met"
    : "not_requested";
  const detailLimit = detailQueueLimit(plan);
  return {
    success:
      status === "complete" || status === "partial" || status === "awaiting_filter_selection",
    status,
    user_action_required: status === "needs_user_action",
    requirement_id: params.requirement_id,
    platform: params.platform,
    source_url: params.page_url,
    original_price_policy: "customer_facts_as_expansion_anchor",
    manual_price_policy: "customer_value_50_to_120_percent",
    resumed_from_branch: params.resume_from_branch,
    plan: {
      keywords: plan.keywords,
      price_view: plan.price_view,
      price_policy: plan.price_policy,
      target_count: plan.target_count ?? null,
      collection_target: plan.collection_target ?? null,
      per_branch_target: plan.per_branch_target ?? null,
      planned_filters: plan.filters,
      detail_filters: plan.detail_filters ?? [],
      review_requirements: plan.review_requirements ?? [],
    },
    branches,
    failed_branches: [],
    candidates: candidatePreview,
    candidate_count: merged.length,
    eligible_candidate_count: partitioned.eligible.length,
    eligible_candidate_basis: "creator_price_only_legacy",
    price_eligible_candidate_count: partitioned.eligible.length,
    rejected_candidate_count: partitioned.rejected.length,
    needs_review_candidate_count: partitioned.needsReview.length,
    list_hard_pass_candidate_count: listPartitioned.passed.length,
    list_hard_rejected_candidate_count: listPartitioned.rejected.length,
    list_hard_pending_candidate_count: listPartitioned.pending.length,
    identity_blocked_candidate_count: annotatedCandidates.filter(
      (candidate) => !candidate.platform_id && !candidate.detail_url,
    ).length,
    delivery_shortfall: deliveryShortfall,
    delivery_status: deliveryStatus,
    candidate_returned_count: candidatePreview.length,
    candidates_truncated: publicCandidates.length > candidatePreview.length,
    artifact,
    detail_collection: {
      planned_count: Math.min(
        detailLimit,
        annotatedCandidates.filter(
          (candidate) =>
            candidate.list_hard_evaluation.status !== "fail" &&
            (candidate.platform_id || candidate.detail_url),
        ).length,
      ),
      completed_count: mergedDetails.length,
      complete_count: mergedDetails.filter((detail) => detail.status === "complete").length,
      partial_count: mergedDetails.filter((detail) => detail.status === "partial").length,
      blocked_count: mergedDetails.filter((detail) => detail.status === "blocked").length,
    },
    review_batch: pendingReview.tasks,
    review_remaining: pendingReview.remaining,
    review_completed_count: mergedReviews.length,
    unresolved_requirements: [...plan.unexpressed, ...runtimeUnexpressed],
    export_fallback: exportFallback,
    detail_tasks: pendingReview.tasks,
    detail_task_count: pendingReview.remaining,
    detail_tasks_truncated: pendingReview.remaining > pendingReview.tasks.length,
    detail_review: [
      "original_brief_relevance",
      "recent_content",
      "semantic_relevance",
      "customer_price_50_to_120_percent",
    ],
    next_branch: null,
    ...(status === "needs_user_action"
      ? {
          user_action: {
            preserve_current_page: true,
            instruction: "请在当前 Browser 页面完成登录或安全验证后，原样使用恢复参数继续。",
            ...(interruption
              ? {
                  resume_tool: interruption.resume_tool,
                  resume_args: interruption.resume_args,
                }
              : {}),
          },
          ...(interruption ? { interruption } : {}),
        }
      : {}),
    ...(error ? { error } : {}),
  };
}

function browserActionCall(params, state, action, extra = {}) {
  if (params.protocol_version === 3) {
    return {
      tool: "ypscan_manual_browser_inspect",
      args: {
        requirement_id: params.requirement_id,
        platform: params.platform,
        run_id: params.run_id,
      },
      intent: { action, ...extra },
      reason: "先观察当前页全部可交互元素，再由 Agent 选择 element_id 执行目标动作",
    };
  }
  return {
    tool: "ypscan_manual_browser_action",
    args: {
      requirement_id: params.requirement_id,
      platform: params.platform,
      run_id: params.run_id,
      action,
      expected_state_id: state.state_id,
      ...extra,
    },
    reason: {
      dismiss_modal: "关闭 Observer 已确认可安全关闭的普通弹窗",
      next_results_page: "进入下一页结果并验证页码或首行变化",
      open_creator_detail: "打开一个已持久化候选的详情页",
      activate_detail_section: "激活缺少证据的详情区块",
      return_to_market: "详情证据已保存，返回原达人广场",
      ensure_market_ready: "恢复到固定达人广场后重新筛选",
    }[action],
  };
}

function incrementalPayload({
  params,
  plan,
  branches,
  candidates,
  details,
  reviews,
  status,
  nextCall,
  artifact = null,
}) {
  return {
    ...outputPayload({
      params,
      plan,
      branches,
      candidates,
      details,
      reviews,
      status: artifact ? status : "partial",
      artifact,
    }),
    success: true,
    status,
    operation: "collect",
    protocol_version: plan.protocol_version ?? 2,
    run_id: params.run_id,
    next_call: nextCall ?? null,
  };
}

function mergeIncrementalFields(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (Array.isArray(value)) {
      target[key] = [
        ...new Map(
          [...(target[key] ?? []), ...value].map((item) => [JSON.stringify(item), item]),
        ).values(),
      ];
    } else if (value && typeof value === "object") {
      target[key] = { ...(target[key] ?? {}), ...value };
    } else if (target[key] === null || target[key] === undefined || target[key] === "") {
      target[key] = value;
    }
  }
  return target;
}

export function latestOpenCandidate(actions) {
  let candidateRef = null;
  for (const action of actions ?? []) {
    const reachedBlockedDetail =
      !action.ok &&
      Boolean(action.after_state_id) &&
      ["LOGIN_REQUIRED", "CAPTCHA_BLOCKED", "MODAL_BLOCKED"].includes(action.error?.code);
    if (
      (action.action === "open_creator_detail" ||
        (action.protocol_version === 3 && action.purpose === "detail" && action.candidate_ref)) &&
      action.candidate_ref &&
      (action.ok || reachedBlockedDetail)
    ) {
      candidateRef = action.candidate_ref;
    }
    if (
      action.ok &&
      (action.action === "return_to_market" || action.operation === "return_to_market")
    ) {
      candidateRef = null;
    }
  }
  return candidateRef;
}

function branchPages(events, branchId) {
  return (events ?? [])
    .filter((event) => event.type === "page" && event.branch?.branch_id === branchId)
    .map((event) => event.page);
}

function browserBlockedResult(params, plan, loaded, state) {
  const human = ["LOGIN_REQUIRED", "CAPTCHA_BLOCKED"].includes(state.page_state);
  const nextCall = human
    ? {
        tool: "ypscan_manual_browser_inspect",
        args: {
          requirement_id: params.requirement_id,
          platform: params.platform,
          run_id: params.run_id,
        },
        reason: "用户处理登录或安全验证后重新观察同一页面",
      }
    : state.page_state === "MODAL_BLOCKED" && state.modal.dismissible
      ? browserActionCall(params, state, "dismiss_modal", { modal_id: state.modal.modal_id })
      : null;
  const payload = {
    ...incrementalPayload({
      params,
      plan,
      branches: loaded.branches,
      candidates: loaded.candidates,
      details: loaded.details,
      reviews: loaded.reviews,
      status: human ? "needs_user_action" : "blocked",
      nextCall,
    }),
    success: false,
    user_action_required: human,
    error: {
      code: state.page_state,
      message: `当前 Browser 状态为 ${state.page_state}`,
      details: { state },
    },
  };
  return hostToolResult(payload, { details: payload, isError: true });
}

async function collectIncrementalV2({
  params,
  plan,
  loaded,
  selection,
  browser,
  artifactStore,
  createAdapter,
  workspaceDir,
  now,
  inspectBrowser,
}) {
  const observed = await inspectBrowser(browser, params.platform);
  const { page, state } = observed;
  params.page_url = state.url;
  if (!page) return browserBlockedResult(params, plan, loaded, state);
  if (["LOGIN_REQUIRED", "CAPTCHA_BLOCKED", "MODAL_BLOCKED"].includes(state.page_state)) {
    return browserBlockedResult(params, plan, loaded, state);
  }
  if (["WRONG_PAGE", "ERROR_PAGE", "UNKNOWN", "MARKET_LOADING"].includes(state.page_state)) {
    const payload = {
      ...incrementalPayload({
        params,
        plan,
        branches: loaded.branches,
        candidates: loaded.candidates,
        details: loaded.details,
        reviews: loaded.reviews,
        status: "failed",
        nextCall:
          state.page_state === "MARKET_LOADING"
            ? browserActionCall(params, state, "wait_for_ready", {
                target_states: ["MARKET_READY", "RESULTS_READY"],
              })
            : params.protocol_version === 3
              ? browserActionCall(params, state, "ensure_market_ready")
              : null,
      }),
      success: false,
      error: {
        code: state.page_state,
        message: "当前页面无法继续当前已验证分支；不得由抓取工具自动导航或重置",
        details: { state },
      },
    };
    return hostToolResult(payload, { details: payload, isError: true });
  }

  const candidates = [...loaded.candidates];
  const branches = [...loaded.branches];
  const details = [...loaded.details];
  const reviews = [...loaded.reviews];
  const completedBranchIds = new Set(branches.map((branch) => branch.branch_id));
  const branch = selection.branch;
  const resultContext =
    ["MARKET_READY", "RESULTS_READY"].includes(state.page_state) &&
    clean(state.market?.keyword) === clean(branch.keyword);

  if (!completedBranchIds.has(branch.branch_id)) {
    if (!resultContext) {
      const payload = {
        ...incrementalPayload({
          params,
          plan,
          branches,
          candidates,
          details,
          reviews,
          status: "failed",
          nextCall: null,
        }),
        success: false,
        error: {
          code: "YPSCAN_MANUAL_SELECTION_STALE",
          message: "当前结果页关键词与 selection_id 不一致",
          details: { requested: branch.keyword, current: state.market?.keyword ?? null },
        },
      };
      return hostToolResult(payload, { details: payload, isError: true });
    }
    const pageNumber = state.market?.page_number ?? 1;
    let pages = branchPages(loaded.events, branch.branch_id);
    const alreadyCaptured = pages.some((item) => item.page_number === pageNumber);
    if (!alreadyCaptured) {
      const adapter = createAdapter(params.platform, page, { workspaceDir, now });
      const pageData = await adapter.readPage(
        pageNumber,
        pageNumber === 1 ? (selection.list_snapshot ?? null) : null,
      );
      await adapter.dispose?.().catch(() => {});
      const pageRecord = {
        page_number: pageNumber,
        row_count: pageData.rows.length,
        first_candidate:
          pageData.rows[0]?.platform_id ??
          pageData.rows[0]?.detail_url ??
          pageData.rows[0]?.nickname ??
          null,
        signature: pageSignature(pageData),
        source_url: pageData.source_url,
        price_tier: pageData.price_tier,
        collection_source: pageData.collection_source ?? "dom",
        response_endpoint: pageData.response_endpoint ?? null,
        response_path: pageData.response_path ?? null,
      };
      const pageCandidates = pageData.rows.map((row) =>
        candidateFromRow(row, {
          platform: params.platform,
          branchId: branch.branch_id,
          pageNumber,
          priceTier: pageData.price_tier,
          sourceUrl: pageData.source_url,
        }),
      );
      await artifactStore.savePage({ branch, page: pageRecord, candidates: pageCandidates });
      candidates.push(...pageCandidates);
      pages = [...pages, pageRecord];
      await artifactStore.savePhaseTransition({
        phase: "RESULTS",
        branch_index: branch.branch_index,
        page_number: pageNumber,
      });
    }
    const merged = mergeManualCandidates(candidates);
    const branchCandidates = merged.filter((candidate) =>
      candidate.source_branches?.includes(branch.branch_id),
    );
    const viable = partitionCandidatesByListHard(branchCandidates, plan).viable.length;
    const shouldAdvance =
      state.market?.can_next_page === true &&
      pageNumber < MAX_PAGES_PER_BRANCH &&
      viable < plan.per_branch_target;
    if (shouldAdvance) {
      const payload = incrementalPayload({
        params,
        plan,
        branches,
        candidates: merged,
        details,
        reviews,
        status: "awaiting_browser_action",
        nextCall: browserActionCall(params, state, "next_results_page", {
          branch_index: branch.branch_index,
        }),
      });
      return hostToolResult(payload, { details: payload });
    }
    const branchRecord = {
      ...branch,
      actual_filters: selection.verification?.actual_filters ?? [],
      unexpressed_filters: selection.verification?.unexpressed_filters ?? [],
      price_view: selection.verification?.price_view ?? null,
      result_count: selection.verification?.keyword?.result_count ?? null,
      page_count: pages.length,
      pages,
      collection: {
        status:
          pages.some((item) => item.row_count > 0) || state.market?.result_row_count === 0
            ? "complete"
            : "incomplete",
        stop_reason:
          viable >= plan.per_branch_target
            ? "candidate_target_reached"
            : pageNumber >= MAX_PAGES_PER_BRANCH
              ? "page_limit_reached"
              : "end_of_results",
        candidate_count: branchCandidates.length,
        page_limit: MAX_PAGES_PER_BRANCH,
      },
      export: { status: "skipped", reason: "browser_list_primary_path", quota_consumed: false },
    };
    await artifactStore.saveBranch(branchRecord);
    await artifactStore.savePhaseTransition({
      phase: "LIST_COMPLETE",
      branch_index: branch.branch_index,
    });
    branches.push(branchRecord);
    const completed = new Set(branches.map((item) => item.branch_id));
    const mergedAll = mergeManualCandidates(candidates);
    const nextBranch = plan.branches.find((item) => !completed.has(item.branch_id));
    if (
      nextBranch &&
      partitionCandidatesByListHard(mergedAll, plan).viable.length < plan.collection_target
    ) {
      const payload = incrementalPayload({
        params,
        plan,
        branches,
        candidates: mergedAll,
        details,
        reviews,
        status: "awaiting_filter_selection",
        nextCall: {
          tool: "ypscan_manual_select_filters",
          args: {
            operation: "plan",
            requirement_id: params.requirement_id,
            platform: params.platform,
            run_id: params.run_id,
            branch_index: nextBranch.branch_index,
          },
          reason: "为下一个关键词分支生成 Browser 动作计划",
        },
      });
      return hostToolResult(payload, { details: payload });
    }
  }

  const mergedCandidates = mergeManualCandidates(candidates).map((candidate) => ({
    ...candidate,
    price_check: checkCandidatePrice(candidate, plan),
    list_hard_evaluation: evaluateCandidateList(candidate, plan),
  }));
  const existingDetailRefs = new Set(details.map((detail) => detail.candidate_ref));
  const detailQueue = mergedCandidates
    .filter(
      (candidate) =>
        candidate.list_hard_evaluation.status !== "fail" &&
        (candidate.platform_id || candidate.detail_url),
    )
    .slice(0, detailQueueLimit(plan));
  const activeCandidateRef = latestOpenCandidate(loaded.browser_actions);

  if (state.page_state === "CREATOR_DETAIL_READY") {
    if (!activeCandidateRef) {
      const payload = {
        ...incrementalPayload({
          params,
          plan,
          branches,
          candidates: mergedCandidates,
          details,
          reviews,
          status: "failed",
          nextCall: null,
        }),
        success: false,
        error: {
          code: "YPSCAN_MANUAL_DETAIL_CONTEXT_UNKNOWN",
          message: "当前详情页没有对应的已验证 open_creator_detail 动作",
        },
      };
      return hostToolResult(payload, { details: payload, isError: true });
    }
    const candidate = mergedCandidates.find(
      (item) => candidateReference(item) === activeCandidateRef,
    );
    if (!candidate) {
      throw manualBrowserError("YPSCAN_MANUAL_DETAIL_CONTEXT_UNKNOWN", "找不到当前详情候选");
    }
    if (existingDetailRefs.has(activeCandidateRef)) {
      const payload = incrementalPayload({
        params,
        plan,
        branches,
        candidates: mergedCandidates,
        details,
        reviews,
        status: "awaiting_browser_action",
        nextCall: browserActionCall(params, state, "return_to_market", {
          candidate_ref: activeCandidateRef,
        }),
      });
      return hostToolResult(payload, { details: payload });
    }
    const snapshot = await readCreatorDetailSnapshot(page, params.platform, candidate);
    const fields = {};
    const candidateActions = (loaded.browser_actions ?? []).filter(
      (action) => action.ok && action.candidate_ref === activeCandidateRef,
    );
    for (const action of candidateActions) {
      mergeIncrementalFields(fields, action.receipt?.capture?.fields);
      mergeIncrementalFields(fields, action.receipt?.fields);
    }
    mergeIncrementalFields(fields, snapshot.fields);
    const groups = detailGroupsForPlan(plan);
    const attempted = new Set(
      candidateActions
        .filter(
          (action) =>
            action.action === "activate_detail_section" ||
            (action.protocol_version === 3 && action.purpose === "detail" && action.detail_group),
        )
        .map((action) => action.detail_group),
    );
    const nextGroup = groups.find(
      (group) =>
        group !== "summary" && !detailGroupHasEvidence(group, fields) && !attempted.has(group),
    );
    if (nextGroup && snapshot.status !== "blocked") {
      const payload = incrementalPayload({
        params,
        plan,
        branches,
        candidates: mergedCandidates,
        details,
        reviews,
        status: "awaiting_browser_action",
        nextCall: browserActionCall(params, state, "activate_detail_section", {
          candidate_ref: activeCandidateRef,
          detail_group: nextGroup,
        }),
      });
      return hostToolResult(payload, { details: payload });
    }
    const missingGroups = groups.filter((group) =>
      group === "summary"
        ? Object.keys(fields).length === 0
        : !detailGroupHasEvidence(group, fields),
    );
    const collected = {
      candidate_ref: activeCandidateRef,
      platform_id: snapshot.platform_id ?? candidate.platform_id ?? null,
      nickname: candidate.nickname ?? null,
      detail_url: snapshot.detail_url ?? candidate.detail_url ?? null,
      status:
        snapshot.status === "blocked"
          ? "blocked"
          : Object.keys(fields).length && missingGroups.length === 0
            ? "complete"
            : "partial",
      reason:
        snapshot.status === "blocked"
          ? snapshot.reason
          : missingGroups.length
            ? "detail_groups_missing"
            : null,
      fields,
      completed_groups: groups.filter((group) => !missingGroups.includes(group)),
      missing_groups: missingGroups,
      source_type: "browser_action+dom",
      captured_at: new Date(now()).toISOString(),
    };
    const evaluation = evaluateCandidateDetail(candidate, collected, plan);
    const detail = {
      ...collected,
      fields: evaluation.fields,
      hard_evaluation:
        collected.status === "blocked" ? { ...evaluation, status: "unknown" } : evaluation,
    };
    details.push(detail);
    await artifactStore.saveDetail({
      detail,
      branches,
      candidates: mergedCandidates,
      details: mergeDetailRecords(details),
      reviews,
      status: "collecting_details",
      detailPlannedCount: detailQueue.length,
    });
    await artifactStore.savePhaseTransition({
      phase: "DETAIL_CAPTURED",
      candidate_ref: activeCandidateRef,
    });
    const payload = incrementalPayload({
      params,
      plan,
      branches,
      candidates: mergedCandidates,
      details,
      reviews,
      status: "awaiting_browser_action",
      nextCall: browserActionCall(params, state, "return_to_market", {
        candidate_ref: activeCandidateRef,
      }),
    });
    return hostToolResult(payload, { details: payload });
  }

  if (!["MARKET_READY", "RESULTS_READY"].includes(state.page_state)) {
    return browserBlockedResult(params, plan, loaded, state);
  }
  const nextCandidate = detailQueue.find(
    (candidate) => !existingDetailRefs.has(candidateReference(candidate)),
  );
  if (nextCandidate) {
    await artifactStore.savePhaseTransition({
      phase: "DETAIL_PENDING",
      candidate_ref: candidateReference(nextCandidate),
    });
    const payload = incrementalPayload({
      params,
      plan,
      branches,
      candidates: mergedCandidates,
      details,
      reviews,
      status: "awaiting_browser_action",
      nextCall: browserActionCall(params, state, "open_creator_detail", {
        candidate_ref: candidateReference(nextCandidate),
      }),
    });
    return hostToolResult(payload, { details: payload });
  }

  const pendingReview = reviewBatch(mergedCandidates, details, reviews, {
    requirements: plan.review_requirements,
  });
  const incompleteDetails = mergeDetailRecords(details).some(
    (detail) => detail.status !== "complete" || detail.hard_evaluation?.status === "unknown",
  );
  const finalStatus =
    incompleteDetails || pendingReview.remaining > 0 || plan.unexpressed.length
      ? "partial"
      : "complete";
  const artifact = await artifactStore.finalize({
    branches,
    candidates: mergedCandidates,
    details: mergeDetailRecords(details),
    reviews: mergeReviewRecords(reviews),
    status: finalStatus,
    exportFallback: {
      status: "skipped",
      reason: "agent_orchestrated_browser_collection",
      reasons: [],
      quota_consumed: false,
    },
    detailPlannedCount: detailQueue.length,
  });
  await artifactStore.savePhaseTransition({
    phase: pendingReview.remaining ? "REVIEW_PENDING" : "COMPLETE",
  });
  const payload = incrementalPayload({
    params,
    plan,
    branches,
    candidates: mergedCandidates,
    details,
    reviews,
    status: finalStatus,
    nextCall: null,
    artifact,
  });
  return hostToolResult(payload, { details: payload });
}

/**
 * Create the checkpointed two-platform research runner. It connects to the
 * host's existing Browser over CDP and deliberately never closes that Browser.
 *
 * @param {{
 *   browserCdpUrl?: string,
 *   workspaceDir?: string,
 *   connectOverCDP?: (endpointURL: string) => Promise<import("playwright-core").Browser>,
 *   createAdapter?: (platform: string, page: import("playwright-core").Page, options: any) => any,
 *   createArtifactStore?: typeof createManualResearchStore,
 *   inspectBrowser?: typeof inspectManualBrowser,
 *   now?: () => number,
 * }} [options]
 */
export function createManualResearch({
  browserCdpUrl = DEFAULT_CDP_URL,
  workspaceDir,
  connectOverCDP = (endpointURL) => chromium.connectOverCDP(endpointURL),
  createAdapter = createManualResearchAdapter,
  createArtifactStore = createManualResearchStore,
  inspectBrowser = inspectManualBrowser,
  now = Date.now,
} = {}) {
  const cdpUrl = requiredString(browserCdpUrl, "browserCdpUrl").replace(/\/$/u, "");
  return async function manualResearch(rawParams = {}) {
    let params;
    let plan;
    let adapter;
    let artifactStore;
    const completedBranches = [];
    const candidates = [];
    const details = [];
    const reviews = [];
    let activePhase = "arguments";
    let activeBranchIndex = null;
    let activeCandidate = null;
    try {
      params = validateManualResearchParams(rawParams);
      if (params.operation === "legacy_collect") {
        const payload = {
          success: false,
          status: "failed",
          operation: "collect",
          requirement_id: params.requirement_id,
          platform: params.platform,
          ready_for_collection: false,
          selector_args: params.selector_args,
          error: {
            code: "YPSCAN_MANUAL_SELECTION_REQUIRED",
            message: "抓取前必须先调用 ypscan_manual_select_filters",
          },
        };
        return hostToolResult(payload, { details: payload, isError: true });
      }
      if (params.operation === "apply_reviews") {
        const result = await applyManualResearchReviews({
          workspaceDir,
          runId: params.run_id,
          requirementId: params.requirement_id,
          platform: params.platform,
          reviews: params.reviews,
          now,
        });
        const payload = {
          success: true,
          status: result.status,
          requirement_id: params.requirement_id,
          platform: params.platform,
          operation: "apply_reviews",
          candidate_count: result.candidates.length,
          detail_collection: {
            planned_count: Math.min(detailQueueLimit(result.plan), result.candidates.length),
            completed_count: result.details.length,
          },
          review_batch: result.review_batch,
          review_remaining: result.review_remaining,
          review_completed_count: result.reviews.length,
          artifact: result.artifact,
        };
        return hostToolResult(payload, { details: payload });
      }

      const loaded = await loadManualResearchRun({
        workspaceDir,
        runId: params.run_id,
        requirementId: params.requirement_id,
        platform: params.platform,
      });
      plan = loaded.plan;
      params = {
        ...params,
        page_url: null,
        resume_from_branch: 0,
        fresh_run: false,
      };
      artifactStore = await createArtifactStore({
        workspaceDir,
        params: { ...loaded.params, ...params },
        plan,
        now,
      });
      completedBranches.push(...(artifactStore.restored?.branches ?? []));
      candidates.push(...(artifactStore.restored?.candidates ?? []));
      details.push(...(artifactStore.restored?.details ?? []));
      reviews.push(...(artifactStore.restored?.reviews ?? []));

      const selection = params.selection_id
        ? loaded.selections.filter((item) => item?.selection_id === params.selection_id).at(-1)
        : loaded.selections.filter((item) => item?.status === "ready").at(-1);
      if (!selection || selection.status !== "ready") {
        throw manualBrowserError(
          "YPSCAN_MANUAL_SELECTION_STALE",
          "selection_id 不存在、未就绪或已经失效",
        );
      }
      params.protocol_version = selection.protocol_version ?? 1;
      const latestForBranch = loaded.selections
        .filter((item) => item?.branch?.branch_id === selection.branch?.branch_id)
        .at(-1);
      if (latestForBranch?.selection_id !== selection.selection_id) {
        throw manualBrowserError("YPSCAN_MANUAL_SELECTION_STALE", "该关键词分支已有更新的筛选凭证");
      }
      if ([2, 3].includes(selection.protocol_version)) {
        const browser = await connectOverCDP(cdpUrl);
        return collectIncrementalV2({
          params,
          plan,
          loaded,
          selection,
          browser,
          artifactStore,
          createAdapter,
          workspaceDir,
          now,
          inspectBrowser,
        });
      }
      const completedBranchIds = new Set(
        completedBranches.map((branch) => branch.branch_id).filter(Boolean),
      );
      const branchAlreadyCollected = completedBranchIds.has(selection.branch.branch_id);
      if (!branchAlreadyCollected) {
        activePhase = "list";
        activeBranchIndex = selection.branch.branch_index;
        const browser = await connectOverCDP(cdpUrl);
        const page = await resolveManualResearchPage(browser, params.platform);
        params.page_url = page.url();
        adapter = createAdapter(params.platform, page, { workspaceDir, now });
        await adapter.prepare();
        if (typeof adapter.verifySelection !== "function") {
          throw manualBrowserError(
            "YPSCAN_MANUAL_SELECTION_STALE",
            "当前平台适配器无法复核筛选凭证",
          );
        }
        const currentState = await adapter.verifySelection(selection);
        if (!currentState?.valid) {
          throw manualBrowserError(
            "YPSCAN_MANUAL_SELECTION_STALE",
            "当前页面筛选状态与 selection_id 不一致",
            { verification: currentState },
          );
        }
        const branchResult = await collectSelectedBranchWithRecovery(
          adapter,
          selection,
          plan,
          params.platform,
          (checkpoint) => artifactStore.savePage(checkpoint),
        );
        completedBranches.push(branchResult.branch);
        candidates.push(...branchResult.candidates);
        await artifactStore.saveBranch(branchResult.branch);
      }

      const mergedAfterBranch = mergeManualCandidates(candidates);
      const eligibleAfterBranch = partitionCandidatesByListHard(mergedAfterBranch, plan).viable
        .length;
      const completedAfterBranch = new Set(
        completedBranches.map((branch) => branch.branch_id).filter(Boolean),
      );
      const nextBranch = plan.branches.find(
        (branch) => !completedAfterBranch.has(branch.branch_id),
      );
      if (eligibleAfterBranch < plan.collection_target && nextBranch) {
        const artifact = await artifactStore.snapshot({
          branches: completedBranches,
          candidates: mergedAfterBranch,
          details: mergeDetailRecords(details),
          reviews: mergeReviewRecords(reviews),
          status: "awaiting_filter_selection",
        });
        const payload = {
          ...outputPayload({
            params,
            plan,
            branches: completedBranches,
            candidates: mergedAfterBranch,
            details,
            reviews,
            status: "awaiting_filter_selection",
            artifact,
          }),
          operation: "collect",
          run_id: artifactStore.run_id,
          next_selection_args: {
            requirement_id: params.requirement_id,
            platform: params.platform,
            run_id: artifactStore.run_id,
            branch_index: nextBranch.branch_index,
          },
        };
        return hostToolResult(payload, { details: payload });
      }

      if (!adapter) {
        activePhase = "detail";
        const browser = await connectOverCDP(cdpUrl);
        const page = await resolveManualResearchPage(browser, params.platform);
        params.page_url = page.url();
        adapter = createAdapter(params.platform, page, { workspaceDir, now });
        await adapter.prepare();
      }

      const mergedCandidates = mergeManualCandidates(candidates).map((candidate) => ({
        ...candidate,
        price_check: checkCandidatePrice(candidate, plan),
        list_hard_evaluation: evaluateCandidateList(candidate, plan),
      }));
      const detailQueue = mergedCandidates
        .filter(
          (candidate) =>
            candidate.list_hard_evaluation.status !== "fail" &&
            (candidate.platform_id || candidate.detail_url),
        )
        .slice(0, detailQueueLimit(plan));
      const existingDetails = new Set(
        mergeDetailRecords(details).map((detail) => detail.candidate_ref),
      );
      const pendingDetails = detailQueue.filter(
        (candidate) => !existingDetails.has(candidateReference(candidate)),
      );
      const detailGroups = detailGroupsForPlan(plan);
      for (const [index, candidate] of pendingDetails.entries()) {
        activePhase = "detail";
        activeCandidate = candidate;
        try {
          const collected = adapter?.collectDetail
            ? await collectDetailWithRecovery(adapter, candidate, detailGroups)
            : {
                candidate_ref: candidateReference(candidate),
                platform_id: candidate.platform_id ?? null,
                nickname: candidate.nickname ?? null,
                detail_url: candidate.detail_url ?? null,
                status: "blocked",
                reason: "detail_adapter_unavailable",
                fields: {},
              };
          const evaluation = evaluateCandidateDetail(candidate, collected, plan);
          const detail = {
            ...collected,
            fields: evaluation.fields,
            hard_evaluation:
              collected.status === "blocked" ? { ...evaluation, status: "unknown" } : evaluation,
          };
          details.push(detail);
          await artifactStore.saveDetail({
            detail,
            branches: completedBranches,
            candidates: mergedCandidates,
            details: mergeDetailRecords(details),
            reviews: mergeReviewRecords(reviews),
            status: "collecting_details",
            detailPlannedCount: detailQueue.length,
          });
          if (index < pendingDetails.length - 1) await adapter?.paceDetail?.();
        } catch (error) {
          if (!requiresUserAction(error)) throw error;
          const interruption = interruptionFor(
            error,
            params,
            "detail",
            selection.branch.branch_index,
            candidate,
          );
          await artifactStore.saveInterruption?.(interruption);
          const artifact = await artifactStore.finalize({
            branches: completedBranches,
            candidates: mergedCandidates,
            details: mergeDetailRecords(details),
            reviews: mergeReviewRecords(reviews),
            status: "needs_user_action",
            detailPlannedCount: detailQueue.length,
          });
          const payload = outputPayload({
            params,
            plan,
            branches: completedBranches,
            candidates: mergedCandidates,
            details,
            reviews,
            status: "needs_user_action",
            artifact,
            error: {
              code: error?.code ?? "YPSCAN_MANUAL_DETAIL_FAILED",
              message: error?.message ?? String(error),
              details: error?.details ?? {},
            },
            interruption,
          });
          return hostToolResult(payload, { details: payload, isError: true });
        }
      }
      const fallbackReasons = exportFallbackReasons(
        plan,
        completedBranches,
        mergedCandidates,
        details,
      );
      let exportFallback = {
        status: "skipped",
        reason: "browser_list_collection_sufficient",
        reasons: [],
        quota_consumed: false,
      };
      if (fallbackReasons.length) {
        try {
          exportFallback = {
            ...(await adapter.export()),
            reason: fallbackReasons[0],
            reasons: fallbackReasons,
            quota_consumed: true,
          };
        } catch (error) {
          exportFallback = {
            status: "failed",
            reason: fallbackReasons[0],
            reasons: fallbackReasons,
            error: error?.code ?? error?.message ?? String(error),
            quota_consumed: true,
          };
        }
        const fallbackBranch = completedBranches.at(-1);
        if (fallbackBranch) fallbackBranch.export = exportFallback;
      }
      const requiresExportFollowup = exportFallback.status !== "skipped";
      const hasUnexpressedHardFilters = completedBranches.some(
        (branch) => (branch.unexpressed_filters?.length ?? 0) > 0,
      );
      const pendingReview = reviewBatch(mergedCandidates, details, reviews, {
        requirements: plan.review_requirements,
      });
      const incompleteDetails = mergeDetailRecords(details).some(
        (detail) => detail.status !== "complete" || detail.hard_evaluation?.status === "unknown",
      );
      const finalStatus =
        requiresExportFollowup ||
        hasUnexpressedHardFilters ||
        incompleteDetails ||
        pendingReview.remaining > 0
          ? "partial"
          : "complete";
      const artifact = await artifactStore.finalize({
        branches: completedBranches,
        candidates: mergedCandidates,
        details: mergeDetailRecords(details),
        reviews: mergeReviewRecords(reviews),
        status: finalStatus,
        exportFallback,
        detailPlannedCount: detailQueue.length,
      });
      const payload = outputPayload({
        params,
        plan,
        branches: completedBranches,
        candidates: mergedCandidates,
        details,
        reviews,
        status: finalStatus,
        exportFallback,
        artifact,
      });
      return hostToolResult(payload, { details: payload });
    } catch (error) {
      const fallbackParams = params ?? {
        requirement_id: clean(rawParams.requirement_id) || null,
        platform: clean(rawParams.platform) || null,
        page_url: clean(rawParams.page_url) || null,
        resume_from_branch: rawParams.resume_from_branch ?? 0,
      };
      const fallbackPlan = plan ?? {
        keywords: [],
        filters: [],
        unexpressed: [],
        target_count: null,
        collection_target: null,
        per_branch_target: null,
      };
      const artifact = artifactStore?.enabled
        ? await (async () => {
            const interruption = requiresUserAction(error)
              ? interruptionFor(
                  error,
                  fallbackParams,
                  activePhase === "detail" ? "detail" : "list",
                  activeBranchIndex,
                  activeCandidate,
                )
              : null;
            if (interruption) await artifactStore.saveInterruption?.(interruption);
            return artifactStore.finalize({
              branches: completedBranches,
              candidates: mergeManualCandidates(candidates),
              details: mergeDetailRecords(details),
              reviews: mergeReviewRecords(reviews),
              status: requiresUserAction(error) ? "needs_user_action" : "failed",
            });
          })().catch(() => null)
        : null;
      const interruption = requiresUserAction(error)
        ? interruptionFor(
            error,
            fallbackParams,
            activePhase === "detail" ? "detail" : "list",
            activeBranchIndex,
            activeCandidate,
          )
        : null;
      const payload = outputPayload({
        params: fallbackParams,
        plan: fallbackPlan,
        branches: completedBranches,
        candidates,
        details,
        reviews,
        status: requiresUserAction(error) ? "needs_user_action" : "failed",
        artifact,
        error: {
          code: error?.code ?? "YPSCAN_MANUAL_RESEARCH_FAILED",
          message: error?.message ?? String(error),
          details: error?.details ?? {},
        },
        interruption,
      });
      return hostToolResult(payload, { details: payload, isError: true });
    } finally {
      await adapter?.dispose?.().catch(() => {});
    }
  };
}
