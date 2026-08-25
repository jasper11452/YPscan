import { manualBrowserError } from "./common.js";

const PGY_DETAIL_PATTERNS = Object.freeze([
  { pattern: /\/api\/solar\/kol\/dataV3\/dataSummary(?:[/?#]|$)/iu, group: "summary" },
  { pattern: /\/api\/solar\/kol\/dataV3\/fansSummary(?:[/?#]|$)/iu, group: "audience" },
  { pattern: /\/api\/solar\/kol\/dataV3\/notesRate(?:[/?#]|$)/iu, group: "performance" },
  {
    pattern: /\/api\/solar\/kol\/data\/[^/]+\/fans_overall_new_history(?:[/?#]|$)/iu,
    group: "growth",
  },
]);

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
  "id",
];

const FIELD_ALIASES = Object.freeze({
  platform_id: ID_ALIASES,
  nickname: ["nickName", "nick_name", "nickname", "authorName", "bloggerName", "name"],
  followers_raw: [
    "followers",
    "followerCount",
    "follower_count",
    "fansNum",
    "fans_num",
    "fansNumber",
    "fans_number",
    "fansCount",
  ],
  city: ["city", "location", "province", "authorCity", "author_city"],
  agency: ["agency", "agencyName", "agency_name", "mcnName", "mcn_name"],
  account_type: ["accountType", "account_type", "authorType", "author_type", "kolType"],
  content_type: ["contentType", "content_type", "authorCategory", "author_category", "category"],
  price_picture_raw: ["picturePrice", "picture_price", "picPrice", "pic_price", "notePrice"],
  price_video_raw: ["videoPrice", "video_price", "taskPrice", "task_price"],
  cpm_raw: ["expectedCpm", "expected_cpm", "estimateAllCpm", "estimate_all_cpm", "cpm"],
  cpe_raw: ["expectedCpe", "expected_cpe", "estimateEngageCost", "estimate_engage_cost", "cpe"],
  interaction_rate_raw: [
    "interactionRate",
    "interaction_rate",
    "interactRate",
    "interact_rate",
    "personalInterateRate",
  ],
  expected_views_raw: ["expectedPlay", "expected_play", "expectedViews", "avgPlay", "avgRead"],
  read_median_raw: ["readMedian", "read_median", "readMidNor30", "read_mid_nor_30"],
  interaction_median_raw: [
    "interactionMedian",
    "interaction_median",
    "interMidNor30",
    "inter_mid_nor_30",
  ],
  daily_read_median_raw: ["normalReadMedian", "dailyReadMedian", "naturalReadMedian"],
  daily_interaction_median_raw: [
    "normalInteractionMedian",
    "dailyInteractionMedian",
    "naturalInteractionMedian",
  ],
  sponsored_read_median_raw: ["businessReadMedian", "cooperationReadMedian", "adReadMedian"],
  sponsored_interaction_median_raw: [
    "businessInteractionMedian",
    "cooperationInteractionMedian",
    "adInteractionMedian",
  ],
  audience_male_rate_raw: ["maleRate", "male_rate", "maleFansRate", "male_fans_rate"],
  audience_female_rate_raw: ["femaleRate", "female_rate", "femaleFansRate", "female_fans_rate"],
  audience_age_18_23_rate_raw: ["age1823Rate", "age_18_23_rate", "fansAge1823Rate"],
  audience_age_24_30_rate_raw: ["age2430Rate", "age_24_30_rate", "fansAge2430Rate"],
  audience_age_31_40_rate_raw: ["age3140Rate", "age_31_40_rate", "fansAge3140Rate"],
  discovery_rate_raw: ["discoveryRate", "discoverRate", "recommendSourceRate"],
  search_rate_raw: ["searchRate", "searchSourceRate"],
  updated_at: ["updateTime", "updatedAt", "updated_at", "dataUpdateTime", "statDate"],
});

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedKey(value) {
  return clean(value)
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

function scalar(value) {
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (!value || typeof value !== "object") return null;
  for (const key of ["displayValue", "display_value", "value", "text", "name", "rate"]) {
    if (["string", "number", "boolean"].includes(typeof value[key])) return value[key];
  }
  return null;
}

function valueBag(source) {
  const bag = new Map();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 7) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) {
        if (item && typeof item === "object") {
          const name = item.field ?? item.key ?? item.metric ?? item.label ?? item.name;
          const itemValue = scalar(
            item.value ?? item.fieldValue ?? item.displayValue ?? item.rate ?? item,
          );
          if (name && itemValue !== null && !bag.has(normalizedKey(name))) {
            bag.set(normalizedKey(name), itemValue);
          }
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

function pick(bag, aliases) {
  for (const alias of aliases) {
    const value = bag.get(normalizedKey(alias));
    if (value !== null && value !== undefined && clean(value)) return value;
  }
  return null;
}

function safePath(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return null;
  }
}

function samePlatformHost(value, platform) {
  try {
    const host = new URL(value).hostname;
    return platform === "pgy" ? host === "pgy.xiaohongshu.com" : host.endsWith("xingtu.cn");
  } catch {
    return false;
  }
}

function pgyGroup(value) {
  return PGY_DETAIL_PATTERNS.find(({ pattern }) => pattern.test(value))?.group ?? null;
}

function candidateIdentityMatches(payload, url, candidate, requestBody = "") {
  const expected = clean(candidate?.platform_id);
  if (!expected) return Boolean(candidate?.detail_url && url.startsWith(candidate.detail_url));
  if (clean(requestBody).includes(expected)) return true;
  try {
    const parsed = new URL(url);
    if ([...parsed.searchParams.values()].some((value) => clean(value) === expected)) return true;
    if (parsed.pathname.split("/").some((value) => clean(value) === expected)) return true;
  } catch {
    // Ignore malformed response URLs and rely on the payload.
  }
  const bag = valueBag(payload);
  return ID_ALIASES.some((alias) => clean(bag.get(normalizedKey(alias))) === expected);
}

function sourcePageMatchesCandidate(sourcePageUrl, candidate) {
  const expected = clean(candidate?.platform_id);
  return Boolean(expected && clean(sourcePageUrl).includes(expected));
}

function capturedFields(captures) {
  const fields = {};
  for (const capture of captures) mergeFields(fields, capture.fields);
  return fields;
}

function expectedEvidenceCaptured(captures, expectedGroups) {
  const fields = capturedFields(captures);
  return expectedGroups.every((group) => {
    if (group === "recent_content") return Boolean(fields.recent_content?.length);
    if (group === "audience") return Object.keys(fields).some((key) => key.startsWith("audience_"));
    if (group === "performance") {
      return Object.keys(fields).some((key) =>
        /^(?:cpm|cpe|interaction|expected_views|read_median|interaction_median)/u.test(key),
      );
    }
    if (group === "growth") return Boolean(fields.updated_at);
    return Object.keys(fields).some(
      (key) => !["platform_id", "nickname", "tags", "recent_content"].includes(key),
    );
  });
}

function detailLikelihood(bag) {
  const aliases = Object.values(FIELD_ALIASES).flat();
  return aliases.reduce((score, alias) => score + Number(bag.has(normalizedKey(alias))), 0);
}

function priceByTier(bag) {
  const result = {};
  for (const [key, value] of bag.entries()) {
    if (!/(?:price|quote|quotation|报价)/iu.test(key) || !clean(value)) continue;
    let tier = null;
    if (/placement|implant|植入/iu.test(key)) tier = "植入视频";
    else if (/custom|定制/iu.test(key)) tier = "定制视频";
    else if (/picture|pic|image|图文/iu.test(key)) tier = "图文";
    else if (/video|视频/iu.test(key)) tier = "视频";
    if (tier && result[tier] === undefined) result[tier] = value;
  }
  return result;
}

function tagsFromPayload(payload) {
  const values = [];
  const visit = (value, key = "", depth = 0) => {
    if (!value || typeof value !== "object" || depth > 5) return;
    if (Array.isArray(value)) {
      if (/(?:tag|label|category|persona)/iu.test(key)) {
        for (const item of value.slice(0, 30)) {
          const itemValue = scalar(item);
          if (itemValue !== null) values.push(clean(itemValue));
        }
      }
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
  };
  visit(payload);
  return [...new Set(values.filter(Boolean))].slice(0, 20);
}

function recentContentFromPayload(payload) {
  const found = [];
  const visit = (value, key = "", depth = 0) => {
    if (!value || typeof value !== "object" || depth > 6 || found.length >= 12) return;
    if (Array.isArray(value)) {
      if (/(?:note|content|work|video|item|post)/iu.test(key)) {
        for (const item of value.slice(0, 20)) {
          if (!item || typeof item !== "object") continue;
          const bag = valueBag(item);
          const title = pick(bag, [
            "title",
            "noteTitle",
            "contentTitle",
            "videoTitle",
            "itemTitle",
            "item_title",
            "videoDesc",
            "video_desc",
            "awemeDesc",
            "aweme_desc",
            "desc",
          ]);
          if (!clean(title)) continue;
          found.push({
            title: clean(title),
            url:
              clean(
                pick(bag, [
                  "url",
                  "noteUrl",
                  "contentUrl",
                  "videoUrl",
                  "itemUrl",
                  "shareUrl",
                  "playUrl",
                ]),
              ) || null,
            published_at:
              clean(pick(bag, ["publishTime", "publishedAt", "createTime", "date"])) || null,
            views: pick(bag, ["viewCount", "readCount", "playCount", "views"]),
            interactions: pick(bag, ["interactionCount", "engagement", "likeCount"]),
          });
        }
      }
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
  };
  visit(payload);
  const seen = new Set();
  return found
    .filter((item) => {
      const identity = `${item.title}|${item.url ?? ""}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .slice(0, 3);
}

function labeledDistribution(payload, pathPattern) {
  const found = [];
  const visit = (value, path = "", depth = 0) => {
    if (!value || typeof value !== "object" || depth > 7) return;
    if (Array.isArray(value)) {
      if (pathPattern.test(path)) {
        for (const item of value.slice(0, 50)) {
          if (!item || typeof item !== "object") continue;
          const bag = valueBag(item);
          const label = pick(bag, ["label", "name", "title", "type", "category", "city"]);
          const rate = pick(bag, ["rate", "ratio", "proportion", "percent", "percentage", "value"]);
          if (clean(label) && rate !== null) found.push({ name: clean(label), rate_raw: rate });
        }
      }
      for (const item of value) visit(item, path, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  visit(payload);
  return [
    ...new Map(found.map((item) => [`${item.name}|${clean(item.rate_raw)}`, item])).values(),
  ].slice(0, 20);
}

function audienceCities(payload) {
  const cities = [];
  const visit = (value, key = "", depth = 0) => {
    if (!value || typeof value !== "object" || depth > 6) return;
    if (Array.isArray(value) && /city|region|location/iu.test(key)) {
      for (const item of value.slice(0, 20)) {
        const bag = valueBag(item);
        const name = scalar(item) ?? pick(bag, ["city", "name", "label", "region"]);
        if (clean(name)) cities.push(clean(name));
      }
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
  };
  visit(payload);
  return [...new Set(cities)].slice(0, 10);
}

export function normalizeDetailResponse(payload) {
  const bag = valueBag(payload);
  const fields = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const value = pick(bag, aliases);
    if (value !== null && (field !== "agency" || typeof value === "string")) {
      fields[field] = value;
    }
  }
  const tierPrices = priceByTier(bag);
  if (Object.keys(tierPrices).length) fields.price_by_tier = tierPrices;
  const tags = tagsFromPayload(payload);
  if (tags.length) fields.tags = tags;
  const recentContent = recentContentFromPayload(payload);
  if (recentContent.length) fields.recent_content = recentContent;
  const cities = audienceCities(payload);
  if (cities.length) fields.audience_cities = cities;
  const genderDistribution = labeledDistribution(payload, /gender|sex|性别/iu);
  const male = genderDistribution.find((item) => /^(?:男|男性|male)$/iu.test(item.name));
  const female = genderDistribution.find((item) => /^(?:女|女性|female)$/iu.test(item.name));
  if (male && fields.audience_male_rate_raw === undefined) {
    fields.audience_male_rate_raw = male.rate_raw;
  }
  if (female && fields.audience_female_rate_raw === undefined) {
    fields.audience_female_rate_raw = female.rate_raw;
  }
  const cityDistribution = labeledDistribution(payload, /city|region|location|城市|地域/iu);
  if (cityDistribution.length) fields.audience_city_distribution = cityDistribution;
  const personaDistribution = labeledDistribution(
    payload,
    /persona|crowd|occupation|profession|人群|画像|职业/iu,
  );
  if (personaDistribution.length) fields.audience_persona_distribution = personaDistribution;
  return { fields, likelihood: Math.max(detailLikelihood(bag), Object.keys(fields).length) };
}

function mergeFields(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (Array.isArray(value)) {
      target[key] = [
        ...new Map(
          [...(target[key] ?? []), ...value].map((item) => [JSON.stringify(item), item]),
        ).values(),
      ];
    } else if (value && typeof value === "object") {
      target[key] = { ...(target[key] ?? {}), ...value };
    } else if (target[key] === null || target[key] === undefined || target[key] === "") {
      target[key] = value;
    }
  }
}

/**
 * Observe only XHR/fetch responses emitted by one real detail-page action.
 * The browser remains responsible for authentication, cookies and signatures.
 *
 * @param {import("playwright-core").Page} page
 * @param {{platform: "xingtu"|"pgy", candidate: any, expectedGroups: string[], learnedPaths?: Set<string>, settleMs?: number, action: () => Promise<any>}} options
 */
export async function captureDetailResponsesDuring(
  page,
  { platform, candidate, expectedGroups, learnedPaths = new Set(), settleMs = 1_200, action },
) {
  const captures = [];
  const pending = new Set();
  let risk = null;
  const eventSource = typeof page.context === "function" ? page.context() : page;
  const listener = (response) => {
    const url = response.url();
    if (!samePlatformHost(url, platform)) return;
    const request = response.request();
    if (!request || !["xhr", "fetch"].includes(request.resourceType())) return;
    const path = safePath(url);
    const knownPgyGroup = platform === "pgy" ? pgyGroup(url) : null;
    const learned = path && learnedPaths.has(path);
    const requestBody = request.postData?.() ?? "";
    const sourcePageUrl = request.frame?.().page?.().url?.() ?? "";
    const requestMatchesCandidate = candidateIdentityMatches(null, url, candidate, requestBody);
    const sourcePageMatches = sourcePageMatchesCandidate(sourcePageUrl, candidate);
    if (platform === "pgy" && !knownPgyGroup) return;
    if (
      [401, 403, 429].includes(response.status()) &&
      (knownPgyGroup || requestMatchesCandidate || (learned && sourcePageMatches))
    ) {
      risk = { status: response.status(), path };
      return;
    }
    const contentType = response.headers()["content-type"] ?? "";
    if (contentType && !/json/iu.test(contentType)) return;
    const job = response
      .json()
      .then((payload) => {
        const group = knownPgyGroup ?? expectedGroups[0] ?? "summary";
        if (!expectedGroups.includes(group) && platform === "pgy") return;
        const normalized = normalizeDetailResponse(payload);
        const payloadMatchesCandidate = candidateIdentityMatches(
          payload,
          url,
          candidate,
          requestBody,
        );
        const pageBoundEvidence =
          sourcePageMatches &&
          (Boolean(knownPgyGroup) || learned || Boolean(normalized.fields.recent_content?.length));
        if (!payloadMatchesCandidate && !pageBoundEvidence) return;
        if (platform === "xingtu" && !learned && !pageBoundEvidence && normalized.likelihood < 2) {
          return;
        }
        if (!Object.keys(normalized.fields).length) return;
        if (platform === "xingtu" && path) learnedPaths.add(path);
        captures.push({ group, endpoint: path, fields: normalized.fields });
      })
      .catch(() => {});
    pending.add(job);
    void job.finally(() => pending.delete(job));
  };
  eventSource.on("response", listener);
  let actionResult;
  try {
    actionResult = await action();
    const attempts = Math.max(1, Math.ceil(settleMs / 50));
    for (let attempt = 0; attempt < attempts && !risk; attempt += 1) {
      if (pending.size) await Promise.allSettled([...pending]);
      if (expectedEvidenceCaptured(captures, expectedGroups)) break;
      await page.waitForTimeout(50);
    }
    if (pending.size) await Promise.allSettled([...pending]);
  } finally {
    eventSource.off("response", listener);
  }
  if (risk) {
    throw manualBrowserError("YPSCAN_MANUAL_DETAIL_RISK_SIGNAL", "详情请求触发平台访问限制", risk);
  }
  const fields = {};
  const endpoints = [];
  const groups = [];
  for (const capture of captures) {
    mergeFields(fields, capture.fields);
    if (capture.endpoint) endpoints.push(capture.endpoint);
    groups.push(capture.group);
  }
  return {
    action_result: actionResult,
    capture: captures.length
      ? {
          fields,
          endpoints: [...new Set(endpoints)],
          groups: [...new Set(groups)],
          source_type: "browser_response",
        }
      : null,
  };
}
