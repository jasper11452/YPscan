import { readResultsPage } from "../browser-page-runtime.js";

export const PLATFORM_RULES = Object.freeze({
  xingtu: {
    host: "www.xingtu.cn",
    path: "/ad/creator/market",
    url: "https://www.xingtu.cn/ad/creator/market",
  },
  pgy: {
    host: "pgy.xiaohongshu.com",
    path: "/solar/pre-trade/note/kol",
    url: "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
  },
});

export function manualBrowserError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

export function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function pageMatches(platform, value) {
  try {
    const url = new URL(value);
    const rule = PLATFORM_RULES[platform];
    return url.hostname === rule.host && url.pathname.replace(/\/+$/u, "") === rule.path;
  } catch {
    return false;
  }
}

/** @param {import("playwright-core").Page} page */
export async function assertNoManualChallenge(page) {
  const body = cleanText(
    await page
      .locator("body")
      .innerText()
      .catch(() => ""),
  );
  const challengeVisible = await page
    .locator(
      "#captcha_container:visible,iframe[src*=verifycenter]:visible,iframe[src*=captcha]:visible,[class*=captcha]:visible,[class*=slide-verify]:visible",
    )
    .first()
    .isVisible()
    .catch(() => false);
  if (challengeVisible || /安全验证|滑块验证|人机验证|图形验证/u.test(body)) {
    throw manualBrowserError("YPSCAN_MANUAL_CAPTCHA_REQUIRED", "平台要求用户完成安全验证");
  }
  return body;
}

/** @param {import("playwright-core").Page} page */
export async function assertUsablePage(page, platform) {
  if (!pageMatches(platform, page.url())) {
    throw manualBrowserError("YPSCAN_MANUAL_WRONG_PAGE", "当前标签页不是目标达人筛选页面", {
      actual_url: page.url(),
      expected: PLATFORM_RULES[platform],
    });
  }
  const body = await assertNoManualChallenge(page);
  if (
    /扫码登录|手机号登录|登录后继续/u.test(body) &&
    !/达人广场|博主广场|找达人|找博主/u.test(body)
  ) {
    throw manualBrowserError(
      "YPSCAN_MANUAL_LOGIN_REQUIRED",
      "平台登录态不可用，请在当前 Browser 页面登录",
    );
  }
}

const ORDINARY_DIALOG_SELECTOR = [
  "[role=dialog]:visible",
  ".el-dialog:visible",
  ".ant-modal:visible",
  ".semi-modal:visible",
  ".arco-modal:visible",
].join(",");

const PROTECTED_DIALOG_TEXT =
  /登录|扫码|验证码|安全验证|人机验证|滑块验证|用户协议|隐私政策|授权|导出|下载|删除|提交|保存|发布|付款|支付/u;
const SAFE_DISMISS_BUTTON = /^(?:Close|关闭|取消|跳过|稍后再说|以后再说|知道了|我知道了)$/iu;

/**
 * Close only ordinary, reversible page prompts. Authentication, CAPTCHA,
 * agreements and consequential confirmations are deliberately left intact.
 *
 * @param {import("playwright-core").Page} page
 * @param {"xingtu"|"pgy"} platform
 */
