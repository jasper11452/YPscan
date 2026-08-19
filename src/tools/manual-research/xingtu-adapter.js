import {
  assertUsablePage,
  assertMarketReady,
  clickFirstVisible,
  clickOptional,
  cleanText,
  dismissOrdinaryPopups,
  firstResultIdentity,
  fillMenuRange,
  hasResultRefreshEvidence,
  hoverOptional,
  openFilterMenu,
  platformRangeValue,
  readPlatformResults,
  selectMenuValues,
  settleAfterAction,
  installDialogAutoDismiss,
  waitForControlledMenu,
  waitForResultRefresh,
} from "./common.js";
import { captureListResponseDuring, mergeCapturedAndDomRows } from "./list-response-capture.js";
import { collectCreatorDetail } from "./detail-page.js";

const PRICE_TYPE_TRIGGER_LABEL = "选择报价类型";
const PRICE_VIEW_LABEL_PATTERN = /^(?:植入视频|定制视频)(?:报价)?$/u;

function normalizePriceView(value) {
  return cleanText(value).replace(/报价$/u, "");
}

function priceViewAliases(value) {
  const normalized = normalizePriceView(value);
  return [...new Set([normalized, `${normalized}报价`].filter(Boolean))];
}

async function readPriceViewHeader(page) {
  return cleanText(
    await page
      .locator(".base-author-list .section-wrapper.sticky-header")
      .innerText()
      .catch(() => ""),
  );
}

async function controlGroupText(control) {
  if (typeof control.evaluate !== "function") return "";
  return control
    .evaluate((node) => {
      const group = node.closest(
        ".price-group-item,.filters-item,.filter-item,[class*=price-group],[class*=filter-item]",
      );
      return group?.innerText ?? "";
    })
    .then(cleanText)
    .catch(() => "");
}

function menuPath(value) {
  return String(value)
    .split(/\s*(?:>|\/|→)\s*/u)
    .filter(Boolean);
}

function valueTriggerLabels(values) {
  return values.map((value) => menuPath(value)[0]).filter(Boolean);
}

function valuesForOpenedTrigger(values, triggerText) {
  const normalizedTrigger = cleanText(triggerText);
  return values.map((value) => {
    const path = menuPath(value);
    return path.length > 1 && cleanText(path[0]) === normalizedTrigger
      ? path.slice(1).join(" > ")
      : value;
  });
}

async function stableFilterReadback(opened) {
  const triggerText = cleanText(await opened.trigger?.innerText().catch(() => ""));
  const initialTriggerText = cleanText(opened.trigger_text);
  if (triggerText && triggerText !== initialTriggerText) return triggerText;
  return cleanText(await opened.row.innerText().catch(() => ""));
}

function expectedFilterReadback(filter) {
  const stableReadback = cleanText(filter.verification_readback);
  if (stableReadback) return stableReadback;
  const legacyReadback = cleanText(filter.readback);
  if (filter.control !== "creator_price") return legacyReadback;
  return legacyReadback.match(/达人报价(?:·\d+)?/u)?.[0] ?? legacyReadback;
}

async function readAppliedRange(page, filter) {
  const control = FILTER_CONTROLS[filter.control];
  if (!control) return { valid: false, reason: "platform_filter_not_supported" };
  const opened = await openFilterMenu(page, control.rows, {
    triggerLabels: control.valueTrigger
      ? valueTriggerLabels(filter.values ?? [])
      : control.triggers,
    optionValues: control.valueTrigger ? (filter.values ?? []) : [],
  });
  if (!opened) return { valid: false, reason: "filter_row_not_found" };
  let rangeMenu = opened;
  if (filter.control === "creator_price") {
    const interval = await findPriceRangeMenu(page, opened.menu);
    if (!interval) return { valid: false, reason: "price_range_trigger_not_found" };
    rangeMenu = { ...opened, menu: interval.menu, menu_id: interval.menu_id };
  }
  const custom = rangeMenu.menu.getByText(/^(?:自定义|自定义区间)$/u).first();
  if (await custom.isVisible().catch(() => false)) {
    if (!(await clickOptional(custom))) return { valid: false, reason: "custom_range_not_opened" };
    await page.waitForTimeout(180);
  }
  const inputs = rangeMenu.menu.locator("input:visible:not([readonly]):not([disabled])");
  const count = await inputs.count().catch(() => 0);
  if (!count || count > 2) return { valid: false, reason: "range_inputs_not_found" };
  const displayText = cleanText(await rangeMenu.menu.innerText().catch(() => ""));
  const requested = count === 1 ? [filter.max ?? filter.min] : [filter.min, filter.max];
  const readback = [];
  const expected = [];
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    const placeholder = (await input.getAttribute("placeholder").catch(() => "")) ?? "";
    expected.push(
      platformRangeValue(requested[index], {
        unit: filter.unit,
        placeholder,
        displayText,
      }) ?? "",
    );
    readback.push(cleanText(await input.inputValue().catch(() => "")).replace(/,/gu, ""));
  }
  await page.keyboard.press("Escape").catch(() => {});
  if (filter.control === "creator_price") await page.keyboard.press("Escape").catch(() => {});
  const normalizedExpected = expected.map((value) => value.replace(/,/gu, ""));
  return {
    valid: readback.every((value, index) => value === normalizedExpected[index]),
    expected: normalizedExpected,
    readback,
  };
}

