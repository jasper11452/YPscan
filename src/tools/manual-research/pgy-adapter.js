import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertUsablePage,
  assertMarketReady,
  clickOptional,
  cleanText,
  dismissOrdinaryPopups,
  firstResultIdentity,
  fillMenuRange,
  hasResultRefreshEvidence,
  openFilterMenu,
  readResultCount,
  readPlatformResults,
  selectMenuValues,
  settleAfterAction,
  installDialogAutoDismiss,
  waitForResultRefresh,
} from "./common.js";
import { captureListResponseDuring, mergeCapturedAndDomRows } from "./list-response-capture.js";
import { collectCreatorDetail } from "./detail-page.js";

const FILTER_ROWS = Object.freeze({
  creator_category: ["博主类目", "内容分类", "博主分类"],
  creator_type: ["博主类型", "博主类目"],
  creator_persona: ["博主人设", "人设"],
  content_format: ["笔记类型"],
  creator_gender: ["博主性别", "性别"],
  creator_city: ["博主地域", "常驻地", "地域"],
  follower_count: ["粉丝量", "粉丝数"],
  audience_gender: ["粉丝性别", "粉丝画像"],
  audience_city: ["粉丝地域", "粉丝画像"],
  audience_female_rate: ["女粉占比", "女性占比", "粉丝性别", "粉丝画像"],
  audience_male_rate: ["男粉占比", "男性占比", "粉丝性别", "粉丝画像"],
  audience_age_18_23_rate: ["18-23岁", "粉丝年龄", "粉丝画像"],
  audience_age_24_30_rate: ["24-30岁", "粉丝年龄", "粉丝画像"],
  audience_age_31_40_rate: ["31-40岁", "粉丝年龄", "粉丝画像"],
  creator_price: ["合作报价", "报价"],
  cpm: ["CPM", "预估CPM"],
  cpe: ["CPE", "预估互动单价"],
  interaction_rate: ["互动率"],
});

const NESTED_RANGE_CONTROLS = new Set(["creator_price", "cpm", "cpe"]);

function rangeView(qualifier, fallback) {
  const normalized = cleanText(qualifier).toLowerCase();
  if (["picture", "image", "图文"].includes(normalized)) return "图文";
  if (["video", "视频"].includes(normalized)) return "视频";
  return ["图文", "视频"].includes(fallback) ? fallback : null;
}

