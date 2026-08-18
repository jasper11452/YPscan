import { createHash } from "node:crypto";
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

async function inspectControls(page) {
  return page
    .locator(
      "button:visible,input:visible,[role=tab]:visible,[role=menuitem]:visible,[role=option]:visible,[aria-haspopup]:visible,[aria-expanded]:visible",
    )
    .evaluateAll((elements) =>
      elements.slice(0, 30).map((element, index) => {
        const input = element.tagName === "INPUT" ? element : null;
        return {
          semantic_id: `${element.getAttribute("role") ?? element.tagName.toLowerCase()}:${index}`,
          kind: element.getAttribute("role") ?? element.tagName.toLowerCase(),
          label: String(
            element.getAttribute("aria-label") ??
              element.getAttribute("placeholder") ??
              element.textContent ??
              "",
          )
            .replace(/\s+/gu, " ")
            .trim()
            .slice(0, 100),
          value: String(input?.value ?? element.getAttribute("aria-valuetext") ?? "").slice(0, 100),
          enabled: !element.matches(":disabled,[aria-disabled=true]"),
          expanded: element.getAttribute("aria-expanded"),
        };
      }),
    )
    .catch(() => []);
}

async function marketState(page, platform) {
  const placeholder =
    platform === "xingtu" ? /按内容关键词找达人|内容关键词/u : /按笔记关键词找博主|笔记关键词/u;
  const input = page.getByPlaceholder(placeholder).first();
  const inputVisible = await visible(input);
  const keyword = inputVisible ? cleanText(await input.inputValue().catch(() => "")) : "";
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
    input_visible: inputVisible,
    keyword,
    filters,
    result_row_count: resultCount,
    page_number: Number.parseInt(currentPageText, 10) || 1,
    can_next_page: nextVisible && !nextDisabled,
    loading,
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
  const challenge = await inspectChallenge(page, text);
  const modal = await inspectModal(page);
  const market = pageMatches(platform, url) ? await marketState(page, platform) : null;
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
  else if (market?.loading || (pageMatches(platform, url) && !market?.input_visible)) {
    pageState = "MARKET_LOADING";
  } else if (detailMarker) pageState = "CREATOR_DETAIL_READY";
  else if (market?.input_visible && market.result_row_count > 0) pageState = "RESULTS_READY";
  else if (market?.input_visible) pageState = "MARKET_READY";
  else if (!sameHost || !pageMatches(platform, url)) pageState = "WRONG_PAGE";
  const controls = await inspectControls(page);
  const snapshot = {
    page_state: pageState,
    platform,
    url,
    title,
    auth: loginRequired ? "logged_out" : sameHost ? "logged_in_or_unknown" : "unknown",
    modal,
    challenge,
    market,
    detail: detailMarker ? { candidate_id: detailId, url } : null,
    visible_controls: controls,
    page_summary: [pageState, title, market?.keyword ? `关键词=${market.keyword}` : null]
      .filter(Boolean)
      .join("；"),
  };
  return { ...snapshot, state_id: stateId(snapshot) };
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
export async function inspectManualBrowser(browser, platform, { expectedStateId = null } = {}) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const inspected = [];
  for (const [index, page] of pages.entries()) {
    const [state, focus] = await Promise.all([
      inspectManualBrowserPage(page, platform),
      pageFocusState(page),
    ]);
    inspected.push({ page, state, focus, index });
  }
  const expected = expectedStateId
    ? inspected.filter((item) => item.state.state_id === expectedStateId)
    : [];
  let selected = expected.length === 1 ? expected[0] : null;
  if (!selected && !expectedStateId) {
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
      page_summary: expectedStateId ? "expected_state_not_found" : "browser_has_no_pages",
    };
    return { page: null, state: { ...unknown, state_id: stateId(unknown), tabs } };
  }
  return { page: selected.page, state: { ...selected.state, tabs } };
}