export async function dismissOrdinaryPopups(page, platform) {
  const dismissed = [];
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    const body = cleanText(
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    const knownPrompt =
      (platform === "xingtu" && body.includes("完善基础资质信息")) ||
      (platform === "pgy" && body.includes("寻找博主&内容"));
    if (knownPrompt) {
      const knownButton = page
        .getByRole("button", {
          name: platform === "xingtu" ? /^Close$/iu : /^跳过$/u,
        })
        .filter({ visible: true })
        .first();
      if (await knownButton.isVisible().catch(() => false)) {
        await knownButton.click();
        dismissed.push(platform === "xingtu" ? "完善基础资质信息" : "寻找博主&内容");
        changed = true;
        await page.waitForTimeout(120);
      }
    }

    const dialogs = page.locator(ORDINARY_DIALOG_SELECTOR);
    const count = Math.min(await dialogs.count().catch(() => 0), 12);
    for (let index = 0; index < count; index += 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const text = cleanText(await dialog.innerText().catch(() => ""));
      if (PROTECTED_DIALOG_TEXT.test(text)) continue;
      const button = dialog
        .getByRole("button", { name: SAFE_DISMISS_BUTTON })
        .filter({ visible: true })
        .first();
      const icon = dialog
        .locator(
          "[aria-label=Close]:visible,[aria-label=close]:visible,[aria-label=关闭]:visible,.el-dialog__close:visible,.ant-modal-close:visible",
        )
        .first();
      const target = (await button.isVisible().catch(() => false)) ? button : icon;
      if (!(await target.isVisible().catch(() => false))) continue;
      await target.click();
      dismissed.push(text.slice(0, 80) || "ordinary_dialog");
      changed = true;
      await page.waitForTimeout(120);
    }
    if (!changed) break;
  }
  return dismissed;
}

/** @param {import("playwright-core").Page} page */
export function installDialogAutoDismiss(page) {
  const handler = (dialog) => dialog.dismiss().catch(() => {});
  page.on("dialog", handler);
  return () => page.off("dialog", handler);
}

/** @param {import("playwright-core").Page} page */
export async function settleAfterAction(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => {});
  await page.waitForTimeout(350);
}

/** @param {import("playwright-core").Page} page */
export async function closeFloatingLayer(page) {
  await page.mouse.move(8, 8);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
}

/**
 * Click a control that may legitimately disappear after a nested menu commits.
 * A stale optional confirmation must never consume Playwright's 30-second
 * default timeout or turn an already-applied filter into a branch failure.
 *
 * @param {import("playwright-core").Locator} locator
 * @param {number} [timeout]
 */
export async function clickOptional(locator, timeout = 1_500) {
  if (typeof locator.isVisible === "function" && !(await locator.isVisible().catch(() => false)))
    return false;
  if (typeof locator.isEnabled === "function" && !(await locator.isEnabled().catch(() => false)))
    return false;
  return locator
    .click({ timeout })
    .then(() => true)
    .catch(() => false);
}

export async function hoverOptional(locator, timeout = 1_500) {
  if (typeof locator.isVisible === "function" && !(await locator.isVisible().catch(() => false)))
    return false;
  return locator
    .hover({ timeout })
    .then(() => true)
    .catch(() => false);
}

export function platformRangeValue(value, { unit, placeholder = "", displayText = "" }) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const number = Number(value);
  if (unit === "ratio") return String(number * 100);
  const tenThousandInput =
    /万|w/iu.test(placeholder) || (unit === "count" && /\d\s*(?:万|w)/iu.test(displayText));
  if (tenThousandInput && Math.abs(number) >= 10_000) return String(number / 10_000);
  return String(number);
}

function exactTextPattern(value) {
  return new RegExp(`^\\s*${String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*$`, "u");
}

function normalizedControlText(value) {
  return cleanText(value).replace(/·\d+$/u, "");
}

function optionAliases(value) {
  const clean = cleanText(value);
  const aliases = new Set([clean]);
  if (clean === "女") aliases.add("女性");
  if (clean === "男") aliases.add("男性");
  if (clean === "女性") aliases.add("女");
  if (clean === "男性") aliases.add("男");
  if (!/[省市]$|自治区$|特别行政区$/u.test(clean)) {
    aliases.add(`${clean}市`);
    aliases.add(`${clean}省`);
  }
  return [...aliases];
}

/**
 * Wait for the dynamic aria-controls target to become visible. A small polling
 * delay permits animation, but visibility—not elapsed time—is the completion
 * condition.
 *
 * @param {import("playwright-core").Page} page
 * @param {import("playwright-core").Locator} trigger
 * @param {string|null} [fallbackSelector]
 */