/** @param {import("playwright-core").Locator} menu */
async function findPriceTypeMenu(page, menu) {
  const controls = menu.locator("[aria-controls]");
  const count = await controls.count();
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    const labels = [cleanText(await control.innerText().catch(() => ""))];
    for (const attribute of ["aria-label", "title", "placeholder"]) {
      labels.push(cleanText((await control.getAttribute(attribute).catch(() => "")) ?? ""));
    }
    const labelMatches = labels.some(
      (label) =>
        label.includes(PRICE_TYPE_TRIGGER_LABEL) ||
        PRICE_VIEW_LABEL_PATTERN.test(label) ||
        label === "全部",
    );
    if (!labelMatches) continue;
    if (!(await hoverOptional(control))) continue;
    if (!(await clickOptional(control))) continue;
    const resolved = await waitForControlledMenu(page, control);
    if (!resolved) continue;
    const options = cleanText(await resolved.menu.innerText().catch(() => ""));
    if (/植入视频/u.test(options) && /定制视频/u.test(options)) {
      return { trigger: control, menu: resolved.menu, menu_id: resolved.menu_id };
    }
    await page.keyboard.press("Escape").catch(() => {});
  }
  return null;
}

/**
 * Identify the quote interval control by the controlled menu's capabilities,
 * never by DOM position. The interval menu must expose either a custom-range
 * entry or editable numeric inputs and must not be the quote-type menu.
 */
async function findPriceRangeMenu(page, menu) {
  const controls = menu.locator("[aria-controls]");
  const count = await controls.count();
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    const controlText = cleanText(await control.innerText().catch(() => ""));
    const groupText = await controlGroupText(control);
    candidates.push({
      control,
      controlText,
      priority: /报价区间|价格区间|自定义/u.test(`${groupText} ${controlText}`) ? 0 : 1,
    });
  }
  candidates.sort((left, right) => left.priority - right.priority);
  for (const { control, controlText } of candidates) {
    if (!(await hoverOptional(control))) continue;
    if (!(await clickOptional(control))) continue;
    const resolved = await waitForControlledMenu(page, control);
    if (!resolved) continue;
    const text = cleanText(await resolved.menu.innerText().catch(() => ""));
    const isPriceType = /植入视频/u.test(text) && /定制视频/u.test(text);
    const inputs = resolved.menu.locator("input:visible:not([readonly]):not([disabled])");
    const inputCount = typeof inputs.count === "function" ? await inputs.count().catch(() => 0) : 0;
    const hasCustomRange = /自定义(?:区间)?/u.test(text);
    const groupText = await controlGroupText(control);
    const labeledRange = /报价区间|价格区间|自定义/u.test(`${groupText} ${controlText}`);
    if (!isPriceType && (hasCustomRange || inputCount > 0 || labeledRange)) {
      return { trigger: control, menu: resolved.menu, menu_id: resolved.menu_id };
    }
    await page.keyboard.press("Escape").catch(() => {});
  }
  return null;
}

const FILTER_CONTROLS = Object.freeze({
  creator_category: { rows: ["适配行业"], triggers: ["不限"] },
  creator_type: { rows: ["达人类型"], valueTrigger: true },
  creator_persona: { rows: ["达人人设"], valueTrigger: true },
  creator_gender: { rows: ["背景信息"], triggers: ["达人性别"] },
  creator_city: { rows: ["背景信息"], triggers: ["所在地域"] },
  follower_count: { rows: ["受众画像"], triggers: ["粉丝数量"] },
  audience_gender: { rows: ["受众画像"], triggers: ["粉丝画像"] },
  audience_city: { rows: ["受众画像"], triggers: ["粉丝画像"] },
  audience_female_rate: { rows: ["受众画像"], triggers: ["粉丝画像"] },
  audience_male_rate: { rows: ["受众画像"], triggers: ["粉丝画像"] },
  audience_age_18_23_rate: { rows: ["受众画像"], triggers: ["粉丝画像"] },
  audience_age_24_30_rate: { rows: ["受众画像"], triggers: ["粉丝画像"] },
  audience_age_31_40_rate: { rows: ["受众画像"], triggers: ["粉丝画像"] },
  creator_price: { rows: ["合作数据"], triggers: ["达人报价"] },
  cpm: { rows: ["合作数据"], triggers: ["预期CPM"] },
  cpe: { rows: ["合作数据"], triggers: ["预期CPE"] },
  interaction_rate: { rows: ["合作数据"], triggers: ["互动率"] },
});

