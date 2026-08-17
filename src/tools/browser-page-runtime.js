export async function readPageState() {
  const { document, location } = /** @type {any} */ (globalThis);
  const clean = (value) =>
    String(value ?? "")
      .replace(/\s+/gu, " ")
      .trim();
  const text = (node) => clean(node?.innerText || node?.textContent);
  const body = text(document.body);
  return { url: location.href, title: document.title, text: body.slice(0, 100000) };
}

export const PAGE_STATE_SCRIPT = readPageState.toString();

export async function readResultsPage(input) {
  const { document, getComputedStyle, location } = /** @type {any} */ (globalThis);
  const platform = input.platform;
  const clean = (value) =>
    String(value ?? "")
      .replace(/\s+/gu, " ")
      .trim();
  const text = (node) => clean(node?.innerText || node?.textContent);
  const visible = (node) =>
    Boolean(
      node &&
      node.getClientRects().length &&
      getComputedStyle(node).visibility !== "hidden" &&
      getComputedStyle(node).display !== "none",
    );
  const firstMatch = (value, pattern) => String(value).match(pattern)?.[1] ?? null;
  const pick = (node, selector) => text(node.querySelector(selector));
  const unique = (items) => [...new Set(items.map(clean).filter(Boolean))];
  const HEADER_TOKENS =
    /达人信息|代表视频|搜索词相关视频|达人类型|内容主题|连接用户数|粉丝数|预期CPM|预期CPE|预期播放量|互动率|完播率|爆文率|\d+\s*[-–]\s*\d+s\s*报价|60s以上报价|1-20s报价|操作/gu;
  const headerColumns = (wrapper) => {
    const columns = wrapper
      ? [...(wrapper.querySelectorAll?.(":scope > .content-section > .content-column") ?? [])]
      : [];
    if (columns.length > 0) return columns.map(text);
    const flattened = clean(wrapper?.innerText ?? "");
    return flattened.match(HEADER_TOKENS) ?? [];
  };
  let header = [];
  let priceTier = null;
  let bodyWrapper = null;
  if (platform === "xingtu") {
    const wrappers = [...document.querySelectorAll(".base-author-list .section-wrapper")];
    const sticky = wrappers.find((node) => node.classList.contains("sticky-header")) ?? null;
    bodyWrapper = wrappers.find((node) => !node.classList.contains("sticky-header")) ?? null;
    header = headerColumns(sticky);
    const priceHeader = header.find((value) => /报价/u.test(value)) ?? "";
    priceTier =
      firstMatch(priceHeader, /(\d+\s*[-–]\s*\d+s|60s以上|1-20s)\s*报价/u) ??
      firstMatch(priceHeader, /(\d+\s*[-–]\s*\d+s|60s以上|1-20s)/u);
  } else {
    header = [...document.querySelectorAll("thead th,[role=columnheader]")]
      .filter(visible)
      .map(text)
      .filter(Boolean);
  }
  const named = (cells) => {
    const out = {};
    if (header.length !== cells.length) return out;
    header.forEach((name, index) => {
      if (name) out[name] = text(cells[index] ?? null);
    });
    return out;
  };
  const rowData = (cells, index, values) => {
    const primary = cells[0] ?? null;
    const raw = cells.map(text).filter(Boolean).join(" | ");
    const href =
      cells
        .flatMap((cell) =>
          cell ? [...cell.querySelectorAll("a[href]")].map((link) => link.href) : [],
        )
        .find((value) => /https?:/iu.test(value)) ?? null;
    const platformId =
      firstMatch(
        href || "",
        /[?&](?:authorId|creatorId|userId|kolId|bloggerId|id)=([^&#]{6,})/iu,
      ) ||
      firstMatch(
        href || "",
        /\/(?:user(?:\/profile)?|author|creator|kol|blogger)(?:\/detail)?\/([^/?#]{6,})/iu,
      ) ||
      firstMatch(href || "", /\/author-homepage\/douyin-video\/([^/?#]{6,})/iu) ||
      firstMatch(raw, /(?:抖音|小红书|平台)\s*(?:账号|ID)?\s*[：:]?\s*(\d{6,})/u) ||
      firstMatch(raw, /(?:^|\s)ID\s*[：:]?\s*(\d{6,})(?:\s|$)/u);
    const nickname =
      pick(primary, ".author-nickname,.user-name,.nickname,.kol-name,[class*=nickname]") ||
      clean(primary?.querySelector("a")?.innerText) ||
      clean(text(primary).split(/\n|\s{2,}/u)[0]);
    const primaryText = text(primary);
    const gender = firstMatch(primaryText, /(?:^|\s)(男|女)(?:\s|$)/u);
    const city = gender
      ? firstMatch(primaryText, /(?:男|女)\s+(.+)$/u)
      : pick(primary, "[class*=city],[class*=location]");
    const valueOf = (key) => values[key] ?? null;
    const followers =
      valueOf("粉丝数") || firstMatch(raw, /粉丝(?:数|量)?[^\d]{0,8}([\d.,]+\s*(?:万|w|W|k|K)?)/iu);
    const cpm =
      valueOf("预期CPM") ||
      firstMatch(raw, /(?:预期\s*)?CPM[^\d]{0,8}([\d.,]+\s*(?:万|w|W|k|K)?)/iu);
    const cpe =
      valueOf("预期CPE") ||
      firstMatch(raw, /(?:预期\s*)?CPE[^\d]{0,8}([\d.,]+\s*(?:万|w|W|k|K)?)/iu);
    const expectedViews =
      valueOf("预期播放量") ||
      firstMatch(raw, /预期(?:播放|阅读|曝光)[^\d]{0,8}([\d.,]+\s*(?:万|w|W|k|K)?)/iu);
    const interactionRate = valueOf("互动率") || firstMatch(raw, /互动率[^\d]{0,8}([\d.]+\s*%?)/iu);
    const price =
      Object.keys(values)
        .filter((key) => /报价/u.test(key))
        .map((key) => values[key])
        .find(Boolean) ??
      firstMatch(
        raw,
        /(?:60s以上|60s\+|21[-–]60s|报价|一口价|视频|图文)?[^\d¥￥]{0,12}[¥￥]\s*([\d.,]+\s*(?:万|w|W|k|K)?)/iu,
      ) ??
      firstMatch(raw, /(?:报价|一口价|视频|图文)[^\d]{0,12}([\d.,]+\s*(?:万|w|W|k|K)?)/iu);
    const tags = unique(
      cells.flatMap((cell) =>
        cell ? [...cell.querySelectorAll("[class*=tag],[role=tag]")].map(text) : [],
      ),
    ).filter((value) => value !== gender && value !== city);
    return {
      ordinal: index,
      platform_id: platformId,
      nickname,
      creator_gender: gender || pick(primary, "[class*=gender]") || null,
      city: city || null,
      followers_raw: followers,
      content_type: tags[0] ?? null,
      related_posts: firstMatch(raw, /(?:相关|匹配)[^\d]{0,8}(\d+)/u),
      format: priceTier || firstMatch(raw, /(60s以上|60s\+|21[-–]60s|图文|视频)/iu),
      price_raw: price,
      cpm_raw: cpm,
      cpe_raw: cpe,
      expected_views: expectedViews,
      interaction_rate: interactionRate,
      read_median:
        valueOf("阅读中位数") ||
        firstMatch(raw, /阅读(?:数)?中位数[^\d]{0,8}([\d.,]+\s*(?:万|w|W|k|K)?)/iu),
      interaction_median:
        valueOf("互动中位数") ||
        firstMatch(raw, /互动(?:数)?中位数[^\d]{0,8}([\d.,]+\s*(?:万|w|W|k|K)?)/iu),
      quote_fields: Object.fromEntries(
        Object.entries(values).filter(([key]) => /报价|CPM|CPE/iu.test(key)),
      ),
      column_values: values,
      tags,
      detail_url: href,
      source_url: location.href,
      raw_text: raw,
    };
  };
  let rows;
  if (platform === "xingtu") {
    const columnEls = bodyWrapper
      ? [...bodyWrapper.querySelectorAll(":scope > .content-section > .content-column")]
      : [];
    const columns = columnEls.map((column) => [
      ...column.querySelectorAll(":scope > .content-cell"),
    ]);
    const count = Math.max(0, ...columns.map((column) => column.length));
    rows = Array.from({ length: count }, (_, index) =>
      columns.map((column) => column[index] ?? null),
    )
      .filter((cells) =>
        Boolean(cells[0]?.querySelector?.(".author-nickname,.user-name,.nickname")),
      )
      .map((cells, index) => rowData(cells, index, named(cells)));
  } else {
    const selectors =
      "tbody tr:not(.filter-list-group),[role=row],[class*=creator-card],[class*=kol-card]";
    const candidates = [...document.querySelectorAll(selectors)]
      .filter(visible)
      .filter((node) => !node.closest?.("thead") && !node.querySelector?.(":scope > th"))
      .filter((node) => text(node).length > 10);
    rows = candidates
      .filter((node) => !node.parentElement?.closest(selectors))
      .map((node, index) => {
        const cells = [
          ...node.querySelectorAll(":scope > td,:scope > [role=cell],:scope > [role=gridcell]"),
        ];
        const rowCells = cells.length ? cells : [node];
        return rowData(rowCells, index, named(rowCells));
      });
  }
  return {
    url: location.href,
    price_tier: priceTier,
    rows,
  };
}

export const READ_RESULTS_SCRIPT = readResultsPage.toString();

export async function exportXingtuPage() {
  const { document, getComputedStyle } = /** @type {any} */ (globalThis);
  const clean = (value) =>
    String(value ?? "")
      .replace(/\s+/gu, " ")
      .trim();
  const visible = (node) =>
    Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
  const linksBefore = [...document.querySelectorAll("a[href]")]
    .map((node) => node.href)
    .filter((href) => /lark|feishu|sheets|bytedance/iu.test(href));
  const button = [...document.querySelectorAll("button,[role=button]")]
    .filter(visible)
    .find((node) => /^导出$/u.test(clean(node.innerText || node.textContent)));
  if (!button)
    return {
      ok: false,
      code: "YPSCAN_BROWSER_EXPORT_BUTTON_NOT_FOUND",
      message: "找不到星图导出按钮",
    };
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 220));
  const confirm = [...document.querySelectorAll("button,[role=button]")]
    .filter(visible)
    .find((node) => /^确定$/u.test(clean(node.innerText || node.textContent)));
  confirm?.click();
  const started = Date.now();
  while (Date.now() - started < 40000) {
    const links = [...document.querySelectorAll("a[href]")]
      .map((node) => node.href)
      .filter((href) => /lark|feishu|sheets|bytedance/iu.test(href));
    const fresh = links.find((href) => !linksBefore.includes(href));
    if (fresh) return { ok: true, kind: "lark_sheet", url: fresh };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    ok: false,
    code: "YPSCAN_BROWSER_EXPORT_PENDING",
    message: "星图已触发导出，但尚未出现新的飞书表格链接",
  };
}

export const XINGTU_EXPORT_SCRIPT = exportXingtuPage.toString();

export async function clickPgyExport() {
  const { document, getComputedStyle } = /** @type {any} */ (globalThis);
  const clean = (value) =>
    String(value ?? "")
      .replace(/\s+/gu, " ")
      .trim();
  const visible = (node) =>
    Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
  const button = [...document.querySelectorAll("button,[role=button]")]
    .filter(visible)
    .find((node) => /^(?:导出|下载)$/u.test(clean(node.innerText || node.textContent)));
  if (!button)
    return {
      ok: false,
      code: "YPSCAN_BROWSER_EXPORT_BUTTON_NOT_FOUND",
      message: "找不到蒲公英原生导出按钮",
    };
  button.click();
  return { ok: true };
}

export const PGY_EXPORT_CLICK_SCRIPT = clickPgyExport.toString();

export function expressionFor(script, input) {
  return `(${script})(${JSON.stringify(input ?? {})})`;
}