export async function waitForControlledMenu(page, trigger, fallbackSelector = null) {
  const started = Date.now();
  let stableKey = null;
  let stablePolls = 0;
  while (Date.now() - started < 2_500) {
    let controlledVisible = false;
    const menuId =
      typeof trigger.getAttribute === "function"
        ? await trigger.getAttribute("aria-controls").catch(() => null)
        : null;
    if (menuId) {
      const menu = page.locator(`[id=${JSON.stringify(menuId)}]`).first();
      if (await menu.isVisible().catch(() => false)) {
        controlledVisible = true;
        const text = cleanText(
          typeof menu.innerText === "function" ? await menu.innerText().catch(() => "") : "",
        );
        const key = `${menuId}:${text}`;
        if (key === stableKey) stablePolls += 1;
        else {
          stableKey = key;
          stablePolls = 1;
        }
        if (stablePolls >= 2) return { menu, menu_id: menuId };
      }
    }
    if (fallbackSelector && !controlledVisible) {
      const menu = page.locator(fallbackSelector).last();
      if (await menu.isVisible().catch(() => false)) {
        const text = cleanText(
          typeof menu.innerText === "function" ? await menu.innerText().catch(() => "") : "",
        );
        const key = `fallback:${text}`;
        if (key === stableKey) stablePolls += 1;
        else {
          stableKey = key;
          stablePolls = 1;
        }
        if (stablePolls >= 2) return { menu, menu_id: null };
      }
    }
    await page.waitForTimeout(75);
  }
  return null;
}

/**
 * Find a real filter row, click its trigger, then resolve the teleported menu
 * from the trigger's dynamic aria-controls value.
 *
 * @param {import("playwright-core").Page} page
 * @param {string[]} rowLabels
 * @param {{triggerLabels?: string[], optionValues?: string[]}} [options]
 */
export async function openFilterMenu(page, rowLabels, options = {}) {
  for (const label of rowLabels) {
    const triggers = page.locator(".custom-selector__button:visible");
    const count = await triggers.count();
    for (let index = 0; index < count; index += 1) {
      const trigger = triggers.nth(index);
      const triggerText = normalizedControlText(await trigger.innerText().catch(() => ""));
      if (triggerText !== normalizedControlText(label)) continue;
      await trigger.scrollIntoViewIfNeeded();
      if (!(await hoverOptional(trigger))) continue;
      if (!(await clickOptional(trigger))) continue;
      const resolved = await waitForControlledMenu(page, trigger, ".filter-select-popover:visible");
      if (resolved) {
        return {
          row: trigger,
          menu: resolved.menu,
          trigger,
          trigger_text: triggerText,
          trigger_matches_option: false,
          menu_id: resolved.menu_id,
        };
      }
    }
  }
  const rows = page.locator(".market-filter-wrapper--line,[class*=filter-row],.common-filter-item");
  for (const label of rowLabels) {
    const count = await rows.count();
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;
      const titleLocator = row
        .locator(".market-filter-wrapper-title,[class*=filter-title],.common-filter-item__label")
        .first();
      if ((await titleLocator.count()) === 0) continue;
      const title = cleanText(await titleLocator.innerText({ timeout: 500 }).catch(() => ""));
      if (title !== label) continue;
      const controls = row.locator("[aria-controls]");
      const controlCount = await controls.count();
      const requested = [...(options.triggerLabels ?? []), ...(options.optionValues ?? [])].map(
        normalizedControlText,
      );
      const triggerCandidates = [];
      for (let controlIndex = 0; controlIndex < controlCount; controlIndex += 1) {
        const control = controls.nth(controlIndex);
        const text = normalizedControlText(await control.innerText().catch(() => ""));
        if (requested.includes(text)) triggerCandidates.push(control);
      }
      if (controlCount === 1 && triggerCandidates.length === 0) {
        triggerCandidates.push(controls.first());
      } else if (requested.length === 0 && controlCount > 0) {
        triggerCandidates.push(controls.first());
      }
      for (const trigger of triggerCandidates) {
        if (!(await trigger.isVisible().catch(() => false))) continue;
        await trigger.scrollIntoViewIfNeeded();
        if (!(await hoverOptional(trigger))) continue;
        if (!(await clickOptional(trigger))) continue;
        const resolved = await waitForControlledMenu(
          page,
          trigger,
          ".el-popper:visible,.el-dropdown-menu:visible,.ant-popover:visible,.xt-dropdown:visible,[role=listbox]:visible,[role=menu]:visible,[class*=filter-popover]:visible",
        );
        if (resolved) {
          const triggerText = cleanText(await trigger.innerText().catch(() => ""));
          return {
            row,
            menu: resolved.menu,
            trigger,
            trigger_text: triggerText,
            trigger_matches_option: (options.optionValues ?? []).some(
              (value) => normalizedControlText(value) === normalizedControlText(triggerText),
            ),
            menu_id: resolved.menu_id,
          };
        }
      }
      const inlineControls = row.locator(
        "input:visible,label:visible,[role=option]:visible,[role=checkbox]:visible,.tag.--interactive:visible",
      );
      if ((await inlineControls.count()) > 0) {
        return { row, menu: row, trigger: null, menu_id: null };
      }
    }
  }
  return null;
}

