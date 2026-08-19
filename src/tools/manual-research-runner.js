import {
  applyManualResearchReviews,
  createManualResearchStore,
  createManualResearchSubmission,
  loadManualResearchRun,
  MANUAL_RESEARCH_PREVIEW_LIMIT,
} from "./manual-research-artifact.js";
import {
  candidateReference,
  detailGroupsForPlan,
  evaluateCandidateDetail,
  mergeDetailRecords,
  mergeReviewRecords,
  reviewBatch,
} from "./manual-research-detail.js";
import { compileManualResearchPlan, mergeManualCandidates } from "./manual-research-plan.js";
import { validateCreatorPriceFact } from "./manual-research-protocol.js";
import { createPgyAdapter } from "./manual-research/pgy-adapter.js";
import { createXingtuAdapter } from "./manual-research/xingtu-adapter.js";
import { cleanText, manualBrowserError } from "./manual-research/common.js";
import { hostToolResult } from "./tool-result.js";

const RUN_BUDGET_MS = 180_000;
const PERSIST_RESERVE_MS = 15_000;
const ACTION_TIMEOUT_MS = 6_000;
const MAX_PAGES_PER_BRANCH = 5;
const MAX_PAGES_TOTAL = 12;
const MAX_DETAILS = 10;

const PUBLIC_OPERATIONS = Object.freeze(["start", "resume", "apply_reviews", "create_submission"]);
const PLATFORMS = Object.freeze(["xingtu", "pgy", "douyin", "xiaohongshu"]);

export const MANUAL_RESEARCH_RUNNER_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["operation", "requirement_id", "platform"],
  properties: {
    operation: { type: "string", enum: [...PUBLIC_OPERATIONS] },
    requirement_id: { type: "string", minLength: 1 },
    platform: { type: "string", enum: [...PLATFORMS] },
    run_id: { type: "string", minLength: 1 },
    facts: { type: "array", items: { type: "object" } },
    keywords: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
    fresh_run: { type: "boolean" },
    reviews: {
      type: "array",
      minItems: 1,
      maxItems: 20,
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
  },
});

function argumentError(message) {
  return manualBrowserError("YPSCAN_MANUAL_ARGUMENT_INVALID", message);
}

function required(value, name) {
  const result = cleanText(value);
  if (!result) throw argumentError(`${name} 不能为空`);
  return result;
}

function platformName(value) {
  const platform = required(value, "platform").toLowerCase();
  if (platform === "douyin") return "xingtu";
  if (platform === "xiaohongshu") return "pgy";
  if (!PLATFORMS.slice(0, 2).includes(platform)) throw argumentError(`不支持平台：${platform}`);
  return platform;
}

function validateParams(input = {}) {
  const operation = required(input.operation, "operation");
  if (!PUBLIC_OPERATIONS.includes(operation)) {
    if (["capture_list", "capture_detail", "finalize", "collect"].includes(operation)) {
      throw argumentError(`旧操作 ${operation} 已停用；请使用 start 或 resume`);
    }
    throw argumentError(`不支持 operation：${operation}`);
  }
  const params = {
    operation,
    requirement_id: required(input.requirement_id, "requirement_id"),
    platform: platformName(input.platform),
  };
  if (operation === "start") {
    if (!Array.isArray(input.facts)) throw argumentError("start 必须提供完整 facts");
    for (const fact of input.facts) validateCreatorPriceFact(fact);
    const keywords = [...new Set((input.keywords ?? []).map(cleanText).filter(Boolean))].slice(0, 4);
    if (!keywords.length) throw argumentError("start 必须提供 1–4 个关键词");
    Object.assign(params, { facts: input.facts, keywords, fresh_run: input.fresh_run === true });
  } else {
    params.run_id = required(input.run_id, "run_id");
  }
  if (operation === "apply_reviews") {
    if (!Array.isArray(input.reviews) || !input.reviews.length || input.reviews.length > 20) {
      throw argumentError("apply_reviews 必须提供 1–20 条 reviews");
    }
    params.reviews = input.reviews;
  }
  return params;
}

