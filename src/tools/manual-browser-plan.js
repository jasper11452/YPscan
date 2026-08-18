import { createHash } from "node:crypto";

function actionId(branch, suffix) {
  return `${branch.branch_id}:${suffix}`;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
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