const CASCADE_HOVER_SETTLE_MS = 300;
const CASCADE_STABLE_POLLS = 3;
const LEAF_HOVER_SETTLE_MS = 180;
const OPTION_COMMIT_POLL_MS = 75;
const OPTION_COMMIT_ATTEMPTS = 30;
const CASCADE_COLUMN_SELECTOR =
  ".el-cascader-menu:visible,.ant-cascader-menu:visible,.semi-cascader-column:visible,.arco-cascader-list:visible,[role=menu]:visible,[role=listbox]:visible";

/** @param {import("playwright-core").Locator} root */
async function findTextOption(root, value) {
  for (const alias of optionAliases(value)) {
    const matches = root.getByText(exactTextPattern(alias)).filter({ visible: true });
    if (typeof matches.count === "function" && typeof matches.nth === "function") {
      const visible = [];
      const count = await matches.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const option = matches.nth(index);
        if (await option.isVisible().catch(() => false)) visible.push(option);
      }
      if (visible.length > 1) {
        const logicalOptions = new Map();
        for (const [index, option] of visible.entries()) {
          const key =
            typeof option.evaluate === "function"
              ? await option
                  .evaluate((node) => {
                    const target = node.closest(
                      "[role=option],[role=menuitem],label,li,.d-grid-item,.el-cascader-node,.ant-cascader-menu-item,.semi-cascader-option,.arco-cascader-option,.tag.--interactive,[class*=option-item]",
                    );
                    const element = target ?? node;
                    const rect = element.getBoundingClientRect();
                    const text = (element.innerText ?? element.textContent ?? "")
                      .replace(/\s+/gu, " ")
                      .trim();
                    return `${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}:${text}`;
                  })
                  .catch(() => `node:${index}`)
              : `node:${index}`;
          if (!logicalOptions.has(key)) logicalOptions.set(key, option);
        }
        if (logicalOptions.size > 1) return null;
        return logicalOptions.values().next().value;
      }
      if (visible.length === 1) return visible[0];
      continue;
    }
    const option = matches.first();
    if (await option.isVisible().catch(() => false)) return option;
  }
  return null;
}

/** @param {import("playwright-core").Page} page */
async function cascadeColumns(page) {
  const columns = page.locator(CASCADE_COLUMN_SELECTOR);
  if (typeof columns.count !== "function" || typeof columns.nth !== "function") return [];
  const result = [];
  const count = await columns.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const column = columns.nth(index);
    if (!(await column.isVisible().catch(() => false))) continue;
    const text = cleanText(await column.innerText().catch(() => ""));
    const box =
      typeof column.boundingBox === "function"
        ? await column.boundingBox().catch(() => null)
        : null;
    result.push({ column, index, text, box });
  }
  return result;
}

function cascadeColumnKey(column) {
  const x = Number.isFinite(column.box?.x) ? Math.round(column.box.x) : "?";
  return `${column.index}:${x}:${column.text}`;
}