function candidateFromRow(row, source) {
  return {
    platform: source.platform,
    platform_id: row.platform_id ?? null,
    nickname: cleanText(row.nickname) || null,
    detail_url: row.detail_url ?? null,
    source_url: row.source_url ?? source.source_url,
    source_branches: [source.branch_id],
    source_pages: [source.page_number],
    quote_tier: row.format ?? source.price_tier ?? null,
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
    collection_mode: source.collection_mode,
    raw_text: row.raw_text ?? null,
  };
}

async function genericVisibleRows(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
    const visible = (node) => Boolean(node?.getClientRects?.().length);
    const selectors = "tbody tr,[role=row],[class*=creator-card],[class*=kol-card],[class*=author-card]";
    return [...globalThis.document.querySelectorAll(selectors)]
      .filter(visible)
      .filter((node) => !node.closest("thead"))
      .map((node) => {
        const raw = clean(/** @type {HTMLElement} */ (node).innerText || node.textContent);
        const links = [...node.querySelectorAll("a[href]")].map(
          (item) => /** @type {HTMLAnchorElement} */ (item).href,
        );
        const detailUrl = links.find((href) => /author|creator|kol|blogger|profile/iu.test(href));
        const nickname = clean(
          node.querySelector("[class*=nickname],[class*=name],a")?.textContent ?? raw.split(" ")[0],
        );
        return {
          nickname,
          detail_url: detailUrl ?? null,
          raw_text: raw,
          source_url: globalThis.location.href,
        };
      })
      .filter((row) => row.raw_text.length > 5 && (row.nickname || row.detail_url))
      .slice(0, 200);
  });
}

function timeoutError(label) {
  return manualBrowserError("YPSCAN_MANUAL_ACTION_TIMEOUT", `${label} 超时`);
}

