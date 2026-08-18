import assert from "node:assert/strict";
import test from "node:test";

import {
  CASCADE_ROUTE_REGISTRY,
  compileCascadeSelectionPlan,
  renderCascadeBatchRunCode,
  resolveCascadeRoute,
  validateCascadeRouteRegistry,
} from "../src/tools/manual-research/cascade-route-plan.js";
import { compileManualResearchPlan } from "../src/tools/manual-research-plan.js";

function optionFilter(factId, control, values) {
  return { fact_id: factId, fact_kind: control, control, mode: "options", values };
}

function fact(id, kind, value) {
  return {
    id,
    kind,
    status: "present",
    disposition: "active",
    strength: "hard",
    normalized_value: value,
    source: { id: `source-${id}`, quote: String(value) },
  };
}

test("checked-in cascade registry is valid and rejects duplicate scoped aliases", () => {
  assert.equal(validateCascadeRouteRegistry(CASCADE_ROUTE_REGISTRY), CASCADE_ROUTE_REGISTRY);
  const invalid = structuredClone(CASCADE_ROUTE_REGISTRY);
  invalid.platforms.xingtu.creator_type.routes[1].aliases = ["美妆教程"];
  assert.throws(() => validateCascadeRouteRegistry(invalid), /重复路径别名/u);
});

test("stable Xingtu and PGY leaves resolve to exact visible paths", () => {
  assert.deepEqual(resolveCascadeRoute("douyin", "creator_type", "护肤保养").route.path, [
    "美妆",
    "护肤保养",
  ]);
  assert.deepEqual(resolveCascadeRoute("xingtu", "content_theme", "AI 应用").route.path, [
    "手机/数码/家电分享",
    "AI应用",
  ]);
  assert.deepEqual(resolveCascadeRoute("xiaohongshu", "creator_persona", "程序员").route.path, [
    "职业身份",
    "互联网",
    "程序员",
  ]);
  assert.deepEqual(resolveCascadeRoute("pgy", "content_theme", "长途自驾").route.path, [
    "汽车",
    "用车场景",
    "远行近游",
    "长途自驾",
  ]);
});

test("same-field routes are deduplicated into one executable batch", () => {
  const plan = compileCascadeSelectionPlan({
    platform: "xingtu",
    filters: [
      optionFilter("type-1", "creator_type", ["美妆教程", "护肤保养"]),
      optionFilter("type-2", "creator_type", ["美妆教程"]),
    ],
  });

  assert.equal(plan.batches.length, 1);
  assert.equal(plan.batches[0].strategy, "cascade_batch");
  assert.deepEqual(
    plan.batches[0].items.map((item) => item.path),
    [
      ["美妆", "美妆教程"],
      ["美妆", "护肤保养"],
    ],
  );
  assert.deepEqual(plan.batches[0].items[0].fact_ids, ["type-1", "type-2"]);
  assert.match(plan.batches[0].playwright_run_code, /selected_paths/u);
  assert.equal((plan.batches[0].playwright_run_code.match(/name: \/\^\(\?:确定\|确认\)\$\/u/gu) ?? []).length, 1);
});

test("Xingtu paths under different first-level triggers become separate menu batches", () => {
  const plan = compileCascadeSelectionPlan({
    platform: "xingtu",
    filters: [optionFilter("mixed", "creator_type", ["美妆教程", "穿搭"])],
  });

  assert.deepEqual(
    plan.batches.map((batch) => batch.trigger_labels),
    [["美妆"], ["时尚"]],
  );
  assert.equal(plan.batches.every((batch) => batch.root_as_trigger === true), true);
});

test("dynamic and missing leaves remain explicit live-page fallbacks", () => {
  const plan = compileCascadeSelectionPlan({
    platform: "pgy",
    filters: [
      optionFilter("city", "creator_city", ["深圳"]),
      optionFilter("theme", "content_theme", ["当前运营人群"]),
    ],
  });

  assert.deepEqual(
    plan.fallbacks.map((item) => [item.control, item.reason]),
    [
      ["creator_city", "dynamic"],
      ["content_theme", "missing"],
    ],
  );
  assert.equal(plan.batches.length, 0);
});

test("content taxonomy becomes a list filter without replacing semantic review", () => {
  const plan = compileManualResearchPlan({
    platform: "xingtu",
    facts: [fact("theme", "content_theme", "AI应用")],
    keywords: ["办公软件"],
  });

  assert.deepEqual(plan.filters[0].values, ["AI应用"]);
  assert.equal(plan.filters[0].control, "content_theme");
  assert.equal(plan.review_requirements[0].fact_id, "theme");
  assert.deepEqual(plan.selection_plan.batches[0].items[0].path, [
    "手机/数码/家电分享",
    "AI应用",
  ]);
});

test("run-code payload JSON-escapes untrusted visible labels", () => {
  const code = renderCascadeBatchRunCode({
    control: "creator_type",
    field_labels: ["达人类型"],
    trigger_labels: [],
    items: [
      {
        fact_ids: ["unsafe"],
        value: '"; globalThis.__injected = true; //',
        path: ["美妆", '"; globalThis.__injected = true; //'],
      },
    ],
  });

  assert.equal(code.includes("\\" + '"; globalThis.__injected = true; //'), true);
  assert.doesNotMatch(code, /path:\s*\["美妆", "";/u);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction("page", code));
});