/** @param {import("playwright-core").Page} page */
async function cascadeSnapshot(page) {
  return new Set((await cascadeColumns(page)).map(cascadeColumnKey));
}

/** @param {import("playwright-core").Locator} option */
async function controlledMenuIds(option) {
  if (typeof option?.evaluate !== "function") return [];
  const value = await option
    .evaluate((node) => {
      let current = node;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        const ids = current.getAttribute("aria-controls") ?? current.getAttribute("aria-owns");
        if (ids) return ids;
      }
      return null;
    })
    .catch(() => null);
  return typeof value === "string" ? value.split(/\s+/u).filter(Boolean) : [];
}

/**
 * Prefer the left-most visible cascade column for the first path segment.
 * This prevents a duplicate label in an already-rendered descendant column
 * from stealing the parent selection.
 */
async function initialCascadeRoot(page, fallback, value) {
  const matches = [];
  for (const candidate of await cascadeColumns(page)) {
    if (await findTextOption(candidate.column, value)) matches.push(candidate);
  }
  if (!matches.length) return fallback;
  matches.sort((left, right) => {
    const leftX = Number.isFinite(left.box?.x) ? left.box.x : left.index;
    const rightX = Number.isFinite(right.box?.x) ? right.box.x : right.index;
    return leftX - rightX;
  });
  return matches[0].column;
}

/** @param {import("playwright-core").Locator} option */
async function optionSelectionState(option) {
  return option
    .evaluate((node) => {
      let current = node;
      let known = false;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        if (
          depth > 0 &&
          current.matches("[role=menu],[role=listbox],.el-cascader-menu,.ant-cascader-menu")
        ) {
          break;
        }
        for (const attribute of ["aria-selected", "aria-checked"]) {
          const state = current.getAttribute(attribute);
          if (state === null) continue;
          known = true;
          if (state === "true") return { known: true, selected: true };
        }
        const className = current.getAttribute("class") ?? "";
        if (
          /(?:^|\s)(?:--active|is-checked|is-selected|checked|selected|ant-checkbox-checked|ant-cascader-checkbox-checked|semi-cascader-option-selected|arco-cascader-option-checked)(?:\s|$)/u.test(
            className,
          )
        ) {
          return { known: true, selected: true };
        }
        const checkable = current.matches("input[type=checkbox],input[type=radio]")
          ? current
          : current.querySelector("input[type=checkbox],input[type=radio]");
        if (checkable) {
          known = true;
          if (checkable.matches(":checked")) {
            return { known: true, selected: true };
          }
        }
      }
      return { known, selected: false };
    })
    .catch(() => ({ known: false, selected: false }));
}

/** @param {any} opened */
async function filterReadback(opened) {
  const sources = [opened.trigger, opened.row].filter(
    (source, index, values) =>
      source && typeof source.innerText === "function" && values.indexOf(source) === index,
  );
  const texts = [];
  for (const source of sources) {
    texts.push(await source.innerText().catch(() => ""));
  }
  if (typeof opened.readback === "function") {
    texts.push(await opened.readback().catch(() => ""));
  }
  return cleanText(texts.join(" "));
}

function readbackConfirmsValue(before, after, value) {
  if (!after || after === before) return false;
  return optionAliases(value).some((alias) => !before.includes(alias) && after.includes(alias));
}

/**
 * @param {import("playwright-core").Locator} option
 * @param {any} opened
 * @param {string} value
 * @param {string} beforeReadback
 */
async function observeOptionCommit(option, opened, value, beforeReadback) {
  const readback = await filterReadback(opened);
  if (readbackConfirmsValue(beforeReadback, readback, value)) {
    return { committed: true, retryable: false };
  }
  if (!(await option.isVisible().catch(() => false))) {
    return { committed: false, retryable: false };
  }
  const state = await optionSelectionState(option);
  return { committed: state.selected, retryable: state.known && !state.selected };
}

/**
 * @param {import("playwright-core").Page} page
 * @param {import("playwright-core").Locator} option
 * @param {any} opened
 * @param {string} value
 * @param {string} beforeReadback
 */
