import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REGISTRY_PATH = fileURLToPath(
  new URL("./platform-cascade-routes.json", import.meta.url),
);

const rawRegistry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));

function clean(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function lookupKey(value) {
  return clean(value).toLocaleLowerCase("zh-CN");
}

function assertStringArray(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} 必须是${allowEmpty ? "" : "非空"}字符串数组`);
  }
  if (value.some((item) => !clean(item))) throw new Error(`${label} 不能包含空值`);
}

/** @param {any} registry */
export function validateCascadeRouteRegistry(registry) {
  if (!registry || registry.schema_version !== 1 || !registry.platforms) {
    throw new Error("级联路径 registry 版本或 platforms 无效");
  }
  for (const [platform, controls] of Object.entries(registry.platforms)) {
    if (!controls || typeof controls !== "object" || Array.isArray(controls)) {
      throw new Error(`${platform} 的 controls 无效`);
    }
    for (const [control, definition] of Object.entries(controls)) {
      if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
        throw new Error(`${platform}.${control} 的定义无效`);
      }
      assertStringArray(definition.field_labels, `${platform}.${control}.field_labels`);
      assertStringArray(definition.trigger_labels ?? [], `${platform}.${control}.trigger_labels`, {
        allowEmpty: true,
      });
      if (
        definition.root_as_trigger !== undefined &&
        typeof definition.root_as_trigger !== "boolean"
      ) {
        throw new Error(`${platform}.${control}.root_as_trigger 必须是布尔值`);
      }
      if (!Array.isArray(definition.routes)) {
        throw new Error(`${platform}.${control}.routes 必须是数组`);
      }
      const tokens = new Map();
      for (const [index, route] of definition.routes.entries()) {
        const prefix = `${platform}.${control}.routes[${index}]`;
        if (!clean(route?.value)) throw new Error(`${prefix}.value 不能为空`);
        assertStringArray(route.path, `${prefix}.path`);
        assertStringArray(route.aliases ?? [], `${prefix}.aliases`, { allowEmpty: true });
        for (const token of [route.value, ...(route.aliases ?? [])]) {
          const key = lookupKey(token);
          if (tokens.has(key)) {
            if (tokens.get(key) === route.value) continue;
            throw new Error(`${platform}.${control} 存在重复路径别名：${clean(token)}`);
          }
          tokens.set(key, route.value);
        }
      }
    }
  }
  return registry;
}

export const CASCADE_ROUTE_REGISTRY = validateCascadeRouteRegistry(rawRegistry);

function normalizedPlatform(value) {
  if (value === "douyin") return "xingtu";
  if (value === "xiaohongshu") return "pgy";
  return value;
}

/**
 * Resolve only exact, control-scoped aliases from the checked-in registry.
 * Missing values on dynamic fields remain live-page work.
 *
 * @param {string} platform
 * @param {string} control
 * @param {string} value
 */
export function resolveCascadeRoute(platform, control, value) {
  const definition = CASCADE_ROUTE_REGISTRY.platforms?.[normalizedPlatform(platform)]?.[control];
  if (!definition) return { status: "unsupported", route: null, definition: null };
  const wanted = lookupKey(value);
  const matches = definition.routes.filter((route) =>
    [route.value, ...(route.aliases ?? [])].some((token) => lookupKey(token) === wanted),
  );
  if (matches.length === 1) return { status: "exact", route: matches[0], definition };
  if (matches.length > 1) return { status: "ambiguous", route: null, definition };
  return {
    status: definition.dynamic_leafs === true ? "dynamic" : "missing",
    route: null,
    definition,
  };
}

const RUN_CODE_TEMPLATE = String.raw`await (async () => {
  const batch = __YPSCAN_CASCADE_BATCH__;
  const norm = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const hasReadback = (text, value) => {
    const escaped = norm(value).replace(/[.*+?^$(){}|[\]\\]/gu, "\\$&");
    return new RegExp("(?:^|[\\s,，、:：>→])" + escaped + "(?:$|[\\s,，、:：>→])", "u").test(norm(text));
  };
  const optionSelector = [
    "[role=option]", "[role=menuitem]", "label", "li", ".d-grid-item",
    ".el-cascader-node", ".ant-cascader-menu-item", ".semi-cascader-option",
    ".arco-cascader-option", ".xt-cascader-option", ".range-select-content__item",
    "[class*=option-item]"
  ].join(",");
  const columnSelector = [
    ".el-cascader-menu:visible", ".ant-cascader-menu:visible",
    ".semi-cascader-column:visible", ".arco-cascader-list:visible",
    ".d-new-cascader__column:visible", ".select-content-wrapper:visible",
    ".range-select-content__left:visible", ".range-select-content__middle:visible",
    ".range-select-content__right:visible", "[role=listbox]:visible", "[role=menu]:visible"
  ].join(",");
  const overlaySelector = [
    ".filter-select-popover:visible", ".el-popper:visible", ".el-dropdown-menu:visible",
    ".ant-popover:visible", ".xt-dropdown:visible", "[role=listbox]:visible",
    "[role=menu]:visible", "[class*=filter-popover]:visible"
  ].join(",");

  async function exactOption(root, value) {
    const options = root.locator(optionSelector);
    const count = await options.count().catch(() => 0);
    const matches = new Map();
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      if (!(await option.isVisible().catch(() => false))) continue;
      if (norm(await option.innerText().catch(() => "")) !== norm(value)) continue;
      const key = await option.evaluate((node, fallback) => {
        const rect = node.getBoundingClientRect();
        return [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height), fallback].join(":");
      }, index).catch(() => "node:" + index);
      if (!matches.has(key)) matches.set(key, option);
    }
    if (matches.size === 1) return matches.values().next().value;
    if (matches.size > 1) return null;
    const text = root.getByText(value, { exact: true }).filter({ visible: true });
    return (await text.count().catch(() => 0)) === 1 ? text.first() : null;
  }

  async function columns() {
    const locator = page.locator(columnSelector);
    const result = [];
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const column = locator.nth(index);
      if (!(await column.isVisible().catch(() => false))) continue;
      const box = await column.boundingBox().catch(() => null);
      const text = norm(await column.innerText().catch(() => ""));
      result.push({ column, index, box, key: String(index) + ":" + Math.round(box?.x ?? -1) + ":" + text });
    }
    return result;
  }

  async function openBatchMenu() {
    const directRequested = new Set([...batch.field_labels, ...batch.trigger_labels].map(norm));
    const requested = new Set([...directRequested, ...batch.items.map(item => item.path[0])].map(norm));
    const direct = page.locator(".custom-selector__button:visible");
    for (let index = 0; index < await direct.count().catch(() => 0); index += 1) {
      const trigger = direct.nth(index);
      if (!directRequested.has(norm(await trigger.innerText().catch(() => "")))) continue;
      await trigger.scrollIntoViewIfNeeded();
      await trigger.hover();
      await trigger.click();
      const controlled = await trigger.getAttribute("aria-controls").catch(() => null);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const menu = controlled ? page.locator("[id=" + JSON.stringify(controlled) + "]").first() : page.locator(overlaySelector).last();
        if (await menu.isVisible().catch(() => false)) return { row: trigger, trigger, menu };
        await page.waitForTimeout(75);
      }
    }
    const rows = page.locator(".market-filter-wrapper--line,[class*=filter-row],.common-filter-item");
    for (let index = 0; index < await rows.count().catch(() => 0); index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;
      const title = row.locator(".market-filter-wrapper-title,[class*=filter-title],.common-filter-item__label").first();
      if (!batch.field_labels.map(norm).includes(norm(await title.innerText().catch(() => "")))) continue;
      const controls = row.locator("[aria-controls]");
      const candidates = [];
      for (let controlIndex = 0; controlIndex < await controls.count().catch(() => 0); controlIndex += 1) {
        const control = controls.nth(controlIndex);
        if (!(await control.isVisible().catch(() => false))) continue;
        if (requested.has(norm(await control.innerText().catch(() => "")))) candidates.push(control);
      }
      if (candidates.length === 0 && (await controls.count().catch(() => 0)) === 1) candidates.push(controls.first());
      for (const trigger of candidates) {
        await trigger.scrollIntoViewIfNeeded();
        await trigger.hover();
        await trigger.click();
        const controlled = await trigger.getAttribute("aria-controls").catch(() => null);
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const menu = controlled ? page.locator("[id=" + JSON.stringify(controlled) + "]").first() : page.locator(overlaySelector).last();
          if (await menu.isVisible().catch(() => false)) return { row, trigger, menu };
          await page.waitForTimeout(75);
        }
      }
    }
    return null;
  }

  async function selectionState(option, allowActive = false) {
    return option.evaluate((node, activeAllowed) => {
      let current = node;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        if (current.getAttribute("aria-selected") === "true" || current.getAttribute("aria-checked") === "true") return true;
        if (/(?:^|\s)(?:is-checked|is-selected|checked|selected)(?:\s|$)/u.test(current.getAttribute("class") ?? "")) return true;
        if (activeAllowed && /(?:^|\s)--active(?:\s|$)/u.test(current.getAttribute("class") ?? "")) return true;
        const input = current.matches("input[type=checkbox],input[type=radio]") ? current : current.querySelector("input[type=checkbox],input[type=radio]");
        if (input?.matches(":checked")) return true;
      }
      return false;
    }, allowActive).catch(() => false);
  }

  async function nextColumn(value, parent, before) {
    const parentBox = await parent.boundingBox().catch(() => null);
    const controlledIds = await parent.evaluate(node => {
      let current = node;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        const ids = current.getAttribute("aria-controls") ?? current.getAttribute("aria-owns");
        if (ids) return ids.split(/\s+/u).filter(Boolean);
      }
      return [];
    }).catch(() => []);
    let stableKey = null;
    let stablePolls = 0;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      for (const id of controlledIds) {
        const controlled = page.locator("[id=" + JSON.stringify(id) + "]").first();
        if ((await controlled.isVisible().catch(() => false)) && await exactOption(controlled, value)) return controlled;
      }
      const candidates = [];
      for (const candidate of await columns()) {
        if (Number.isFinite(parentBox?.x) && Number.isFinite(candidate.box?.x) && candidate.box.x <= parentBox.x + 2) continue;
        if (before.has(candidate.key)) continue;
        if (await exactOption(candidate.column, value)) candidates.push(candidate);
      }
      candidates.sort((left, right) => (left.box?.x ?? left.index) - (right.box?.x ?? right.index));
      const candidate = candidates[0];
      if (candidate) {
        if (candidate.key === stableKey) stablePolls += 1;
        else { stableKey = candidate.key; stablePolls = 1; }
        if (stablePolls >= 3) return candidate.column;
      } else {
        stableKey = null;
        stablePolls = 0;
      }
      await page.waitForTimeout(75);
    }
    return null;
  }

  const opened = await openBatchMenu();
  if (!opened) return { status: "not_applied", selected_paths: [], unresolved_paths: batch.items.map(item => item.path), reason: "field_or_menu_not_found" };
  const beforeReadback = norm(await opened.row.innerText().catch(() => ""));
  const attempts = [];
  for (const item of batch.items) {
    const actionPath = batch.root_as_trigger ? item.path.slice(1) : item.path;
    if (actionPath.length === 0) {
      attempts.push({ item, committed: false, failed_at: item.path[0] });
      continue;
    }
    let root = opened.menu;
    const resolvedInitial = [];
    for (const candidate of await columns()) if (await exactOption(candidate.column, actionPath[0])) resolvedInitial.push(candidate);
    resolvedInitial.sort((left, right) => (left.box?.x ?? left.index) - (right.box?.x ?? right.index));
    if (resolvedInitial[0]) root = resolvedInitial[0].column;
    let committed = false;
    let failedAt = null;
    for (let depth = 0; depth < actionPath.length; depth += 1) {
      const part = actionPath[depth];
      const option = await exactOption(root, part);
      if (!option) { failedAt = part; break; }
      await option.scrollIntoViewIfNeeded();
      if (depth < actionPath.length - 1) {
        const before = new Set((await columns()).map(column => column.key));
        await option.hover();
        await page.waitForTimeout(300);
        let child = await nextColumn(actionPath[depth + 1], option, before);
        if (!child) {
          const suffix = option.locator(".xt-cascader-option__suffix,[class*=suffix],[class*=arrow]").first();
          if (await suffix.isVisible().catch(() => false)) {
            await suffix.hover().catch(() => {});
            await suffix.click().catch(() => {});
            child = await nextColumn(actionPath[depth + 1], option, before);
          }
        }
        if (!child) { failedAt = actionPath[depth + 1]; break; }
        root = child;
      } else {
        if (await selectionState(option, true)) committed = true;
        else {
          await option.hover();
          await page.waitForTimeout(180);
          await option.click();
          committed = await selectionState(option);
        }
      }
    }
    attempts.push({ item, committed, failed_at: failedAt });
  }
  const confirm = opened.menu.getByRole("button", { name: /^(?:确定|确认)$/u }).last();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  else await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  const afterReadback = norm(await opened.row.innerText().catch(() => ""));
  const selected = attempts.filter(attempt => attempt.committed || (
    afterReadback !== beforeReadback &&
    !hasReadback(beforeReadback, attempt.item.path.at(-1)) &&
    hasReadback(afterReadback, attempt.item.path.at(-1))
  ));
  const unresolved = attempts.filter(attempt => !selected.includes(attempt));
  return {
    status: selected.length === batch.items.length ? "applied" : selected.length ? "partial" : "not_applied",
    selected_paths: selected.map(attempt => attempt.item.path),
    unresolved_paths: unresolved.map(attempt => attempt.item.path),
    failures: unresolved.map(attempt => ({ path: attempt.item.path, failed_at: attempt.failed_at })),
    readback: { before: beforeReadback, after: afterReadback }
  };
})()`;

/** @param {Record<string, any>} batch */
export function renderCascadeBatchRunCode(batch) {
  const payload = {
    control: clean(batch.control),
    field_labels: batch.field_labels.map(clean),
    trigger_labels: batch.trigger_labels.map(clean),
    root_as_trigger: batch.root_as_trigger === true,
    items: batch.items.map((item) => ({
      fact_ids: item.fact_ids,
      value: clean(item.value),
      path: item.path.map(clean),
    })),
  };
  return RUN_CODE_TEMPLATE.replace("__YPSCAN_CASCADE_BATCH__", JSON.stringify(payload));
}

/**
 * @param {{platform: string, filters: any[]}} input
 */
export function compileCascadeSelectionPlan({ platform, filters }) {
  const grouped = new Map();
  const fallbacks = [];
  for (const filter of filters) {
    if (filter.mode !== "options" || !Array.isArray(filter.values)) continue;
    const definition = CASCADE_ROUTE_REGISTRY.platforms?.[normalizedPlatform(platform)]?.[
      filter.control
    ];
    if (!definition) continue;
    for (const value of filter.values) {
      const resolved = resolveCascadeRoute(platform, filter.control, value);
      if (resolved.status !== "exact") {
        fallbacks.push({
          fact_id: filter.fact_id ?? null,
          control: filter.control,
          value: clean(value),
          reason: resolved.status,
        });
        continue;
      }
      const rootTrigger = definition.root_as_trigger === true ? resolved.route.path[0] : null;
      const groupKey = `${filter.control}\u0000${clean(rootTrigger)}`;
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, {
          control: filter.control,
          field_labels: [...definition.field_labels],
          trigger_labels: rootTrigger
            ? [rootTrigger]
            : [...(definition.trigger_labels ?? [])],
          root_as_trigger: definition.root_as_trigger === true,
          strategy: "cascade_batch",
          items: [],
        });
      }
      const batch = grouped.get(groupKey);
      const pathKey = resolved.route.path.map(clean).join("\u0000");
      const existing = batch.items.find(
        (item) => item.path.map(clean).join("\u0000") === pathKey,
      );
      if (existing) {
        if (filter.fact_id && !existing.fact_ids.includes(filter.fact_id)) {
          existing.fact_ids.push(filter.fact_id);
        }
      } else {
        batch.items.push({
          fact_ids: filter.fact_id ? [filter.fact_id] : [],
          value: clean(value),
          path: [...resolved.route.path],
        });
      }
    }
  }
  const batches = [...grouped.values()].map((batch) => ({
    ...batch,
    playwright_run_code: renderCascadeBatchRunCode(batch),
  }));
  return { schema_version: 1, batches, fallbacks };
}