/** @param {import("playwright-core").Page} page */
async function hydrateXingtuRows(page) {
  const cells = page
    .locator(".base-author-list .section-wrapper:not(.sticky-header) .content-column")
    .first()
    .locator(":scope > .content-cell");
  const count = await cells.count();
  for (let index = 0; index < count; index += 3) {
    await cells.nth(index).scrollIntoViewIfNeeded();
    await page.waitForTimeout(50);
  }
  if (count > 0) {
    await cells.nth(count - 1).scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
  }
}

/** @param {import("playwright-core").Page} page */
async function resetXingtuFilters(page) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const active = page
      .locator(
        ".market-filter-wrapper--line [aria-controls].active:visible,.market-filter-wrapper--line [aria-controls].selected-label:visible",
      )
      .first();
    if (!(await active.isVisible().catch(() => false))) break;
    await active.click();
    const resolved = await waitForControlledMenu(page, active);
    if (!resolved) break;
    const menu = resolved.menu;
    const reset = menu.getByRole("button", { name: /^重置$/u }).first();
    if (!(await clickOptional(reset))) {
      const all = menu
        .getByText(/^(?:全部|不限)$/u)
        .filter({ visible: true })
        .first();
      if (!(await all.isVisible().catch(() => false))) break;
      await all.click();
    }
    const confirm = menu.getByRole("button", { name: /^(?:确定|确认)$/u }).last();
    await clickOptional(confirm);
    await settleAfterAction(page);
  }
}