async function waitForOptionCommit(page, option, opened, value, beforeReadback) {
  for (let attempt = 0; attempt < OPTION_COMMIT_ATTEMPTS; attempt += 1) {
    const result = await observeOptionCommit(option, opened, value, beforeReadback);
    if (result.committed) return result;
    if (attempt < OPTION_COMMIT_ATTEMPTS - 1) await page.waitForTimeout(OPTION_COMMIT_POLL_MS);
  }
  return observeOptionCommit(option, opened, value, beforeReadback);
}

/**
 * Hover or click an option. Leaf clicks succeed only after a selected marker
 * or a changed filter readback; menu disappearance alone is not proof.
 *
 * @param {import("playwright-core").Page} page
 * @param {any} opened
 * @param {import("playwright-core").Locator} root
 * @param {string} value
 * @param {{hoverOnly?: boolean}} [options]
 */
async function applyTextOption(page, opened, root, value, { hoverOnly = false } = {}) {
  const option = await findTextOption(root, value);
  if (!option) return { found: false, committed: false };
  await option.scrollIntoViewIfNeeded();
  if (hoverOnly) {
    if (!(await hoverOptional(option))) return { found: true, committed: false };
    return { found: true, committed: true, option };
  }

  if (typeof opened.readback === "function") {
    const currentReadback = cleanText(await opened.readback().catch(() => ""));
    if (optionAliases(value).some((alias) => currentReadback.includes(alias))) {
      return { found: true, committed: true, option };
    }
  }
  const initialState = await optionSelectionState(option);
  if (initialState.selected) return { found: true, committed: true, option };
  const beforeReadback = await filterReadback(opened);
  if (!(await hoverOptional(option))) return { found: true, committed: false };
  await page.waitForTimeout(LEAF_HOVER_SETTLE_MS);
  if (!(await clickOptional(option))) return { found: true, committed: false };
  let result = await waitForOptionCommit(page, option, opened, value, beforeReadback);
  if (!result.committed && result.retryable) {
    await hoverOptional(option);
    await page.waitForTimeout(CASCADE_HOVER_SETTLE_MS);
    result = await observeOptionCommit(option, opened, value, beforeReadback);
    if (!result.committed && result.retryable) {
      await clickOptional(option);
      result = await waitForOptionCommit(page, option, opened, value, beforeReadback);
    }
  }
  return { found: true, committed: result.committed, option };
}

/**
 * Resolve the next cascade column only when it is to the right of the hovered
 * parent (when geometry is available) and is new or changed from the pre-hover
 * snapshot. Three identical polls are required so transient columns cannot win.
 */
