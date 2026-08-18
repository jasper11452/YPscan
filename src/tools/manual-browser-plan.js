import { createHash } from "node:crypto";

function actionId(branch, suffix) {
  return `${branch.branch_id}:${suffix}`;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

function requirementRef(prefix, value) {
  return `${prefix}:${fingerprint(value)}`;
}

export function browserRequirementsForPlan(plan) {
  const requirements = [];
  if (plan.price_view) {
    requirements.push({
      requirement_ref: requirementRef("view", {
        platform: plan.platform,
        price_view: plan.price_view,
      }),
      kind: "price_view",
      expected: plan.price_view,
      mode: "option",
    });
  }
  for (const filter of plan.filters ?? []) {
    requirements.push({
      requirement_ref: requirementRef("filter", filter),
      kind: filter.fact_kind ?? filter.control,
      expected:
        filter.mode === "range"
          ? { min: filter.min ?? null, max: filter.max ?? null, unit: filter.unit ?? null }
          : (filter.values ?? []),
      mode: filter.mode,
      fact_id: filter.fact_id ?? null,
      source: filter.source ?? null,
    });
  }
  return requirements;
}

export function branchInteractionPlan(plan, branch, selections = []) {
  const baseSelection = selections.find(
    (selection) => selection.protocol_version === 3 && selection.status === "ready",
  );
  return {
    branch,
    mode: baseSelection ? "keyword_only" : "establish_filter_set",
    keyword_must_be_last: true,
    preserve_filters: Boolean(baseSelection),
    filter_set_id: baseSelection?.filter_set_id ?? null,
    hard_requirements: browserRequirementsForPlan(plan),
    detail_requirements: plan.detail_filters ?? [],
    review_requirements: plan.review_requirements ?? [],
  };
}

/** Return the exact semantic actions allowed for one keyword branch. */
export function browserActionsForBranch(plan, branch) {
  const actions = [
    {
      plan_action_id: actionId(branch, "ensure_market_ready"),
      action: "ensure_market_ready",
    },
    {
      plan_action_id: actionId(branch, "reset_filters"),
      action: "reset_filters",
    },
  ];
  if (plan.price_view) {
    actions.push({
      plan_action_id: actionId(branch, "price_view"),
      action: "set_price_view",
      price_view: plan.price_view,
    });
  }
  for (const [index, filter] of plan.filters.entries()) {
    actions.push({
      plan_action_id: actionId(
        branch,
        `filter-${index + 1}-${filter.control}-${fingerprint(filter)}`,
      ),
      action: "apply_filter",
      filter,
    });
  }
  actions.push({
    plan_action_id: actionId(branch, "search_keyword"),
    action: "search_keyword",
    keyword: branch.keyword,
  });
  return actions;
}

export function findPlannedBrowserAction(plan, branchIndex, planActionId) {
  const branch = plan.branches[branchIndex];
  if (!branch) return null;
  return (
    browserActionsForBranch(plan, branch).find(
      (action) => action.plan_action_id === planActionId,
    ) ?? null
  );
}
