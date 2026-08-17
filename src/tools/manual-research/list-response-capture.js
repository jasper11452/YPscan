const LIST_URL_PATTERNS = Object.freeze({
  pgy: [/\/api\/solar\/cooperator\/blogger\/v2(?:[/?#]|$)/iu],
  xingtu: [
    /\/gw\/api\/gsearch\/search_for_author_square(?:[/?#]|$)/iu,
    /author[_/-]?(?:list|search)/iu,
    /creator[_/-]?(?:list|search)/iu,
    /(?:list|search)[_/-]?(?:author|creator)/iu,
    /creator\/market/iu,
  ],
});

const ID_ALIASES = [
  "authorId",
  "author_id",
  "oAuthorId",
  "o_author_id",
  "starId",
  "star_id",
  "kolId",
  "kol_id",
  "bloggerId",
  "blogger_id",
  "userId",
  "user_id",
  "uniqueId",
  "unique_id",
  "id",
];
const NAME_ALIASES = [
  "nickName",
  "nick_name",
  "nickname",
  "authorName",
  "author_name",
  "bloggerName",
  "blogger_name",
  "userName",
  "user_name",
  "name",
];

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedKey(value) {
  return String(value ?? "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

function scalar(value) {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value !== "object") return null;
  for (const key of ["displayValue", "display_value", "value", "text", "name"]) {
    if (["string", "number", "boolean"].includes(typeof value[key])) return value[key];
  }
  return null;
}

/** @param {Record<string, any>} source */
function valueBag(source) {
  /** @type {Map<string, any>} */
  const bag = new Map();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 5) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) {
        if (item && typeof item === "object") {
          const fieldName = item.field ?? item.key ?? item.name ?? item.metric;
          const fieldValue = scalar(
            item.value ?? item.fieldValue ?? item.field_value ?? item.displayValue ?? item,
          );
          if (fieldName && fieldValue !== null) bag.set(normalizedKey(fieldName), fieldValue);
        }
        visit(item, depth + 1);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const childScalar = scalar(child);
      if (childScalar !== null && !bag.has(normalizedKey(key))) {
        bag.set(normalizedKey(key), childScalar);
      }
      if (child && typeof child === "object") visit(child, depth + 1);
    }
  };
  visit(source);
  return bag;
}

/** @param {Map<string, any>} bag */
function pick(bag, aliases) {
  for (const alias of aliases) {
    const value = bag.get(normalizedKey(alias));
    if (value !== null && value !== undefined && clean(value)) return value;
  }
  return null;
}

/** @param {Map<string, any>} bag */
function matchingFields(bag, pattern) {
  return Object.fromEntries(
    [...bag.entries()].filter(([key, value]) => pattern.test(key) && clean(value)).slice(0, 20),
  );
}

function normalizeUrl(value) {
  const cleanValue = clean(value);
  if (!cleanValue) return null;
  try {
    return new URL(cleanValue).href;
  } catch {
    return null;
  }
}

/**
 * Convert a creator-list response row to the same shape used by DOM collection.
 * This intentionally keeps only public list fields and never returns cookies,
 * request headers or the raw response object.
 *
 * @param {Record<string, any>} source
 * @param {"xingtu"|"pgy"} platform
 */
export function normalizeListResponseRow(source, platform) {
  const bag = valueBag(source);
  const quoteFields = matchingFields(bag, /price|quote|quotation|cpm|cpe|报价|阅读单价|互动成本/iu);
  const tagsValue = source.tags ?? source.contentTags ?? source.content_tags ?? source.personalTags;
  const tags = Array.isArray(tagsValue)
    ? tagsValue
        .map((value) => scalar(value))
        .map(clean)
        .filter(Boolean)
    : [];
  const detailUrl = normalizeUrl(
    pick(bag, [
      "detailUrl",
      "detail_url",
      "authorUrl",
      "author_url",
      "homePage",
      "homepage",
      "profileUrl",
      "profile_url",
      "url",
    ]),
  );
  const picturePrice = pick(bag, [
    "picturePrice",
    "picture_price",
    "picPrice",
    "pic_price",
    "notePrice",
    "note_price",
  ]);
  const videoPrice = pick(bag, ["videoPrice", "video_price", "taskPrice", "task_price", "price"]);
  return {
    platform_id: clean(pick(bag, ID_ALIASES)) || null,
    nickname: clean(pick(bag, NAME_ALIASES)) || null,
    detail_url: detailUrl,
    followers_raw:
      clean(
        pick(bag, [
          "follower",
          "followers",
          "followerCount",
          "follower_count",
          "fansNum",
          "fans_num",
          "fansNumber",
          "fans_number",
          "fansCount",
          "fans_count",
        ]),
      ) || null,
    price_raw:
      clean(platform === "pgy" ? (picturePrice ?? videoPrice) : (videoPrice ?? picturePrice)) ||
      null,
    cpm_raw:
      clean(
        pick(bag, ["expectedCpm", "expected_cpm", "estimateAllCpm", "estimate_all_cpm", "cpm"]),
      ) || null,
    cpe_raw:
      clean(
        pick(bag, [
          "expectedCpe",
          "expected_cpe",
          "estimateEngageCost",
          "estimate_engage_cost",
          "cpe",
        ]),
      ) || null,
    interaction_rate:
      clean(
        pick(bag, [
          "interactionRate",
          "interaction_rate",
          "interactRate",
          "interact_rate",
          "personalInterateRate",
          "personal_interate_rate",
        ]),
      ) || null,
    expected_views:
      clean(
        pick(bag, [
          "expectedPlay",
          "expected_play",
          "expectedViews",
          "expected_views",
          "avgPlay",
          "avg_play",
        ]),
      ) || null,
    creator_gender: clean(pick(bag, ["gender", "sex", "creatorGender", "creator_gender"])) || null,
    city: clean(pick(bag, ["city", "location", "province"])) || null,
    content_type:
      clean(pick(bag, ["contentType", "content_type", "noteType", "note_type"])) || null,
    read_median:
      clean(pick(bag, ["readMedian", "read_median", "readMidNor30", "read_mid_nor_30"])) || null,
    interaction_median:
      clean(
        pick(bag, ["interactionMedian", "interaction_median", "interMidNor30", "inter_mid_nor_30"]),
      ) || null,
    quote_fields: quoteFields,
    tags,
  };
}

function knownList(payload, platform) {
  const data = payload?.data;
  if (platform === "pgy" && Array.isArray(data?.kols)) {
    return { rows: data.kols, total: data.total ?? null, path: "data.kols" };
  }
  if (platform === "xingtu" && Array.isArray(payload?.authors)) {
    return {
      rows: payload.authors,
      total: payload?.pagination?.total_count ?? null,
      path: "authors",
    };
  }
  for (const [rows, total, path] of [
    [data?.authors, data?.pagination?.total_count ?? data?.total, "data.authors"],
    [data?.authorList, data?.total, "data.authorList"],
    [data?.author_list, data?.total, "data.author_list"],
    [data?.creators, data?.total, "data.creators"],
    [data?.creatorList, data?.total, "data.creatorList"],
    [data?.creator_list, data?.total, "data.creator_list"],
    [data?.kols, data?.total, "data.kols"],
  ]) {
    if (Array.isArray(rows)) return { rows, total: total ?? null, path };
  }
  return null;
}

function creatorLikelihood(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const bag = valueBag(value);
  const hasId = Boolean(pick(bag, ID_ALIASES));
  const hasName = Boolean(pick(bag, NAME_ALIASES));
  const hasMetric = Boolean(
    pick(bag, ["follower", "followers", "fansNum", "fansNumber", "videoPrice", "notePrice"]),
  );
  return Number(hasId) * 2 + Number(hasName) * 2 + Number(hasMetric);
}

function genericList(payload) {
  const found = [];
  const visit = (value, path = "", depth = 0) => {
    if (!value || typeof value !== "object" || depth > 6) return;
    if (Array.isArray(value)) {
      const objects = value.filter((item) => item && typeof item === "object");
      if (objects.length) {
        const score = objects.slice(0, 10).reduce((sum, item) => sum + creatorLikelihood(item), 0);
        if (score >= Math.min(objects.length, 10) * 3) found.push({ rows: value, score, path });
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  visit(payload);
  found.sort((left, right) => right.score - left.score || right.rows.length - left.rows.length);
  const best = found[0];
  if (!best) return null;
  const total = payload?.data?.total ?? payload?.data?.pagination?.total_count ?? null;
  return { rows: best.rows, total, path: best.path };
}

/**
 * @param {any} payload
 * @param {"xingtu"|"pgy"} platform
 */
export function extractListResponse(payload, platform) {
  const extracted = knownList(payload, platform) ?? genericList(payload);
  if (!extracted) return null;
  const rows = extracted.rows
    .map((row) => normalizeListResponseRow(row, platform))
    .filter((row) => row.platform_id || row.nickname);
  if (!rows.length) return null;
  const total = Number(extracted.total);
  return {
    rows,
    total: Number.isFinite(total) ? total : null,
    response_path: extracted.path,
  };
}

function requestPageNumber(request, url) {
  let data;
  try {
    data = request.postDataJSON();
  } catch {
    try {
      data = JSON.parse(request.postData() ?? "null");
    } catch {
      data = null;
    }
  }
  for (const key of ["pageNum", "page_num", "page", "pageIndex", "page_index"]) {
    const value = Number(data?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  try {
    const parsed = new URL(url);
    for (const key of ["pageNum", "page_num", "page", "pageIndex", "page_index"]) {
      const value = Number(parsed.searchParams.get(key));
      if (Number.isFinite(value) && value > 0) return value;
    }
  } catch {
    // The response URL is always expected to be absolute; ignore malformed URLs.
  }
  return null;
}

function safeEndpoint(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function matchesListUrl(value, platform) {
  return LIST_URL_PATTERNS[platform].some((pattern) => pattern.test(value));
}

/**
 * Observe only the browser's own XHR/fetch responses produced by one UI action.
 * The browser keeps responsibility for authentication and signatures.
 *
 * @param {import("playwright-core").Page} page
 * @param {"xingtu"|"pgy"} platform
 * @param {() => Promise<any>} action
 */
export async function captureListResponseDuring(page, platform, action) {
  const captures = [];
  const pending = new Set();
  const listener = (response) => {
    const url = response.url();
    if (!matchesListUrl(url, platform)) return;
    const request = response.request();
    if (!["xhr", "fetch"].includes(request.resourceType())) return;
    const contentType = response.headers()["content-type"] ?? "";
    if (contentType && !/json/iu.test(contentType)) return;
    const job = response
      .json()
      .then((payload) => extractListResponse(payload, platform))
      .then((extracted) => {
        if (!extracted) return;
        captures.push({
          ...extracted,
          page_number: requestPageNumber(request, url),
          endpoint: safeEndpoint(url),
        });
      })
      .catch(() => {});
    pending.add(job);
    void job.finally(() => pending.delete(job));
  };
  page.on("response", listener);
  let actionResult;
  try {
    actionResult = await action();
    const started = Date.now();
    while (!captures.length && Date.now() - started < 800) {
      if (pending.size) await Promise.allSettled([...pending]);
      if (!captures.length) await page.waitForTimeout(50);
    }
    if (pending.size) await Promise.allSettled([...pending]);
  } finally {
    page.off("response", listener);
  }
  captures.sort((left, right) => right.rows.length - left.rows.length);
  return { action_result: actionResult, capture: captures[0] ?? null };
}

function nonEmptyEntries(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ""),
  );
}

/** Merge stable network identities with the formatted values visible in the table. */
export function mergeCapturedAndDomRows(capturedRows, domRows) {
  if (!capturedRows?.length) return domRows ?? [];
  const remaining = [...(domRows ?? [])];
  return capturedRows.map((networkRow, index) => {
    const nickname = clean(networkRow.nickname);
    const matchingIndex = remaining.findIndex(
      (row) => nickname && clean(row.nickname) === nickname,
    );
    const domIndex = matchingIndex >= 0 ? matchingIndex : index < remaining.length ? index : -1;
    const domRow = domIndex >= 0 ? remaining.splice(domIndex, 1)[0] : null;
    return {
      ...nonEmptyEntries(networkRow),
      ...(domRow ? nonEmptyEntries(domRow) : {}),
      platform_id: networkRow.platform_id ?? domRow?.platform_id ?? null,
      nickname: networkRow.nickname ?? domRow?.nickname ?? null,
      detail_url: networkRow.detail_url ?? domRow?.detail_url ?? null,
      city: networkRow.city ?? domRow?.city ?? null,
      quote_fields: {
        ...(networkRow.quote_fields ?? {}),
        ...(domRow?.quote_fields ?? {}),
      },
      tags: [...new Set([...(networkRow.tags ?? []), ...(domRow?.tags ?? [])])],
    };
  });
}