async function waitForCascadeOption(page, value, parentOption, beforeSnapshot) {
  await page.waitForTimeout(CASCADE_HOVER_SETTLE_MS);
  const parentBox =
    typeof parentOption?.boundingBox === "function"
      ? await parentOption.boundingBox().catch(() => null)
      : null;
  const controlledIds = await controlledMenuIds(parentOption);
  let stableKey = null;
  let stablePolls = 0;
  for (let attempt = 0; attempt < OPTION_COMMIT_ATTEMPTS; attempt += 1) {
    let controlledCandidate = null;
    for (const id of controlledIds) {
      const column = page.locator(`[id=${JSON.stringify(id)}]`).first();
      if (!(await column.isVisible().catch(() => false))) continue;
      if (!(await findTextOption(column, value))) continue;
      const text = cleanText(await column.innerText().catch(() => ""));
      controlledCandidate = { column, key: `controlled:${id}:${text}` };
      break;
    }
    if (controlledCandidate) {
      if (controlledCandidate.key === stableKey) stablePolls += 1;
      else {
        stableKey = controlledCandidate.key;
        stablePolls = 1;
      }
      if (stablePolls >= CASCADE_STABLE_POLLS) return controlledCandidate.column;
      if (attempt < OPTION_COMMIT_ATTEMPTS - 1) await page.waitForTimeout(OPTION_COMMIT_POLL_MS);
      continue;
    }
    const candidates = [];
    for (const candidate of await cascadeColumns(page)) {
      if (!(await findTextOption(candidate.column, value))) continue;
      if (
        Number.isFinite(parentBox?.x) &&
        Number.isFinite(candidate.box?.x) &&
        candidate.box.x <= parentBox.x + 2
      ) {
        continue;
      }
      const key = cascadeColumnKey(candidate);
      if (beforeSnapshot.has(key)) continue;
      candidates.push({ ...candidate, key });
    }
    candidates.sort((left, right) => {
      const leftX = Number.isFinite(left.box?.x) ? left.box.x : left.index;
      const rightX = Number.isFinite(right.box?.x) ? right.box.x : right.index;
      return leftX - rightX;
    });
    const candidate = candidates[0];
    if (candidate) {
      if (candidate.key === stableKey) stablePolls += 1;
      else {
        stableKey = candidate.key;
        stablePolls = 1;
      }
      if (stablePolls >= CASCADE_STABLE_POLLS) return candidate.column;
    }
    const overlay = page
      .locator(".el-popper:visible,.ant-cascader-menus:visible,[role=menu]:visible")
      .last();
    const fallbackFound =
      !candidate && beforeSnapshot.size === 0 && (await findTextOption(overlay, value));
    if (fallbackFound) {
      if (stableKey === "fallback") stablePolls += 1;
      else {
        stableKey = "fallback";
        stablePolls = 1;
      }
      if (stablePolls >= CASCADE_STABLE_POLLS) return overlay;
    } else if (!candidate) {
      stableKey = null;
      stablePolls = 0;
    }
    if (attempt < OPTION_COMMIT_ATTEMPTS - 1) await page.waitForTimeout(OPTION_COMMIT_POLL_MS);
  }
  return null;
}

/**
 * @param {import("playwright-core").Page} page
 * @param {any} opened
 * @param {string[]} values
 * @param {{close?: boolean}} [options]
 */
export async function selectMenuValues(page, opened, values, options = {}) {
  const selected = [];
  for (const value of values) {
    const path = String(value)
      .split(/\s*(?:>|\/|→)\s*/u)
      .filter(Boolean);
    let root = opened.menu;
    if (path.length > 1) root = await initialCascadeRoot(page, root, path[0]);
    let applied = true;
    for (let index = 0; index < path.length; index += 1) {
      const part = path[index];
      const hoverOnly = index < path.length - 1;
      const beforeSnapshot = hoverOnly ? await cascadeSnapshot(page) : new Set();
      let action = await applyTextOption(page, opened, root, part, { hoverOnly });
      if (!action.found) {
        const overlay = page
          .locator(".el-popper:visible,.ant-cascader-menus:visible,[role=menu]:visible")
          .last();
        action = await applyTextOption(page, opened, overlay, part, { hoverOnly });
      }
      if (!action.found || !action.committed) {
        applied = false;
        break;
      }
      if (hoverOnly) {
        const nextRoot = await waitForCascadeOption(
          page,
          path[index + 1],
          action.option,
          beforeSnapshot,
        );
        if (!nextRoot) {
          applied = false;
          break;
        }
        root = nextRoot;
      }
    }
    if (applied) selected.push(value);
  }
  if (selected.length !== values.length) {
    if (options.close !== false) await closeFloatingLayer(page);
    return [];
  }
  if (options.close !== false) {
    const confirm = opened.menu.getByRole("button", { name: /^(?:确定|确认)$/u }).first();
    const confirmVisible = await confirm.isVisible().catch(() => false);
    if (confirmVisible) {
      if (!(await clickOptional(confirm))) return [];
    } else {
      await closeFloatingLayer(page);
    }
  }
  return selected;
}

/**
 * @param {import("playwright-core").Page} page
 * @param {any} opened
 * @param {{min: number|null, max: number|null, unit?: string|null}} filter
 */
