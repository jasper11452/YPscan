import { createHash, randomUUID } from "node:crypto";
import { cleanText, pageMatches, PLATFORM_RULES } from "./manual-research/common.js";

export const MANUAL_BROWSER_PAGE_STATES = Object.freeze([
  "UNKNOWN",
  "WRONG_PAGE",
  "LOGIN_REQUIRED",
  "MARKET_LOADING",
  "MARKET_READY",
  "RESULTS_READY",
  "CREATOR_DETAIL_READY",
  "MODAL_BLOCKED",
  "CAPTCHA_BLOCKED",
  "ERROR_PAGE",
]);

const DIALOG_SELECTOR = [
  "[role=dialog]:visible",
  ".el-dialog:visible",
  ".ant-modal:visible",
  ".semi-modal:visible",
  ".arco-modal:visible",
].join(",");
const CHALLENGE_SELECTOR =
  "#captcha_container:visible,iframe[src*=verifycenter]:visible,iframe[src*=captcha]:visible,[class*=captcha]:visible,[class*=slide-verify]:visible";
const SAFE_DISMISS_TEXT = /^(?:Close|关闭|取消|跳过|稍后再说|以后再说|知道了|我知道了)$/iu;
const PROTECTED_DIALOG_TEXT =
  /登录|扫码|验证码|安全验证|人机验证|滑块验证|用户协议|隐私政策|授权|导出|下载|删除|提交|保存|发布|付款|支付/u;