/** @param {import("playwright-core").Page} page */
export function createXingtuAdapter(page, { now = Date.now } = {}) {
  let capturedPage = null;
  let releaseDialogHandler = null;
  const learnedDetailPaths = new Set();
  return {
    async prepare() {
      await assertMarketReady(page, "xingtu");
      releaseDialogHandler ??= installDialogAutoDismiss(page);
      await dismissOrdinaryPopups(page, "xingtu");
      await assertMarketReady(page, "xingtu");
    },
    async reset() {
      await assertUsablePage(page, "xingtu");
      await dismissOrdinaryPopups(page, "xingtu");
      capturedPage = null;
      await page.keyboard.press("Escape").catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await resetXingtuFilters(page);
      const reset = page.getByRole("button", { name: /^(?:重置|清空)$/u }).first();
      await clickOptional(reset);
      const input = page.getByPlaceholder(/按内容关键词找达人|内容关键词/u).first();
      if (await input.isVisible().catch(() => false)) await input.fill("");
      await settleAfterAction(page);
    },
    async verifyBaseline() {
      const active = page.locator(
        ".market-filter-wrapper--line [aria-controls].active:visible,.market-filter-wrapper--line [aria-controls].selected-label:visible",
      );
      const keyword = cleanText(
        await page
          .getByPlaceholder(/按内容关键词找达人|内容关键词/u)
          .first()
          .inputValue()
          .catch(() => ""),
      );
      const activeCount = await active.count().catch(() => 0);
      return { valid: activeCount === 0 && !keyword, active_count: activeCount, keyword };
    },
    async recover() {
      await assertUsablePage(page, "xingtu");
      const dismissed = await dismissOrdinaryPopups(page, "xingtu");
      await page.keyboard.press("Escape").catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await page.mouse.move(8, 8).catch(() => {});
      await page.mouse.down().catch(() => {});
      await page.mouse.up().catch(() => {});
      await settleAfterAction(page);
      return { dismissed };
    },
    async dispose() {
      releaseDialogHandler?.();
      releaseDialogHandler = null;
    },
    async applyFilter(filter) {
      await assertUsablePage(page, "xingtu");
      const control = FILTER_CONTROLS[filter.control];
      if (!control) return { applied: false, reason: "platform_filter_not_supported" };
      const opened = await openFilterMenu(page, control.rows, {
        triggerLabels: control.valueTrigger ? valueTriggerLabels(filter.values) : control.triggers,
        optionValues: control.valueTrigger ? filter.values : [],
      });
      if (!opened) return { applied: false, reason: "filter_row_not_found" };
      const effectiveFilter =
        filter.control === "follower_count" && filter.mode === "range" && filter.max === null
          ? { ...filter, max: 50_000_000 }
          : filter;
      let rangeMenu = opened;
      if (filter.control === "creator_price") {
        const interval = await findPriceRangeMenu(page, opened.menu);
        if (!interval) {
          return {
            applied: false,
            reason: "price_range_trigger_not_found",
            menu_id: opened.menu_id,
            readback: cleanText(await opened.row.innerText().catch(() => "")),
          };
        }
        rangeMenu = { ...opened, menu: interval.menu, menu_id: interval.menu_id };
      }
      const optionValues = opened.trigger_matches_option
        ? ["全选"]
        : control.valueTrigger
          ? valuesForOpenedTrigger(filter.values, opened.trigger_text)
          : filter.values;
      let applied =
        filter.mode === "range"
          ? await fillMenuRange(page, rangeMenu, effectiveFilter, { requireConfirm: true })
          : (await selectMenuValues(page, opened, optionValues)).length > 0;
      if (filter.control === "creator_price" && applied) {
        const confirm = opened.menu.getByRole("button", { name: /^(?:确定|确认)$/u }).last();
        applied = await clickOptional(confirm);
      }
      await settleAfterAction(page);
      return {
        applied,
        reason:
          applied || filter.control !== "creator_price"
            ? applied
              ? null
              : "filter_value_not_found"
            : "price_range_not_committed",
        menu_id: opened.menu_id,
        ...(filter.mode === "range"
          ? { applied_range: { min: effectiveFilter.min, max: effectiveFilter.max } }
          : {}),
        readback: cleanText(await opened.row.innerText().catch(() => "")),
        verification_readback: await stableFilterReadback(opened),
      };
    },
    async setPriceView(priceView) {
      await assertUsablePage(page, "xingtu");
      if (!priceView) return { applied: true, readback: null };
      const opened = await openFilterMenu(page, ["合作数据"], {
        triggerLabels: ["达人报价"],
      });
      if (!opened) {
        return { applied: false, reason: "price_view_trigger_not_found" };
      }
      const priceType = await findPriceTypeMenu(page, opened.menu);
      if (!priceType) {
        return { applied: false, reason: "price_type_trigger_not_found" };
      }
      let selected = false;
      for (const alias of priceViewAliases(priceView)) {
        const values = await selectMenuValues(
          page,
          { menu: priceType.menu, row: priceType.trigger, trigger: priceType.trigger },
          [alias],
          { close: false },
        );
        if (values.length) {
          selected = true;
          break;
        }
      }
      const confirm = opened.menu.getByRole("button", { name: /^(?:确定|确认)$/u }).last();
      await clickOptional(confirm);
      await settleAfterAction(page);
      const header = await readPriceViewHeader(page);
      const applied = header.includes(normalizePriceView(priceView));
      return {
        applied,
        reason: applied
          ? null
          : selected
            ? "price_view_readback_mismatch"
            : "price_view_option_not_found",
        readback: header,
      };
    },
    async verifySelection(selection) {
      await assertUsablePage(page, "xingtu");
      const keywordInput = page.getByPlaceholder(/按内容关键词找达人|内容关键词/u).first();
      const keywordValue = cleanText(await keywordInput.inputValue().catch(() => ""));
      const requestedKeyword = cleanText(selection?.branch?.keyword);
      const header = await readPriceViewHeader(page);
      const requestedPrice = normalizePriceView(selection?.verification?.price_view?.requested);
      const body = cleanText(
        await page
          .locator("body")
          .innerText()
          .catch(() => ""),
      );
      const filters = [];
      for (const filter of selection?.verification?.actual_filters ?? []) {
        if (filter.mode === "range") {
          filters.push({ control: filter.control, ...(await readAppliedRange(page, filter)) });
          continue;
        }
        const readback = expectedFilterReadback(filter);
        filters.push({
          control: filter.control,
          valid: Boolean(readback) && body.includes(readback),
        });
      }
      const keywordValid = keywordValue === requestedKeyword;
      const priceViewValid = !requestedPrice || header.includes(requestedPrice);
      return {
        valid: keywordValid && priceViewValid && filters.every((filter) => filter.valid),
        keyword: { requested: requestedKeyword, readback: keywordValue, valid: keywordValid },
        price_view: { requested: requestedPrice, readback: header, valid: priceViewValid },
        filters,
      };
    },
    async search(keyword) {
      await assertUsablePage(page, "xingtu");
      const input = page.getByPlaceholder(/按内容关键词找达人|内容关键词/u).first();
      if (!(await input.isVisible().catch(() => false))) {
        return { applied: false, reason: "keyword_input_not_found" };
      }
      const before = await firstResultIdentity(page, "xingtu");
      capturedPage = null;
      const observed = await captureListResponseDuring(page, "xingtu", async () => {
        await input.fill(keyword);
        await input.press("Enter");
        return waitForResultRefresh(page, "xingtu", before, {
          requireIdentityChange: Boolean(before),
        });
      });
      capturedPage = observed.capture;
      const result = observed.action_result;
      return {
        applied: hasResultRefreshEvidence(result, capturedPage),
        reason: hasResultRefreshEvidence(result, capturedPage)
          ? null
          : "result_refresh_not_observed",
        result_count: capturedPage?.total ?? result.result_count,
        result_evidence: capturedPage
          ? { ready: true, source: "browser_response", result_count: capturedPage.total ?? null }
          : { ...result, source: "dom" },
        collection_source: capturedPage ? "browser_response" : "dom",
      };
    },
    listSnapshot() {
      if (!capturedPage?.rows?.length) return null;
      return {
        rows: capturedPage.rows,
        total: capturedPage.total ?? null,
        page_number: 1,
        endpoint: capturedPage.endpoint ?? null,
        response_path: capturedPage.response_path ?? null,
        captured_at: new Date(now()).toISOString(),
      };
    },
    async readPage(pageNumber, initialSnapshot = null) {
      await assertUsablePage(page, "xingtu");
      await hydrateXingtuRows(page);
      const result = await readPlatformResults(page, "xingtu");
      const captured = capturedPage ?? (pageNumber === 1 ? initialSnapshot : null);
      return {
        page_number: pageNumber,
        price_tier: result.price_tier ?? null,
        source_url: result.url,
        rows: mergeCapturedAndDomRows(captured?.rows, result.rows),
        collection_source: captured ? "browser_response+dom" : "dom",
        response_endpoint: captured?.endpoint ?? null,
        response_path: captured?.response_path ?? null,
      };
    },
    async nextPage() {
      await assertUsablePage(page, "xingtu");
      const next = page
        .locator(".el-pagination .btn-next,[aria-label='下一页'],button.next")
        .first();
      if (!(await next.isVisible().catch(() => false))) return false;
      if (
        (await next.isDisabled().catch(() => false)) ||
        (await next.getAttribute("aria-disabled")) === "true"
      ) {
        return false;
      }
      const before = await firstResultIdentity(page, "xingtu");
      capturedPage = null;
      const observed = await captureListResponseDuring(page, "xingtu", async () => {
        await next.scrollIntoViewIfNeeded();
        await next.hover();
        await next.click();
        return waitForResultRefresh(page, "xingtu", before, { requireIdentityChange: true });
      });
      capturedPage = observed.capture;
      const advanced = hasResultRefreshEvidence(observed.action_result, capturedPage);
      return {
        advanced,
        reason: advanced ? null : "result_refresh_not_observed",
      };
    },
    async collectDetail(candidate, { groups }) {
      return collectCreatorDetail(page, "xingtu", candidate, {
        groups,
        learnedPaths: learnedDetailPaths,
        capturedAt: new Date(now()).toISOString(),
      });
    },
    async paceDetail() {
      await page.waitForTimeout(2_000);
    },
    async export() {
      await assertUsablePage(page, "xingtu");
      const before = await page
        .locator("a[href]")
        .evaluateAll((links) =>
          links
            .map((link) => /** @type {HTMLAnchorElement} */ (link).href)
            .filter((href) => /lark|feishu|sheets|bytedance/iu.test(href)),
        );
      const clicked = await clickFirstVisible(page, [
        "button:has-text('导出')",
        "[role=button]:has-text('导出')",
      ]);
      if (!clicked) return { status: "failed", reason: "export_button_not_found" };
      const confirm = page.getByRole("button", { name: /^(?:确定|确认)$/u }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      const started = Date.now();
      while (Date.now() - started < 40_000) {
        const links = await page
          .locator("a[href]")
          .evaluateAll((items) =>
            items
              .map((link) => /** @type {HTMLAnchorElement} */ (link).href)
              .filter((href) => /lark|feishu|sheets|bytedance/iu.test(href)),
          );
        const fresh = links.find((href) => !before.includes(href));
        if (fresh) return { status: "complete", kind: "lark_sheet", url: fresh };
        await page.waitForTimeout(500);
      }
      return { status: "pending", kind: "lark_sheet", reason: "fresh_link_not_observed" };
    },
  };
}