export async function fillMenuRange(page, opened, filter) {
  const custom = opened.menu.getByText(/^(?:自定义|自定义区间)$/u).first();
  if (await custom.isVisible().catch(() => false)) {
    if (!(await clickOptional(custom))) return false;
    await page.waitForTimeout(LEAF_HOVER_SETTLE_MS);
  }
  const inputs = opened.menu.locator("input:visible:not([readonly]):not([disabled])");
  const count = await inputs.count();
  if (!count || count > 2) {
    await closeFloatingLayer(page);
    return false;
  }
  const displayText = cleanText(await opened.menu.innerText().catch(() => ""));
  const values = count === 1 ? [filter.max ?? filter.min] : [filter.min, filter.max];
  const expected = new Map();
  const indexes = Array.from({ length: Math.min(count, values.length) }, (_, index) => index);
  if (indexes.length > 1) indexes.reverse();
  for (const index of indexes) {
    const input = inputs.nth(index);
    const value = platformRangeValue(values[index], {
      unit: filter.unit,
      placeholder: (await input.getAttribute("placeholder")) ?? "",
      displayText,
    });
    const normalizedValue = value ?? "";
    await input.fill(normalizedValue);
    expected.set(index, normalizedValue);
  }
  for (const [index, value] of expected) {
    const input = inputs.nth(index);
    if (typeof input.inputValue !== "function") continue;
    const readback = await input.inputValue().catch(() => null);
    if (readback === null || cleanText(readback).replace(/,/gu, "") !== value.replace(/,/gu, "")) {
      return false;
    }
  }
  const confirm = opened.menu.getByRole("button", { name: /^(?:确定|确认)$/u }).first();
  if (!(await clickOptional(confirm))) await closeFloatingLayer(page);
  return true;
}

/** @param {import("playwright-core").Page} page */
export async function readPlatformResults(page, platform) {
  return page.evaluate(readResultsPage, { platform });
}

export function resultCountFromText(text, platform) {
  const pattern =
    platform === "xingtu" ? /根据内容词找到\s*([\d,]+)\s*达人/u : /推荐\s*([\d,]+)\s*位博主/u;
  const match = cleanText(text).match(pattern);
  return match ? Number(match[1].replace(/,/gu, "")) : null;
}

/** @param {import("playwright-core").Page} page */
export async function readResultCount(page, platform) {
  return resultCountFromText(
    await page
      .locator("body")
      .innerText()
      .catch(() => ""),
    platform,
  );
}

/** @param {import("playwright-core").Page} page */
export async function firstResultIdentity(page, platform) {
  const result = await readPlatformResults(page, platform).catch(() => ({ rows: [] }));
  const first = result.rows?.[0];
  return first?.platform_id ?? first?.detail_url ?? first?.nickname ?? first?.raw_text ?? null;
}

/**
 * @param {import("playwright-core").Page} page
 * @param {string} platform
 * @param {string|null} previousIdentity
 * @param {{requireIdentityChange?: boolean}} [options]
 */
export async function waitForResultRefresh(
  page,
  platform,
  previousIdentity = null,
  { requireIdentityChange = false } = {},
) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const count = await readResultCount(page, platform);
    const identity = await firstResultIdentity(page, platform);
    const resultText = cleanText(
      await page
        .locator(".base-author-list,.author-list,[class*=creator-list],[class*=kol-list]")
        .first()
        .innerText()
        .catch(() => ""),
    );
    const empty = /暂无数据|暂无结果|未找到|没有符合/u.test(resultText);
    if (
      (requireIdentityChange && identity && identity !== previousIdentity) ||
      (!requireIdentityChange && (count !== null || identity || empty)) ||
      empty
    ) {
      return { result_count: count, first_candidate: identity };
    }
    await page.waitForTimeout(250);
  }
  return {
    result_count: await readResultCount(page, platform),
    first_candidate: await firstResultIdentity(page, platform),
  };
}

/** @param {import("playwright-core").Page} page */
export async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.scrollIntoViewIfNeeded();
      await locator.hover();
      await locator.click();
      return true;
    }
  }
  return false;
}