const CAPTCHA_TEXT = /安全验证|滑块验证|人机验证|图形验证/u;
const CAPTCHA_ACTION_TEXT = /拖动|滑块|拼图|点击验证|完成验证|刷新验证/u;
const ERROR_TEXT = /页面不存在|访问异常|系统错误|服务异常|网络开小差|加载失败/u;
const INTERACTIVE_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  "label",
  "[role]",
  "[tabindex]",
  "[contenteditable=true]",
  "[aria-controls]",
  "[aria-expanded]",
  "[aria-checked]",
  "[aria-selected]",
  "[class*=filter]",
  "[class*=selector]",
  "[class*=menu-item]",
  "[class*=option]",
  "[class*=pagination]",
].join(",");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function stateId(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function shortId(prefix, value) {
  return `${prefix}_${stateId(value).slice(0, 16)}`;
}

function pageHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

async function visible(locator) {
  return Boolean(await locator?.isVisible?.().catch(() => false));
}

async function bodyText(page) {
  return cleanText(
    await page
      .locator("body")
      .innerText()
      .catch(() => ""),
  );
}

async function inspectChallenge(page, text) {
  const pageUrl = page.url?.() ?? "";
  const component = page.locator(CHALLENGE_SELECTOR).first();
  if (await visible(component)) {
    return {
      present: true,
      type: "interactive_challenge",
      evidence: { signal: "visible_challenge_component", selector: CHALLENGE_SELECTOR },
    };
  }
  if (/verifycenter|captcha|challenge/iu.test(pageUrl)) {
    return {
      present: true,
      type: "challenge_page",
      evidence: { signal: "challenge_url", page_url: pageUrl },
    };
  }
  const dialogs = page.locator(DIALOG_SELECTOR);
  const count = Math.min(await dialogs.count().catch(() => 0), 12);
  for (let index = 0; index < count; index += 1) {
    const dialog = dialogs.nth(index);
    if (!(await visible(dialog))) continue;
    const dialogText = cleanText(await dialog.innerText().catch(() => ""));
    if (CAPTCHA_TEXT.test(dialogText) && CAPTCHA_ACTION_TEXT.test(dialogText)) {
      return {
        present: true,
        type: "challenge_overlay",
        evidence: { signal: "challenge_overlay_text", text_excerpt: dialogText.slice(0, 120) },
      };
    }
  }
  return {
    present: false,
    type: null,
    evidence: text && CAPTCHA_TEXT.test(text) ? { signal: "unconfirmed_page_text" } : null,
  };
}

async function inspectModal(page) {
  const dialogs = page.locator(DIALOG_SELECTOR);
  const count = Math.min(await dialogs.count().catch(() => 0), 12);
  for (let index = 0; index < count; index += 1) {
    const dialog = dialogs.nth(index);
    if (!(await visible(dialog))) continue;
    const text = cleanText(await dialog.innerText().catch(() => ""));
    const safeButton = dialog
      .getByRole("button", { name: SAFE_DISMISS_TEXT })
      .filter({ visible: true })
      .first();
    const safeIcon = dialog
      .locator(
        "[aria-label=Close]:visible,[aria-label=close]:visible,[aria-label=关闭]:visible,.el-dialog__close:visible,.ant-modal-close:visible",
      )
      .first();
    const dismissible =
      !PROTECTED_DIALOG_TEXT.test(text) &&
      ((await visible(safeButton)) || (await visible(safeIcon)));
    return {
      present: true,
      modal_id: stateId({ index, text: text.slice(0, 160) }).slice(0, 16),
      type: PROTECTED_DIALOG_TEXT.test(text)
        ? "protected"
        : /完善|引导|欢迎|寻找博主/u.test(text)
          ? "onboarding"
          : "ordinary",
      title: text.slice(0, 80) || null,
      dismissible,
      actions: await dialog
        .getByRole("button")
        .evaluateAll((buttons) =>
          buttons
            .map((button) =>
              String(button.textContent ?? "")
                .replace(/\s+/gu, " ")
                .trim(),
            )
            .filter(Boolean)
            .slice(0, 8),
        )
        .catch(() => []),
    };
  }
  return {
    present: false,
    modal_id: null,
    type: null,
    title: null,
    dismissible: false,
    actions: [],
  };
}

function elementSignature(element) {
  return {
    region: element.region,
    role: element.role,
    tag: element.tag,
    name: element.name,
    input_type: element.input_type,
    href: element.href,
    occurrence: element.occurrence,
  };
}

/** Return every visible actionable element in one consistent DOM evaluation. */
export async function inspectInteractiveElements(page) {
  const raw = await page
    .locator(INTERACTIVE_SELECTOR)
    .evaluateAll((elements) => {
      const clean = (value) =>
        String(value ?? "")
          .replace(/\s+/gu, " ")
          .trim();
      const visible = (element) => {
        const style = globalThis.getComputedStyle?.(element);
        return Boolean(
          element.getClientRects?.().length &&
          style?.display !== "none" &&
          style?.visibility !== "hidden" &&
          Number(style?.opacity ?? 1) !== 0,
        );
      };
      const interactive = (element) => {
        const tag = element.tagName.toLowerCase();
        const role = clean(element.getAttribute("role")).toLowerCase();
        const style = globalThis.getComputedStyle?.(element);
        return (
          ["button", "input", "select", "textarea", "a", "label"].includes(tag) ||
          [
            "button",
            "checkbox",
            "combobox",
            "link",
            "menuitem",
            "option",
            "radio",
            "searchbox",
            "slider",
            "spinbutton",
            "switch",
            "tab",
            "textbox",
          ].includes(role) ||
          element.hasAttribute("tabindex") ||
          element.hasAttribute("contenteditable") ||
          element.hasAttribute("aria-controls") ||
          element.hasAttribute("aria-expanded") ||
          element.hasAttribute("aria-checked") ||
          element.hasAttribute("aria-selected") ||
          style?.cursor === "pointer"
        );
      };
      const regionOf = (element) => {
        const owner = element.closest?.(
          "[role=dialog],dialog,nav,header,main,aside,form,table,[class*=filter],[class*=search],[class*=pagination],[class*=detail],[class*=card]",
        );
        if (!owner) return { kind: "page", label: "页面" };
        const className = clean(owner.getAttribute?.("class"));
        const role = clean(owner.getAttribute?.("role"));
        const tag = owner.tagName?.toLowerCase?.() ?? "region";
        const kind =
          role === "dialog" || tag === "dialog"
            ? "dialog"
            : /filter/iu.test(className)
              ? "filters"
              : /search/iu.test(className) || tag === "form"
                ? "search"
                : /pagination/iu.test(className)
                  ? "pagination"
                  : /detail/iu.test(className)
                    ? "detail"
                    : /card/iu.test(className) || tag === "table"
                      ? "results"
                      : role || tag;
        return {
          kind,
          label: clean(
            owner.getAttribute?.("aria-label") ??
              owner.getAttribute?.("title") ??
              owner.querySelector?.("legend,h1,h2,h3,[role=heading]")?.textContent ??
              kind,
          ).slice(0, 120),
        };
      };
      const candidates = elements
        .map((element, locatorIndex) => ({ element, locatorIndex }))
        .filter(({ element }) => visible(element) && interactive(element));
      const signatures = new Map();
      return candidates.map(({ element, locatorIndex }) => {
        const tag = element.tagName.toLowerCase();
        const role = clean(element.getAttribute("role")) || tag;
        const region = regionOf(element);
        const name = clean(
          element.getAttribute("aria-label") ??
            element.getAttribute("placeholder") ??
            element.getAttribute("title") ??
            element.labels?.[0]?.textContent ??
            element.textContent,
        ).slice(0, 160);
        const href = tag === "a" ? clean(element.getAttribute("href")).slice(0, 300) : "";
        const signature = JSON.stringify([
          region.kind,
          region.label,
          role,
          tag,
          name,
          clean(element.getAttribute("type")),
          href,
        ]);
        const occurrence = signatures.get(signature) ?? 0;
        signatures.set(signature, occurrence + 1);
        const value =
          "value" in element ? clean(element.value) : clean(element.getAttribute("aria-valuetext"));
        return {
          locator_index: locatorIndex,
          region,
          role,
          tag,
          name,
          text: clean(element.textContent).slice(0, 160),
          value: value.slice(0, 160),
          input_type: clean(element.getAttribute("type")) || null,
          href: href || null,
          enabled: !element.matches(":disabled,[aria-disabled=true]"),
          checked:
            "checked" in element ? Boolean(element.checked) : element.getAttribute("aria-checked"),
          selected:
            "selected" in element
              ? Boolean(element.selected)
              : element.getAttribute("aria-selected"),
          expanded: element.getAttribute("aria-expanded"),
          pressed: element.getAttribute("aria-pressed"),
          active: /(?:^|\s)(?:active|selected|checked|is-active|is-selected)(?:\s|$)/iu.test(
            clean(element.getAttribute("class")),
          ),
          occurrence,
        };
      });
    })
    .catch(() => []);
  const regions = new Map();
  const elements = raw.map((item) => {
    const signature = elementSignature(item);
    const elementId = shortId("el", signature);
    const regionId = shortId("region", item.region);
    regions.set(regionId, { region_id: regionId, ...item.region, element_ids: [] });
    regions.get(regionId).element_ids.push(elementId);
    const actions = [];
    if (item.enabled) {
      if (
        ["input", "textarea"].includes(item.tag) ||
        ["textbox", "searchbox"].includes(item.role)
      ) {
        actions.push("fill");
      }
      if (item.tag === "select") actions.push("select");
      if (
        !["input", "textarea"].includes(item.tag) ||
        ["checkbox", "radio"].includes(item.input_type)
      ) {
        actions.push("click");
      }
      actions.push("hover");
    }
    return {
      element_id: elementId,
      region_id: regionId,
      role: item.role,
      tag: item.tag,
      name: item.name,
      text: item.text,
      value: item.value,
      input_type: item.input_type,
      href: item.href,
      enabled: item.enabled,
      checked: item.checked,
      selected: item.selected,
      expanded: item.expanded,
      pressed: item.pressed,
      active: item.active,
      occurrence: item.occurrence,
      actions: [...new Set(actions)],
      _locator_index: item.locator_index,
    };
  });
  return { elements, regions: [...regions.values()] };
}

export async function resolveInteractiveElement(page, descriptor) {
  const snapshot = await inspectInteractiveElements(page);
  const match = snapshot.elements.find((element) => element.element_id === descriptor?.element_id);
  if (!match) return { locator: null, element: null, snapshot };
  return {
    locator: page.locator(INTERACTIVE_SELECTOR).nth(match._locator_index),
    element: match,
    snapshot,
  };
}

async function marketState(page, platform, elements) {
  const keywordElement = elements.find(
    (element) =>
      ["input", "textarea"].includes(element.tag) &&
      /关键词|keyword|搜索达人|搜索博主/iu.test(`${element.name} ${element.text}`),
  );
  const fallbackInput = page
    .getByPlaceholder(
      platform === "xingtu" ? /按内容关键词找达人|内容关键词/u : /按笔记关键词找博主|笔记关键词/u,
    )
    .first();
  const fallbackVisible = keywordElement ? false : await visible(fallbackInput);
  const keyword = cleanText(
    keywordElement?.value ??
      (fallbackVisible ? await fallbackInput.inputValue().catch(() => "") : ""),
  );
  const resultSelector =
    platform === "xingtu"
      ? ".base-author-list .content-cell:visible"
      : "tbody tr:visible,.kol-card:visible";
  const resultCount = await page
    .locator(resultSelector)
    .count()
    .catch(() => 0);
  const loading = await visible(
    page
      .locator(
        ".el-loading-mask:visible,.ant-spin-spinning:visible,[aria-busy=true]:visible,[class*=loading]:visible",
      )
      .first(),
  );
  const currentPageText = cleanText(
    await page
      .locator(".el-pagination .number.active,.ant-pagination-item-active,[aria-current=page]")
      .first()
      .innerText()
      .catch(() => ""),
  );
  const next = page
    .locator(
      platform === "xingtu"
        ? ".el-pagination .btn-next,[aria-label='下一页'],button.next"
        : ".ant-pagination-next,[aria-label='下一页'],button.next",
    )
    .first();
  const nextVisible = await visible(next);
  const nextDisabled =
    nextVisible &&
    ((await next.isDisabled().catch(() => false)) ||
      (await next.getAttribute("aria-disabled").catch(() => null)) === "true");
  const filters = await page
    .locator(
      ".market-filter-wrapper--line [aria-controls].active:visible,.market-filter-wrapper--line [aria-controls].selected-label:visible,.filter-selected-item:visible,.selected-filter:visible",
    )
    .evaluateAll((elements) =>
      elements.slice(0, 30).map((element) =>
        String(element.textContent ?? "")
          .replace(/\s+/gu, " ")
          .trim(),
      ),
    )
    .catch(() => []);
  return {
    input_visible: Boolean(keywordElement) || fallbackVisible,
    keyword,
    filters,
    result_row_count: resultCount,
    page_number: Number.parseInt(currentPageText, 10) || 1,
    can_next_page: nextVisible && !nextDisabled,
    loading,
  };
}

function selectedFilterState(elements) {
  const filterElements = elements.filter((element) => element._region_kind === "filters");
  const selected = filterElements
    .filter((element) => {
      const active =
        element.checked === true ||
        element.checked === "true" ||
        element.selected === true ||
        element.selected === "true" ||
        element.pressed === "true" ||
        element.active === true;
      const filledControl =
        ["input", "select", "textarea"].includes(element.tag) && cleanText(element.value);
      return active || filledControl;
    })
    .map((element) => ({
      element_id: element.element_id,
      label: element.name || element.text,
      value: element.value || element.text || element.name,
    }));
  const normalized = filterElements
    .filter((element) => !["menuitem", "option"].includes(element.role))
    .map((element) =>
      [
        element.role,
        element.tag,
        cleanText(element.name),
        cleanText(element.text),
        cleanText(element.value),
        element.checked,
        element.selected,
        element.active,
      ].join("|"),
    )
    .sort();
  return {
    items: selected,
    fingerprint: shortId("filters", normalized),
  };
}

function detailIdentity(platform, url) {
  if (platform === "xingtu") {
    return url.match(/\/author-homepage\/douyin-video\/([^/?#]+)/iu)?.[1] ?? null;
  }
  return url.match(/\/(?:kol|blogger|user|detail)\/([^/?#]+)/iu)?.[1] ?? null;
}

/** Inspect one page without navigating or dismissing anything. */
export async function inspectManualBrowserPage(page, platform) {
  const url = page.url?.() ?? "";
  const title = cleanText(await page.title?.().catch(() => ""));
  const text = await bodyText(page);
  const [{ elements: inspectedElements, regions }, challenge, modal, documentState] =
    await Promise.all([
      inspectInteractiveElements(page),
      inspectChallenge(page, text),
      inspectModal(page),
      page
        .evaluate(() => ({
          ready_state: globalThis.document?.readyState ?? "unknown",
          visibility_state: globalThis.document?.visibilityState ?? "unknown",
        }))
        .catch(() => ({ ready_state: "unknown", visibility_state: "unknown" })),
    ]);
  const elementsWithRegion = inspectedElements.map(({ _locator_index: _ignored, ...element }) => ({
    ...element,
    _region_kind: regions.find((region) => region.region_id === element.region_id)?.kind ?? "page",
  }));
  const elements = elementsWithRegion.map(({ _region_kind: _ignored, ...element }) => element);
  const market = pageMatches(platform, url) ? await marketState(page, platform, elements) : null;
  const sameHost = pageHost(url) === PLATFORM_RULES[platform].host;
  const loginRequired =
    /扫码登录|手机号登录|登录后继续|请先登录/u.test(text) &&
    !/达人广场|博主广场|找达人|找博主/u.test(text);
  const detailId = sameHost && !pageMatches(platform, url) ? detailIdentity(platform, url) : null;
  const detailMarker =
    sameHost &&
    !pageMatches(platform, url) &&
    (Boolean(detailId) || /达人详情|博主详情|粉丝画像|受众画像|数据表现/u.test(text));
  let pageState = "UNKNOWN";
  if (challenge.present) pageState = "CAPTCHA_BLOCKED";
  else if (loginRequired) pageState = "LOGIN_REQUIRED";
  else if (modal.present) pageState = "MODAL_BLOCKED";
  else if (ERROR_TEXT.test(text)) pageState = "ERROR_PAGE";
  else if (detailMarker) pageState = "CREATOR_DETAIL_READY";
  else if (market?.result_row_count > 0) pageState = "RESULTS_READY";
  else if (pageMatches(platform, url)) pageState = "MARKET_READY";
  else if (!sameHost || !pageMatches(platform, url)) pageState = "WRONG_PAGE";
  const selectedFilters = selectedFilterState(elementsWithRegion);
  const urlObject = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();
  const redirectPending =
    platform === "xingtu" &&
    urlObject?.hostname === PLATFORM_RULES.xingtu.host &&
    urlObject?.searchParams.get("redirect_uri") === PLATFORM_RULES.xingtu.path;
  const pageKind = detailMarker
    ? "creator_detail"
    : pageMatches(platform, url)
      ? "creator_market"
      : sameHost
        ? "platform_other"
        : "external";
  const pageContextId = shortId("page", {
    platform,
    page_kind: pageKind,
    host: urlObject?.hostname ?? null,
    path: urlObject?.pathname ?? null,
    blocker: challenge.present
      ? "captcha"
      : loginRequired
        ? "login"
        : modal.present
          ? "modal"
          : null,
  });
  const snapshot = {
    observation_id: randomUUID(),
    page_context_id: pageContextId,
    page_state: pageState,
    page_kind: pageKind,
    platform,
    url,
    title,
    auth: loginRequired ? "logged_out" : sameHost ? "logged_in_or_unknown" : "unknown",
    modal,
    challenge,
    document: documentState,
    navigation: {
      redirect_detected: redirectPending,
      status: redirectPending
        ? "redirect_target_pending"
        : market?.loading || documentState.ready_state === "loading"
          ? "busy"
          : "settled",
      expected_market_url: PLATFORM_RULES[platform].url,
    },
    market,
    detail: detailMarker ? { candidate_id: detailId, url } : null,
    regions,
    elements,
    visible_controls: elements,
    selected_filters: selectedFilters.items,
    selected_filter_fingerprint: selectedFilters.fingerprint,
    page_summary: [pageState, title, market?.keyword ? `关键词=${market.keyword}` : null]
      .filter(Boolean)
      .join("；"),
  };
  const { observation_id: _observationId, ...stateSnapshot } = snapshot;
  return { ...snapshot, state_id: stateId(stateSnapshot) };
}

async function pageFocusState(page) {
  return typeof page.evaluate === "function"
    ? page
        .evaluate(() => ({
          focused: globalThis.document.hasFocus(),
          visible: globalThis.document.visibilityState === "visible",
        }))
        .catch(() => ({ focused: false, visible: false }))
    : { focused: false, visible: false };
}

/** Inspect every shared Browser tab and select one deterministically. */
export async function inspectManualBrowser(
  browser,
  platform,
  { expectedStateId = null, tabId = null } = {},
) {
  const pages = browser.contexts().flatMap((context, contextIndex) =>
    context.pages().map((page, pageIndex) => ({
      page,
      tab_id: `tab:${contextIndex}:${pageIndex}`,
    })),
  );
  const inspected = [];
  for (const [index, item] of pages.entries()) {
    const { page } = item;
    const [state, focus] = await Promise.all([
      inspectManualBrowserPage(page, platform),
      pageFocusState(page),
    ]);
    inspected.push({
      page,
      state: { ...state, tab_id: item.tab_id },
      focus,
      index,
      tab_id: item.tab_id,
    });
  }
  const expected = expectedStateId
    ? inspected.filter((item) => item.state.state_id === expectedStateId)
    : [];
  let selected = tabId ? (inspected.find((item) => item.tab_id === tabId) ?? null) : null;
  selected ??= expected.length === 1 ? expected[0] : null;
  if (!selected && !expectedStateId && !tabId) {
    selected =
      inspected.find((item) => item.focus.focused) ??
      inspected.find((item) => item.focus.visible) ??
      inspected.find((item) => item.state.page_state === "CREATOR_DETAIL_READY") ??
      inspected.find((item) => ["RESULTS_READY", "MARKET_READY"].includes(item.state.page_state)) ??
      inspected[0] ??
      null;
  }
  const tabs = inspected.slice(0, 10).map((item) => ({
    index: item.index,
    tab_id: item.tab_id,
    state_id: item.state.state_id,
    page_state: item.state.page_state,
    url: item.state.url,
    title: item.state.title,
    focused: item.focus.focused,
    visible: item.focus.visible,
  }));
  if (!selected) {
    const unknown = {
      page_state: "UNKNOWN",
      platform,
      url: null,
      title: null,
      auth: "unknown",
      modal: { present: false, modal_id: null, type: null, title: null, dismissible: false },
      challenge: { present: false, type: null, evidence: null },
      market: null,
      detail: null,
      visible_controls: [],
      elements: [],
      regions: [],
      selected_filters: [],
      selected_filter_fingerprint: shortId("filters", []),
      page_summary: expectedStateId ? "expected_state_not_found" : "browser_has_no_pages",
    };
    return { page: null, state: { ...unknown, state_id: stateId(unknown), tabs } };
  }
  return { page: selected.page, state: { ...selected.state, tabs } };
}