/** Resolve the first-level item that opens one PGY nested range menu. */
export function pgyNestedRangeConfig(filter, selectedPriceView) {
  if (!NESTED_RANGE_CONTROLS.has(filter?.control)) return null;
  const view =
    filter.control === "creator_price"
      ? rangeView(null, selectedPriceView)
      : rangeView(filter.qualifier, selectedPriceView);
  if (!view) return null;
  const opposite = view === "图文" ? "视频" : "图文";
  const labels = {
    creator_price: (value) => `${value}笔记`,
    cpm: (value) => `预估${value}CPM`,
    cpe: (value) => `预估${value}互动单价`,
  };
  return {
    item_label: labels[filter.control](view),
    opposite_item_label: labels[filter.control](opposite),
  };
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** @param {import("playwright-core").Page} page */
async function waitForAdditionalFilterMenu(page, previousCount) {
  const started = Date.now();
  let stableKey = null;
  let stablePolls = 0;
  while (Date.now() - started < 2_500) {
    const visibleMenus = page.locator(".filter-select-popover:visible");
    const rangeMenu = visibleMenus.last();
    if (
      (await visibleMenus.count().catch(() => 0)) > previousCount &&
      (await rangeMenu.isVisible().catch(() => false))
    ) {
      const text = cleanText(await rangeMenu.innerText().catch(() => ""));
      const key = `${await visibleMenus.count().catch(() => 0)}:${text}`;
      if (key === stableKey) stablePolls += 1;
      else {
        stableKey = key;
        stablePolls = 1;
      }
      if (stablePolls >= 3) return rangeMenu;
    } else {
      stableKey = null;
      stablePolls = 0;
    }
    await page.waitForTimeout(75);
  }
  return null;
}

/** Apply one PGY nested range and commit both the inner and outer menus. */
export async function fillPgyNestedRangeMenu(page, opened, filter, itemLabel) {
  const formatItem = opened.menu
    .locator(".filters-item")
    .filter({ hasText: new RegExp(`^\\s*${escapePattern(itemLabel)}`, "u") })
    .first();
  const input = formatItem.locator("input[readonly]:visible").first();
  if (!(await input.isVisible().catch(() => false))) {
    return { applied: false, reason: "nested_range_input_not_found" };
  }
  const menuCountBefore = await page.locator(".filter-select-popover:visible").count();
  await input.click();
  const rangeMenu = await waitForAdditionalFilterMenu(page, menuCountBefore);
  if (!rangeMenu) return { applied: false, reason: "nested_range_menu_not_found" };
  const applied = await fillMenuRange(page, { menu: rangeMenu }, filter, {
    requireConfirm: true,
  });
  if (!applied) return { applied: false, reason: "nested_range_input_not_applied" };
  const confirm = opened.menu.getByRole("button", { name: /^(?:确定|确认)$/u }).last();
  if (!(await clickOptional(confirm))) {
    return { applied: false, reason: "nested_range_outer_confirm_not_found" };
  }
  return { applied: true, reason: null };
}

async function waitForPgyTableReady(page) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const skeleton = await page
      .locator("tbody .skeleton-block:visible")
      .first()
      .isVisible()
      .catch(() => false);
    const result = await readPlatformResults(page, "pgy").catch(() => ({ rows: [] }));
    const body = cleanText(
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    if (!skeleton && (result.rows.length > 0 || /暂无数据|暂无结果|未找到|没有符合/u.test(body))) {
      return result;
    }
    await page.waitForTimeout(250);
  }
  return readPlatformResults(page, "pgy");
}

async function appliedFilterSummary(page, label) {
  const body = cleanText(
    await page
      .locator("body")
      .innerText()
      .catch(() => ""),
  );
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    body.match(new RegExp(`${escaped}：\\s*(.+?)\\s+(?:重置|存为常用筛选|推荐)`, "u"))?.[1] ?? null
  );
}

function nativeDownloadWaiter(page, timeoutMs) {
  let settled = false;
  let rejectWaiter;
  let timer;
  const finish = () => {
    if (settled) return false;
    settled = true;
    clearTimeout(timer);
    page.off("download", onDownload);
    return true;
  };
  const onDownload = (download) => {
    if (finish()) resolveWaiter(download);
  };
  let resolveWaiter;
  const promise = new Promise((resolve, reject) => {
    resolveWaiter = resolve;
    rejectWaiter = reject;
    page.on("download", onDownload);
    timer = setTimeout(() => {
      if (finish()) reject(new Error("download_not_started"));
    }, timeoutMs);
    timer.unref?.();
  });
  return {
    promise,
    cancel(reason) {
      if (finish()) rejectWaiter(reason);
    },
  };
}

/**
 * @param {import("playwright-core").Page} page
 * @param {{workspaceDir: string, now: () => number}} options
 */