async function bounded(label, promise, timeoutMs = ACTION_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(label)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function retryBrowserAction(label, action, adapter, timeoutMs = ACTION_TIMEOUT_MS) {
  try {
    return await bounded(label, Promise.resolve().then(action), timeoutMs);
  } catch (firstError) {
    if (needsUser(firstError) || typeof adapter?.recover !== "function") throw firstError;
    await bounded(`${label}恢复页面`, Promise.resolve().then(() => adapter.recover()), timeoutMs);
    return bounded(`${label}重试`, Promise.resolve().then(action), timeoutMs);
  }
}

function needsUser(error) {
  return ["YPSCAN_MANUAL_LOGIN_REQUIRED", "YPSCAN_MANUAL_CAPTCHA_REQUIRED"].includes(error?.code);
}

function persistenceFailure(error) {
  return ["YPSCAN_MANUAL_CHECKPOINT_FAILED", "YPSCAN_MANUAL_ARTIFACT_FAILED"].includes(error?.code);
}

const QUALITY_RANK = Object.freeze({ exact: 0, degraded: 1, unverified: 2 });

function lowerQuality(state, quality) {
  if ((QUALITY_RANK[quality] ?? 2) > (QUALITY_RANK[state.quality_level] ?? 2)) {
    state.quality_level = quality;
  }
}

function createRunInfo(params, plan, state, now, candidateCount = 0) {
  return {
    requirement_id: params.requirement_id,
    platform: params.platform,
    phase: state.phase,
    quality_level: state.quality_level,
    updated_at: new Date(now()).toISOString(),
    target_count: plan.target_count ?? null,
    candidate_count: candidateCount,
    candidate_shortfall: plan.target_count ? Math.max(plan.target_count - candidateCount, 0) : 0,
    completed_keywords: [...state.completed_keywords],
    completed_pages: state.completed_pages,
    fallback_modes_used: [...state.fallback_modes],
    applied_filters: [...state.applied_filters],
    unapplied_filters: [...state.unapplied_filters],
    detail_attempted: state.detail_attempted,
    detail_completed: state.detail_completed,
    error_code: state.error_code,
    error_message: state.error_message,
    resume_available: state.resume_available,
    resume_instruction: state.resume_instruction,
  };
}

function runnerState(params, state, executionStatus, now) {
  return {
    schema_version: 1,
    phase: state.phase,
    branch_index: state.branch_index,
    keyword: state.keyword,
    collection_mode: state.collection_mode,
    page_number: state.page_number,
    completed_branch_indexes: [...state.completed_branch_indexes],
    completed_keywords: [...state.completed_keywords],
    fallback_modes: [...state.fallback_modes],
    applied_filters: [...state.applied_filters],
    unapplied_filters: [...state.unapplied_filters],
    detail_cursor: state.detail_attempted,
    execution_status: executionStatus,
    quality_level: state.quality_level,
    error_code: state.error_code,
    error_message: state.error_message,
    updated_at: new Date(now()).toISOString(),
    requirement_id: params.requirement_id,
    platform: params.platform,
  };
}

function createState(restored = {}) {
  const latest = restored.runner_states?.at(-1) ?? {};
  return {
    phase: "created",
    branch_index: latest.branch_index ?? 0,
    keyword: latest.keyword ?? null,
    collection_mode: latest.collection_mode ?? "filtered",
    page_number: 1,
    completed_branch_indexes: new Set(latest.completed_branch_indexes ?? []),
    completed_keywords: new Set(latest.completed_keywords ?? []),
    completed_pages: restored.page_count ?? 0,
    fallback_modes: new Set(latest.fallback_modes ?? []),
    applied_filters: new Set(latest.applied_filters ?? []),
    unapplied_filters: new Set(latest.unapplied_filters ?? []),
    quality_level: latest.quality_level ?? "unverified",
    detail_attempted: latest.detail_cursor ?? restored.details?.length ?? 0,
    detail_completed: restored.details?.filter((item) => item.status === "complete").length ?? 0,
    error_code: null,
    error_message: null,
    resume_available: false,
    resume_instruction: null,
  };
}

function publicPayload({ params, plan, store, state, candidates, details, reviews, status, artifact }) {
  const pending = reviewBatch(candidates, details, reviews, {
    requirements: plan.review_requirements,
  });
  return {
    success: status !== "failed",
    status,
    quality_level: state.quality_level,
    operation: params.operation,
    requirement_id: params.requirement_id,
    platform: params.platform,
    run_id: store.run_id,
    candidate_count: candidates.length,
    candidates: candidates.slice(0, MANUAL_RESEARCH_PREVIEW_LIMIT),
    review_batch: pending.tasks,
    review_remaining: pending.remaining,
    delivery_shortfall: plan.target_count ? Math.max(plan.target_count - candidates.length, 0) : 0,
    artifact,
    ...(state.resume_available
      ? {
          resume_args: {
            operation: "resume",
            requirement_id: params.requirement_id,
            platform: params.platform,
            run_id: store.run_id,
          },
        }
      : {}),
    ...(state.error_code
      ? { error: { code: state.error_code, message: state.error_message } }
      : {}),
  };
}

function defaultAdapter(platform, page, options) {
  return platform === "xingtu" ? createXingtuAdapter(page, options) : createPgyAdapter(page, options);
}

/**
 * Finish-first manual research runner.
 * @param {{
 *   workspaceDir?: string,
 *   browserRuntime?: any,
 *   createAdapter?: typeof defaultAdapter,
 *   createStore?: typeof createManualResearchStore,
 *   now?: () => number,
 * }} [options]
 */
export function createManualResearchRunner({
  workspaceDir,
  browserRuntime,
  createAdapter = defaultAdapter,
  createStore = createManualResearchStore,
  now = Date.now,
} = {}) {
  return async function runManualResearch(rawParams = {}) {
    let params;
    try {
      params = validateParams(rawParams);
      if (params.operation === "apply_reviews") {
        const result = await applyManualResearchReviews({
          workspaceDir,
          runId: params.run_id,
          requirementId: params.requirement_id,
          platform: params.platform,
          reviews: params.reviews,
          now,
        });
        return hostToolResult({
          success: true,
          status: result.status,
          operation: params.operation,
          requirement_id: params.requirement_id,
          platform: params.platform,
          run_id: params.run_id,
          review_batch: result.review_batch,
          review_remaining: result.review_remaining,
          artifact: result.artifact,
        });
      }
      if (params.operation === "create_submission") {
        const artifact = await createManualResearchSubmission({
          workspaceDir,
          runId: params.run_id,
          requirementId: params.requirement_id,
          platform: params.platform,
          now,
        });
        return hostToolResult({
          success: true,
          status: "complete",
          operation: params.operation,
          requirement_id: params.requirement_id,
          platform: params.platform,
          run_id: params.run_id,
          artifact,
          submission_path: artifact.submission_path,
          row_count: artifact.row_count,
        });
      }

      let plan;
      let restored;
      if (params.operation === "start") {
        plan = compileManualResearchPlan(params);
        restored = null;
      } else {
        restored = await loadManualResearchRun({
          workspaceDir,
          runId: params.run_id,
          requirementId: params.requirement_id,
          platform: params.platform,
        });
        plan = restored.plan;
      }
      const store = await createStore({
        workspaceDir,
        params: params.operation === "start" ? params : { ...restored.params, ...params },
        plan,
        now,
      });
      if (!store.enabled || !store.run_id) throw argumentError("当前项目目录不可用，无法生成手扒产物");
      const saved = restored ?? store.restored;
      let candidates = mergeManualCandidates(saved.candidates ?? []);
      let details = mergeDetailRecords(saved.details ?? []);
      const reviews = mergeReviewRecords(saved.reviews ?? []);
      const branches = [...(saved.branches ?? [])];
      const state = createState(saved);
      const poolTarget = Math.min(200, Math.max(plan.target_count ?? 20, 20));
      const deadline = now() + RUN_BUDGET_MS - PERSIST_RESERVE_MS;

      const materialize = async (status, final = false) => {
        const runInfo = createRunInfo(params, plan, state, now, candidates.length);
        const artifact = await (final ? store.finalize : store.snapshot)({
          branches,
          candidates,
          details,
          reviews,
          status,
          detailPlannedCount: Math.min(MAX_DETAILS, candidates.length),
          runInfo,
        });
        await store.saveRunnerState(runnerState(params, state, status, now));
        return artifact;
      };

      const latestRunnerState = saved.runner_states?.at(-1);
      if (latestRunnerState?.phase === "terminal" && params.fresh_run !== true) {
        state.phase = "terminal";
        const terminalStatus = latestRunnerState.execution_status ?? "complete";
        const artifact = await materialize(terminalStatus);
        return hostToolResult(
          publicPayload({
            params,
            plan,
            store,
            state,
            candidates,
            details,
            reviews,
            status: terminalStatus,
            artifact,
          }),
        );
      }

      let artifact = await materialize("created");
      let lock;
      try {
        lock = browserRuntime?.acquire?.(store.run_id);
        if (!lock) throw manualBrowserError("YPSCAN_MANUAL_BROWSER_UNAVAILABLE", "浏览器 Runner 未初始化");
      } catch (error) {
        state.phase = "terminal";
        state.error_code = error?.code ?? "YPSCAN_MANUAL_BROWSER_UNAVAILABLE";
        state.error_message = error?.message ?? String(error);
        state.quality_level = "unverified";
        artifact = await materialize("failed_with_artifact", true);
        return hostToolResult(
          publicPayload({
            params,
            plan,
            store,
            state,
            candidates,
            details,
            reviews,
            status: "failed_with_artifact",
            artifact,
          }),
        );
      }
      if (!lock.acquired) {
        state.phase = "awaiting_user";
        state.quality_level = "unverified";
        state.error_code = "YPSCAN_MANUAL_BUSY";
        state.error_message = `另一手扒运行正在占用浏览器：${lock.active_run_id}`;
        state.resume_available = true;
        state.resume_instruction = "前一运行结束后原样调用 resume";
        artifact = await materialize("busy", true);
        return hostToolResult(
          publicPayload({ params, plan, store, state, candidates, details, reviews, status: "busy", artifact }),
        );
      }

      let adapter;
      let timedOut = false;
      try {
        state.phase = "opening_browser";
        await store.saveRunnerState(runnerState(params, state, "running", now));
        const page = await bounded(
          "启动浏览器",
          browserRuntime.page(params.platform, workspaceDir),
          20_000,
        );
        adapter = createAdapter(params.platform, page, { workspaceDir, now });
        await retryBrowserAction("准备达人广场", () => adapter.prepare(), adapter, 15_000);
        if (state.quality_level === "unverified" && state.fallback_modes.size === 0) {
          state.quality_level = "exact";
        }

        const collect = async (branch, mode, applyFilters) => {
          if (now() >= deadline || candidates.length >= poolTarget || state.completed_pages >= MAX_PAGES_TOTAL) return;
          state.phase = "filtering";
          state.branch_index = branch.branch_index;
          state.keyword = branch.keyword;
          state.collection_mode = mode;
          if (mode !== "filtered") state.fallback_modes.add(mode);
          await retryBrowserAction("重置筛选", () => adapter.reset(), adapter);
          if (typeof adapter.verifyBaseline === "function") {
            const baseline = await retryBrowserAction(
              "验证筛选复位",
              () => adapter.verifyBaseline(),
              adapter,
            );
            if (baseline?.valid === false) {
              lowerQuality(state, "degraded");
              state.unapplied_filters.add("筛选复位未验证");
            }
          }
          let allApplied = true;
          if (applyFilters) {
            if (plan.price_view) {
              try {
                const result = await retryBrowserAction(
                  "切换报价类型",
                  () => adapter.setPriceView(plan.price_view),
                  adapter,
                );
                if (result?.applied) state.applied_filters.add(`报价类型=${plan.price_view}`);
                else {
                  allApplied = false;
                  state.unapplied_filters.add(`报价类型=${plan.price_view}`);
                }
              } catch (error) {
                if (needsUser(error) || persistenceFailure(error)) throw error;
                allApplied = false;
                state.unapplied_filters.add(`报价类型=${plan.price_view}`);
              }
            }
            for (const filter of plan.filters) {
              if (now() >= deadline) break;
              const label = `${filter.control}:${filter.values?.join("/") ?? `${filter.min ?? ""}-${filter.max ?? ""}`}`;
              try {
                const result = await retryBrowserAction(
                  `应用筛选 ${filter.control}`,
                  () => adapter.applyFilter(filter),
                  adapter,
                );
                if (result?.applied) state.applied_filters.add(label);
                else {
                  allApplied = false;
                  state.unapplied_filters.add(label);
                }
              } catch {
                allApplied = false;
                state.unapplied_filters.add(label);
              }
            }
          }
          const effectiveMode = applyFilters && allApplied ? "filtered" : mode === "filtered" ? "keyword_only" : mode;
          if (effectiveMode !== "filtered") {
            lowerQuality(state, "degraded");
            state.fallback_modes.add(effectiveMode);
          }
          if (branch.keyword) {
            try {
              const searched = await retryBrowserAction(
                "提交关键词",
                () => adapter.search(branch.keyword),
                adapter,
              );
              if (!searched?.applied) state.unapplied_filters.add(`关键词=${branch.keyword}`);
            } catch (error) {
              if (needsUser(error) || persistenceFailure(error)) throw error;
              lowerQuality(state, "degraded");
              state.unapplied_filters.add(`关键词=${branch.keyword}`);
            }
          }
          state.phase = "collecting_list";
          for (let pageNumber = 1; pageNumber <= MAX_PAGES_PER_BRANCH; pageNumber += 1) {
            if (now() >= deadline || candidates.length >= poolTarget || state.completed_pages >= MAX_PAGES_TOTAL) {
              timedOut ||= now() >= deadline;
              break;
            }
            state.page_number = pageNumber;
            let usedGenericDom = false;
            let pageData;
            try {
              pageData = await retryBrowserAction(
                "读取达人列表",
                () => adapter.readPage(pageNumber),
                adapter,
                10_000,
              );
            } catch (error) {
              if (needsUser(error) || persistenceFailure(error)) throw error;
              state.error_code = error?.code ?? "YPSCAN_MANUAL_LIST_UNAVAILABLE";
              state.error_message = error?.message ?? String(error);
              lowerQuality(state, "unverified");
              pageData = { rows: [] };
            }
            if (!pageData?.rows?.length) {
              const rows = await bounded("读取可见达人卡片", genericVisibleRows(page), 6_000);
              pageData = { ...pageData, rows, source_url: page.url() };
              if (rows.length) {
                usedGenericDom = true;
                lowerQuality(state, "unverified");
                state.fallback_modes.add("generic_dom");
              }
            }
            const pageCollectionMode = usedGenericDom ? "generic_dom" : effectiveMode;
            const pageCandidates = (pageData?.rows ?? []).map((row) =>
              candidateFromRow(row, {
                platform: params.platform,
                branch_id: `${branch.branch_id}:${pageCollectionMode}`,
                page_number: pageNumber,
                price_tier: pageData.price_tier,
                source_url: pageData.source_url ?? page.url(),
                collection_mode: pageCollectionMode,
              }),
            );
            if (pageCandidates.length) {
              await store.savePage({
                branch: { ...branch, collection_mode: pageCollectionMode },
                page: {
                  page_number: pageNumber,
                  row_count: pageCandidates.length,
                  source_url: pageData.source_url ?? page.url(),
                  collection_mode: pageCollectionMode,
                },
                candidates: pageCandidates,
              });
              candidates = mergeManualCandidates([...candidates, ...pageCandidates]);
              state.completed_pages += 1;
              artifact = await materialize("running");
            }
            if (!pageCandidates.length) break;
            /** @type {any} */
            let next = false;
            try {
              next = await retryBrowserAction(
                "进入下一页",
                () => adapter.nextPage(),
                adapter,
              );
            } catch (error) {
              if (needsUser(error) || persistenceFailure(error)) throw error;
              state.unapplied_filters.add(`分页:${pageNumber + 1}`);
            }
            if (!(next === true || next?.advanced === true)) break;
          }
        };

        const collectSafely = async (branch, mode, applyFilters) => {
          try {
            await collect(branch, mode, applyFilters);
          } catch (error) {
            if (needsUser(error) || persistenceFailure(error)) throw error;
            state.error_code = error?.code ?? "YPSCAN_MANUAL_PAGE_UNAVAILABLE";
            state.error_message = error?.message ?? String(error);
            lowerQuality(state, "unverified");
            state.fallback_modes.add(`${mode}_failed`);
          }
        };

        for (const branch of plan.branches) {
          if (state.completed_branch_indexes.has(branch.branch_index)) continue;
          await collectSafely(branch, "filtered", true);
          if (candidates.length < poolTarget && now() < deadline) {
            await collectSafely(branch, "keyword_only", false);
          }
          state.completed_branch_indexes.add(branch.branch_index);
          state.completed_keywords.add(branch.keyword);
          const completed = { ...branch, collection: { status: "complete" } };
          branches.push(completed);
          await store.saveBranch(completed);
          if (candidates.length >= poolTarget || now() >= deadline) break;
        }

        if (candidates.length < poolTarget && now() < deadline) {
          await collectSafely(
            { branch_index: plan.branches.length, branch_id: "market-unfiltered", keyword: "" },
            "market_unfiltered",
            false,
          );
        }

        state.phase = "collecting_detail";
        const existingDetails = new Set(details.map((item) => item.candidate_ref));
        const detailCandidates = candidates
          .filter((candidate) => !existingDetails.has(candidateReference(candidate)))
          .slice(0, Math.max(MAX_DETAILS - state.detail_attempted, 0));
        for (const candidate of detailCandidates) {
          if (now() >= deadline) {
            timedOut = true;
            break;
          }
          state.detail_attempted += 1;
          try {
            const collected = await retryBrowserAction(
              "采集达人详情",
              () => adapter.collectDetail(candidate, { groups: detailGroupsForPlan(plan) }),
              adapter,
              10_000,
            );
            const evaluation = evaluateCandidateDetail(candidate, collected, plan);
            const detail = {
              ...collected,
              candidate_ref: candidateReference(candidate),
              fields: evaluation.fields,
              hard_evaluation: collected.status === "blocked" ? { ...evaluation, status: "unknown" } : evaluation,
            };
            details = mergeDetailRecords([...details, detail]);
            if (detail.status === "complete") state.detail_completed += 1;
            artifact = await store.saveDetail({
              detail,
              branches,
              candidates,
              details,
              reviews,
              status: "running",
              detailPlannedCount: Math.min(MAX_DETAILS, candidates.length),
              runInfo: createRunInfo(params, plan, state, now, candidates.length),
            });
          } catch (error) {
            if (needsUser(error)) throw error;
            state.unapplied_filters.add(`详情:${candidateReference(candidate)}`);
          }
        }

        timedOut ||= now() >= deadline;
        state.phase = "terminal";
        const status = candidates.length
          ? timedOut || state.error_code ? "partial" : "complete"
          : state.error_code
            ? "failed_with_artifact"
            : "empty";
        artifact = await materialize(status, true);
        return hostToolResult(publicPayload({ params, plan, store, state, candidates, details, reviews, status, artifact }));
      } catch (error) {
        state.error_code = error?.code ?? "YPSCAN_MANUAL_RESEARCH_FAILED";
        state.error_message = error?.message ?? String(error);
        lowerQuality(state, candidates.length ? "degraded" : "unverified");
        const status = needsUser(error) ? "needs_user_action" : candidates.length ? "partial" : "failed_with_artifact";
        state.phase = needsUser(error) ? "awaiting_user" : "terminal";
        state.resume_available = needsUser(error);
        state.resume_instruction = needsUser(error) ? "在专用浏览器完成登录或验证后原样调用 resume" : null;
        artifact = await materialize(status, true).catch(() => artifact);
        return hostToolResult(publicPayload({ params, plan, store, state, candidates, details, reviews, status, artifact }));
      } finally {
        await adapter?.dispose?.().catch(() => {});
        lock.release();
      }
    } catch (error) {
      const payload = {
        success: false,
        status: "failed",
        operation: rawParams.operation ?? null,
        requirement_id: rawParams.requirement_id ?? null,
        platform: rawParams.platform ?? null,
        error: {
          code: error?.code ?? "YPSCAN_MANUAL_RESEARCH_FAILED",
          message: error?.message ?? String(error),
        },
      };
      return hostToolResult(payload, { isError: true });
    }
  };
}

export const MANUAL_RESEARCH_RUNNER_LIMITS = Object.freeze({
  run_budget_ms: RUN_BUDGET_MS,
  persist_reserve_ms: PERSIST_RESERVE_MS,
  max_pages_per_branch: MAX_PAGES_PER_BRANCH,
  max_pages_total: MAX_PAGES_TOTAL,
  max_details: MAX_DETAILS,
});