export function createPgyAdapter(page, { workspaceDir, now }) {
  let capturedPage = null;
  let selectedPriceView = null;
  let releaseDialogHandler = null;
  const learnedDetailPaths = new Set();
  return {
    async prepare() {
      await assertMarketReady(page, "pgy");
      releaseDialogHandler ??= installDialogAutoDismiss(page);
      await dismissOrdinaryPopups(page, "pgy");
      await assertMarketReady(page, "pgy");
    },
    async reset() {
      await assertUsablePage(page, "pgy");
      await dismissOrdinaryPopups(page, "pgy");
      capturedPage = null;
      selectedPriceView = null;
      await page.mouse.move(8, 8);
      await page.mouse.down();
      await page.mouse.up();
      const reset = page
        .locator(".operate-btn:visible,button:visible")
        .filter({ hasText: /^(?:重置|清空)$/u })
        .first();
      await clickOptional(reset);
      const input = page.getByPlaceholder(/按笔记关键词找博主|笔记关键词/u).first();
      if (await input.isVisible().catch(() => false)) await input.fill("");
      await settleAfterAction(page);
    },
    async verifyBaseline() {
      const keyword = cleanText(
        await page
          .getByPlaceholder(/按笔记关键词找博主|笔记关键词/u)
          .first()
          .inputValue()
          .catch(() => ""),
      );
      const quoteSummary = cleanText((await appliedFilterSummary(page, "合作报价")) ?? "");
      return {
        valid: !keyword && !/图文笔记\s*：|视频笔记\s*：/u.test(quoteSummary),
        keyword,
        quote_summary: quoteSummary,
      };
    },
    async recover() {
      await assertUsablePage(page, "pgy");
      const dismissed = await dismissOrdinaryPopups(page, "pgy");
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
      await assertUsablePage(page, "pgy");
      const rowLabels = FILTER_ROWS[filter.control];
      if (!rowLabels) return { applied: false, reason: "platform_filter_not_supported" };
      const nestedRange =
        filter.mode === "range" ? pgyNestedRangeConfig(filter, selectedPriceView) : null;
      if (filter.mode === "range" && NESTED_RANGE_CONTROLS.has(filter.control) && !nestedRange) {
        return { applied: false, reason: "nested_range_view_required" };
      }
      const opened = await openFilterMenu(page, rowLabels);
      if (!opened) return { applied: false, reason: "filter_row_not_found" };
      if (nestedRange) {
        let nestedFailure = null;
        const observed = await captureListResponseDuring(page, "pgy", async () => {
          const result = await fillPgyNestedRangeMenu(
            page,
            opened,
            filter,
            nestedRange.item_label,
          );
          nestedFailure = result.reason;
          await settleAfterAction(page);
          await waitForPgyTableReady(page);
          return result.applied;
        });
        const summaryLabel = opened.trigger_text || rowLabels[0];
        const summary = cleanText((await appliedFilterSummary(page, summaryLabel)) ?? "");
        const applied =
          observed.action_result &&
          summary.includes(nestedRange.item_label) &&
          !summary.includes(nestedRange.opposite_item_label);
        capturedPage = observed.capture ?? null;
        return {
          applied,
          reason: applied ? null : (nestedFailure ?? "nested_range_readback_mismatch"),
          menu_id: opened.menu_id,
          readback: summary || null,
        };
      }
      const observed = await captureListResponseDuring(page, "pgy", async () => {
        const applied =
          filter.mode === "range"
            ? await fillMenuRange(page, opened, filter, { requireConfirm: true })
            : (await selectMenuValues(page, opened, filter.values)).length > 0;
        await settleAfterAction(page);
        await waitForPgyTableReady(page);
        return applied;
      });
      const applied = observed.action_result;
      capturedPage = observed.capture ?? null;
      return {
        applied,
        reason: applied ? null : "filter_value_not_found",
        menu_id: opened.menu_id,
        readback: cleanText(await opened.row.innerText().catch(() => "")),
      };
    },
    async setPriceView(priceView) {
      await assertUsablePage(page, "pgy");
      if (!priceView) return { applied: true, readback: null };
      if (!["图文", "视频"].includes(priceView)) {
        return { applied: false, reason: "price_view_option_not_supported" };
      }
      selectedPriceView = priceView;
      return {
        applied: true,
        readback: priceView,
        source: "internal_target",
      };
    },
    async verifySelection(selection) {
      await assertUsablePage(page, "pgy");
      const keywordInput = page.getByPlaceholder(/按笔记关键词找博主|笔记关键词/u).first();
      const keywordValue = cleanText(await keywordInput.inputValue().catch(() => ""));
      const requestedKeyword = cleanText(selection?.branch?.keyword);
      const body = cleanText(
        await page
          .locator("body")
          .innerText()
          .catch(() => ""),
      );
      const requestedPrice = cleanText(selection?.verification?.price_view?.requested);
      const filters = (selection?.verification?.actual_filters ?? []).map((filter) => ({
        control: filter.control,
        valid: Boolean(cleanText(filter.readback)) && body.includes(cleanText(filter.readback)),
      }));
      const keywordValid = keywordValue === requestedKeyword;
      const priceViewValid = !requestedPrice || selectedPriceView === requestedPrice;
      return {
        valid: keywordValid && priceViewValid && filters.every((filter) => filter.valid),
        keyword: { requested: requestedKeyword, readback: keywordValue, valid: keywordValid },
        price_view: {
          requested: requestedPrice,
          readback: selectedPriceView,
          valid: priceViewValid,
        },
        filters,
      };
    },
    async search(keyword) {
      await assertUsablePage(page, "pgy");
      const input = page.getByPlaceholder(/按笔记关键词找博主|笔记关键词/u).first();
      if (!(await input.isVisible().catch(() => false))) {
        return { applied: false, reason: "keyword_input_not_found" };
      }
      const before = await firstResultIdentity(page, "pgy");
      capturedPage = null;
      const observed = await captureListResponseDuring(page, "pgy", async () => {
        await input.fill(keyword);
        await input.press("Enter");
        return waitForResultRefresh(page, "pgy", before, {
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
    async readPage(pageNumber) {
      await assertUsablePage(page, "pgy");
      const result = await readPlatformResults(page, "pgy");
      const captured = capturedPage;
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
    async resultCount() {
      return capturedPage?.total ?? (await readResultCount(page, "pgy"));
    },
    async nextPage() {
      await assertUsablePage(page, "pgy");
      const next = page.locator(".ant-pagination-next,[aria-label='下一页'],button.next").first();
      if (!(await next.isVisible().catch(() => false))) return false;
      if (
        (await next.isDisabled().catch(() => false)) ||
        (await next.getAttribute("aria-disabled")) === "true"
      ) {
        return false;
      }
      const before = await firstResultIdentity(page, "pgy");
      capturedPage = null;
      const observed = await captureListResponseDuring(page, "pgy", async () => {
        await next.scrollIntoViewIfNeeded();
        await next.hover();
        await next.click();
        return waitForResultRefresh(page, "pgy", before, { requireIdentityChange: true });
      });
      capturedPage = observed.capture;
      const advanced = hasResultRefreshEvidence(observed.action_result, capturedPage);
      return {
        advanced,
        reason: advanced ? null : "result_refresh_not_observed",
      };
    },
    async collectDetail(candidate, { groups, onHtmlSnapshot }) {
      return collectCreatorDetail(page, "pgy", candidate, {
        groups,
        learnedPaths: learnedDetailPaths,
        capturedAt: new Date(now()).toISOString(),
        onHtmlSnapshot,
      });
    },
    async paceDetail() {
      await page.waitForTimeout(2_000);
    },
    async export() {
      await assertUsablePage(page, "pgy");
      const button = page.getByRole("button", { name: /^(?:导出|下载)$/u }).first();
      if (!(await button.isVisible().catch(() => false))) {
        return { status: "failed", reason: "export_button_not_found" };
      }
      const outputDir = join(workspaceDir, "ypscan-exports", String(now()));
      await mkdir(outputDir, { recursive: true });
      const waiter = nativeDownloadWaiter(page, 45_000);
      try {
        await button.hover();
        await button.click();
        const confirm = page.getByRole("button", { name: /^(?:确定|确认)$/u }).last();
        if (await confirm.isVisible().catch(() => false)) await confirm.click();
      } catch (error) {
        waiter.cancel(error);
        await waiter.promise.catch(() => {});
        return { status: "failed", reason: "export_click_failed" };
      }
      const download = await waiter.promise.catch(() => null);
      if (!download) return { status: "failed", reason: "download_not_started" };
      const filename = download.suggestedFilename() || "pgy-creators-export.xlsx";
      const filePath = join(outputDir, filename);
      await download.saveAs(filePath);
      return { status: "complete", kind: "native_file", file_path: filePath, filename };
    },
  };
}
