import { assertNoManualChallenge, cleanText, manualBrowserError } from "./common.js";
import { captureDetailResponsesDuring } from "./detail-response-capture.js";
import { candidateReference } from "../manual-research-detail.js";

const DETAIL_TABS = Object.freeze({
  pgy: {
    audience: [/粉丝画像/u, /粉丝分析/u, /人群画像/u],
    performance: [/数据表现/u, /笔记表现/u, /合作表现/u],
    growth: [/粉丝趋势/u, /涨粉趋势/u],
    recent_content: [/近期笔记/u, /笔记内容/u, /内容表现/u],
  },
  xingtu: {
    audience: [/粉丝画像/u, /受众画像/u, /观众画像/u],
    performance: [/数据表现/u, /合作数据/u, /商业能力/u],
    growth: [/粉丝趋势/u, /粉丝增长/u],
    recent_content: [/近期作品/u, /作品/u, /视频/u, /内容/u],
  },
});

const DETAIL_GROUP_HINTS = Object.freeze({
  audience: [/粉丝/u, /受众/u, /人群/u, /画像/u, /用户分析/u],
  performance: [/数据/u, /表现/u, /合作/u, /商业/u, /效果/u],
  growth: [/趋势/u, /增长/u, /涨粉/u],
  recent_content: [/近期/u, /作品/u, /笔记/u, /内容/u, /案例/u, /视频/u],
});

const DETAIL_GROUP_FIELDS = Object.freeze({
  audience: [
    "audience_male_rate_raw",
    "audience_female_rate_raw",
    "audience_age_18_23_rate_raw",
    "audience_age_24_30_rate_raw",
    "audience_age_31_40_rate_raw",
    "audience_cities",
    "audience_city_distribution",
    "audience_persona_distribution",
  ],
  performance: [
    "cpm_raw",
    "cpe_raw",
    "interaction_rate_raw",
    "expected_views_raw",
    "read_median_raw",
    "interaction_median_raw",
    "daily_read_median_raw",
    "daily_interaction_median_raw",
    "sponsored_read_median_raw",
    "sponsored_interaction_median_raw",
  ],
  growth: ["growth", "growth_rate_raw", "updated_at"],
  recent_content: ["recent_content"],
});

const DETAIL_CONTROL_SELECTOR = [
  "button:visible",
  "[role=tab]:visible",
  "[role=menuitem]:visible",
  "[role=option]:visible",
  "[aria-haspopup]:visible",
  "[aria-expanded]:visible",
  "[tabindex]:visible",
  ".el-tabs__item:visible",
  "[class*=tab-item]:visible",
  "[class*=nav-item]:visible",
  "[class*=menu-item]:visible",
  "a[href]:visible",
].join(",");
const DANGEROUS_DETAIL_ACTION = /提交|确认合作|立即合作|发送|支付|删除|下单|投放|邀约/u;
const DETAIL_ACTION_BUDGET = 6;

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function mergeFields(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (Array.isArray(value)) {
      const joined = [...(target[key] ?? []), ...value];
      target[key] = [...new Map(joined.map((item) => [JSON.stringify(item), item])).values()];
    } else if (value && typeof value === "object") {
      target[key] = { ...(target[key] ?? {}), ...value };
    } else if (target[key] === null || target[key] === undefined || target[key] === "") {
      target[key] = value;
    }
  }
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return clean(match[1]);
  }
  return null;
}

function xingtuIdFromDetailUrl(value) {
  return clean(value).match(/\/author-homepage\/douyin-video\/([^/?#]{6,})/iu)?.[1] ?? null;
}

function xingtuDetailRedirect(value, candidate) {
  try {
    const url = new URL(value);
    const redirect = url.searchParams.get("redirect_uri") ?? "";
    return (
      url.hostname === "www.xingtu.cn" &&
      url.pathname.replace(/\/+$/u, "") === "" &&
      redirect.includes(`/author-homepage/douyin-video/${clean(candidate.platform_id)}`)
    );
  } catch {
    return false;
  }
}

/** Follow Xingtu's authenticated landing redirect back to the requested creator detail. */
async function resolveXingtuDetailRedirect(page, candidate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const currentUrl = page.url?.() ?? "";
    if (xingtuDetailRedirect(currentUrl, candidate)) {
      const account = page
        .locator(".user-info:visible")
        .filter({ hasText: /ID\s*[:：]\s*\d+/u })
        .first();
      if (await account.isVisible().catch(() => false)) {
        await account.click();
        await page.waitForURL(/\/ad\/creator\//u, { timeout: 10_000 }).catch(() => {});
        if (xingtuIdFromDetailUrl(page.url?.() ?? "") === clean(candidate.platform_id)) return;
        await page.goto(candidate.detail_url, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        continue;
      }
    } else if (!xingtuIdFromDetailUrl(currentUrl)) {
      return;
    }
    await page.waitForTimeout(200);
  }
  if (xingtuDetailRedirect(page.url?.() ?? "", candidate)) {
    throw manualBrowserError(
      "YPSCAN_MANUAL_LOGIN_REQUIRED",
      "星图已跳转到详情登录落地页，请在当前 Browser 页面完成登录",
      { page_url: page.url?.() ?? "", candidate_ref: candidateReference(candidate) },
    );
  }
}

/** @param {import("playwright-core").Page} page */
async function readDetailDom(page, candidate, platform) {
  const body = cleanText(
    await page
      .locator("body")
      .innerText()
      .catch(() => ""),
  );
  const fields = {
    followers_raw: firstMatch(body, [
      /粉丝(?:数|量)?\s*[:：]?\s*([\d.,]+\s*[万wWkK亿]?)/u,
      /([\d.,]+\s*[万wWkK亿]?)\s*粉丝/u,
    ]),
    city: firstMatch(body, [/(?:所在地|所在地域|城市|地区)\s*[:：]?\s*([^\s|｜]{2,16})/u]),
    agency: firstMatch(body, [/(?:所属机构|MCN机构|机构)\s*[:：]?\s*([^\n|｜]{2,40})/u]),
    account_type: firstMatch(body, [/(?:账号类型|达人类型)\s*[:：]?\s*([^\n|｜]{2,40})/u]),
    cpm_raw: firstMatch(body, [/(?:预期\s*)?CPM\s*[:：¥￥]?\s*([\d.]+)/iu]),
    cpe_raw: firstMatch(body, [/(?:预期\s*)?CPE\s*[:：¥￥]?\s*([\d.]+)/iu]),
    interaction_rate_raw: firstMatch(body, [/(?:互动率|互动占比)\s*[:：]?\s*([\d.]+\s*%)/u]),
    expected_views_raw: firstMatch(body, [
      /(?:预期播放|预期阅读|预估阅读|平均播放)\s*[:：]?\s*([\d.]+\s*[万wWkK亿]?)/u,
    ]),
    audience_male_rate_raw: firstMatch(body, [/(?:男性|男)粉丝(?:占比)?\s*[:：]?\s*([\d.]+\s*%)/u]),
    audience_female_rate_raw: firstMatch(body, [
      /(?:女性|女)粉丝(?:占比)?\s*[:：]?\s*([\d.]+\s*%)/u,
    ]),
    read_median_raw: firstMatch(body, [
      /(?:阅读中位数|播放中位数)\s*[:：]?\s*([\d.]+\s*[万wWkK]?)/u,
    ]),
    interaction_median_raw: firstMatch(body, [/(?:互动中位数)\s*[:：]?\s*([\d.]+\s*[万wWkK]?)/u]),
    updated_at: firstMatch(body, [/(?:数据更新至|更新时间)\s*[:：]?\s*([\d./-]{6,20})/u]),
  };
  const priceByTier = {};
  const pricePatterns =
    platform === "pgy"
      ? [
          ["图文", /图文(?:笔记)?(?:报价|一口价)?\s*[:：¥￥]?\s*([\d.,]+\s*万?)/u],
          ["视频", /视频(?:笔记)?(?:报价|一口价)?\s*[:：¥￥]?\s*([\d.,]+\s*万?)/u],
        ]
      : [
          ["植入视频", /植入视频(?:报价)?\s*[:：¥￥]?\s*([\d.,]+\s*万?)/u],
          ["定制视频", /定制视频(?:报价)?\s*[:：¥￥]?\s*([\d.,]+\s*万?)/u],
        ];
  for (const [tier, pattern] of pricePatterns) {
    const value = firstMatch(body, [pattern]);
    if (value) priceByTier[tier] = value;
  }
  if (priceByTier.图文) fields.price_picture_raw = priceByTier.图文;
  if (priceByTier.视频) fields.price_video_raw = priceByTier.视频;
  if (Object.keys(priceByTier).length) fields.price_by_tier = priceByTier;

  const recentContent = await page
    .locator("a[href]:visible")
    .evaluateAll((links) =>
      links
        .map((link) => ({
          title: String(link.textContent ?? "")
            .replace(/\s+/gu, " ")
            .trim(),
          url: /** @type {HTMLAnchorElement} */ (link).href,
        }))
        .filter(
          (item) =>
            item.title.length >= 4 &&
            /note|video|content|item|douyin|xiaohongshu/iu.test(item.url) &&
            !/达人清单|用户协议|隐私政策|帮助中心|联系我们/u.test(item.title) &&
            !/author-lists|user-agreement|privacy|author-homepage/iu.test(item.url),
        )
        .slice(0, 3),
    )
    .catch(() => []);
  const videoCards = recentContent.length
    ? []
    : await page
        .locator(".content-video-card:visible")
        .evaluateAll((cards) =>
          cards
            .map((card) => {
              const title = String(card.querySelector(".title")?.textContent ?? "")
                .replace(/\s+/gu, " ")
                .trim();
              const metrics = [...card.querySelectorAll(".data-value")].map((item) =>
                String(item.textContent ?? "").trim(),
              );
              return {
                title,
                url: null,
                views: metrics[0] || null,
                interactions: metrics[1] || null,
              };
            })
            .filter((item) => item.title.length >= 4)
            .slice(0, 3),
        )
        .catch(() => []);
  if (recentContent.length || videoCards.length) {
    fields.recent_content = recentContent.length ? recentContent : videoCards;
  }
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) =>
      Array.isArray(value)
        ? value.length > 0
        : value !== null && value !== undefined && value !== "",
    ),
  );
}

async function waitForInitialDetailFields(page, candidate, platform, groups, timeoutMs = 8_000) {
  const fields = {};
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    mergeFields(fields, await readDetailDom(page, candidate, platform));
    const passiveGroupsReady = groups
      .filter((group) => ["summary", "recent_content"].includes(group))
      .every((group) => groupHasCompleteEvidence(group, fields));
    if (groupHasCompleteEvidence("summary", fields) && passiveGroupsReady) break;
    await page.waitForTimeout(200);
  }
  return fields;
}

/** @param {import("playwright-core").Page} page */
async function clickFirstText(page, patterns) {
  for (const pattern of patterns) {
    const target = page.getByText(pattern).filter({ visible: true }).first();
    if (!(await target.isVisible().catch(() => false))) continue;
    await target.scrollIntoViewIfNeeded().catch(() => {});
    if (
      await target.click({ timeout: 2_000 }).then(
        () => true,
        () => false,
      )
    )
      return true;
  }
  return false;
}

function groupHasEvidence(group, fields) {
  return (DETAIL_GROUP_FIELDS[group] ?? []).some((key) => {
    const value = fields[key];
    return Array.isArray(value)
      ? value.length > 0
      : value !== null && value !== undefined && value !== "";
  });
}

function groupHasCompleteEvidence(group, fields) {
  return group === "summary" ? Object.keys(fields).length > 0 : groupHasEvidence(group, fields);
}

export function detailGroupHasEvidence(group, fields) {
  return groupHasEvidence(group, fields);
}

/** @param {import("playwright-core").Page} page */
async function visibleDetailControls(page) {
  return page
    .locator(DETAIL_CONTROL_SELECTOR)
    .evaluateAll((elements) =>
      elements.slice(0, 120).map((element, index) => ({
        index,
        text: String(
          element.getAttribute("aria-label") ??
            element.textContent ??
            element.getAttribute("title") ??
            "",
        )
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 80),
        role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
        expanded: element.getAttribute("aria-expanded"),
        has_popup: element.getAttribute("aria-haspopup"),
      })),
    )
    .catch(() => []);
}

function rankedDetailControls(controls, group, attempted) {
  const hints = DETAIL_GROUP_HINTS[group] ?? [];
  return controls
    .map((control) => {
      const identity = `${control.role}|${control.text}`;
      if (!control.text || attempted.has(identity) || DANGEROUS_DETAIL_ACTION.test(control.text)) {
        return null;
      }
      const semantic = hints.reduce(
        (score, pattern) => score + Number(pattern.test(control.text)),
        0,
      );
      if (!semantic) return null;
      return {
        ...control,
        identity,
        score:
          semantic * 10 +
          Number(control.role === "tab") * 3 +
          Number(Boolean(control.has_popup)) * 2 +
          Number(control.expanded === "false"),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
}

/**
 * Explore only visible, semantically relevant detail controls. Re-inspecting after every
 * action lets nested/teleported menus participate without relying on platform selectors.
 *
 * @param {import("playwright-core").Page} page
 * @param {"xingtu"|"pgy"} platform
 * @param {any} candidate
 * @param {string} group
 * @param {Set<string>} learnedPaths
 */
async function exploreDetailGroup(page, platform, candidate, group, learnedPaths) {
  const attempted = new Set();
  const actions = [];
  const fields = {};
  const endpoints = [];
  const sourceTypes = [];
  let reason = "no_matching_control";
  let observedControls = [];

  for (let actionNumber = 0; actionNumber < DETAIL_ACTION_BUDGET; actionNumber += 1) {
    const controls = await visibleDetailControls(page);
    observedControls = controls;
    const target = rankedDetailControls(controls, group, attempted)[0];
    if (!target) break;
    attempted.add(target.identity);
    const locator = page.locator(DETAIL_CONTROL_SELECTOR).nth(target.index);
    const before = cleanText(
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    const beforeControls = JSON.stringify(controls);
    const observed = await captureDetailResponsesDuring(page, {
      platform,
      candidate,
      expectedGroups: [group],
      learnedPaths,
      action: async () => {
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        if (target.has_popup && target.expanded !== "true") {
          await locator.hover({ timeout: 2_000 }).catch(() => {});
        }
        return locator.click({ timeout: 2_000 }).then(
          () => true,
          () => false,
        );
      },
    });
    if (observed.capture) {
      mergeFields(fields, observed.capture.fields);
      endpoints.push(...observed.capture.endpoints);
      sourceTypes.push(observed.capture.source_type);
    }
    const domFields = await readDetailDom(page, candidate, platform);
    mergeFields(fields, domFields);
    if (Object.keys(domFields).length) sourceTypes.push("dom");
    const after = cleanText(
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    const afterControls = JSON.stringify(await visibleDetailControls(page));
    const changed =
      before !== after || beforeControls !== afterControls || Boolean(observed.capture);
    actions.push({
      action: target.has_popup ? "hover_click" : "click",
      control: target.text,
      role: target.role,
      changed,
    });
    if (groupHasEvidence(group, fields)) {
      reason = null;
      break;
    }
    reason = changed ? "target_fields_missing" : "control_had_no_effect";
  }

  return {
    fields,
    endpoints: [...new Set(endpoints)],
    source_types: [...new Set(sourceTypes)],
    actions,
    reason,
    observed_controls: observedControls
      .filter((control) => control.text)
      .slice(0, 12)
      .map(({ text, role }) => ({ text, role })),
  };
}

/** @param {import("playwright-core").Page} listPage */
async function clickCandidateFromList(listPage, platform, candidate) {
  const selector =
    platform === "pgy" ? "tbody tr:visible" : ".base-author-list .content-cell:visible";
  const rows = listPage.locator(selector);
  const count = await rows.count().catch(() => 0);
  const identity = clean(candidate.platform_id);
  const nickname = clean(candidate.nickname);
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const text = clean(await row.innerText().catch(() => ""));
    if (!(identity && text.includes(identity)) && !(nickname && text.includes(nickname))) continue;
    const nicknameTarget = row
      .locator(".author-nickname,.user-name,.nickname,[class*=nickname]")
      .filter({ visible: true })
      .first();
    const avatarTarget = row.locator("img:visible,[class*=avatar]:visible").first();
    const detailLink = row.locator("a[href*='author-homepage']:visible").first();
    const target = (await detailLink.isVisible().catch(() => false))
      ? detailLink
      : (await nicknameTarget.isVisible().catch(() => false))
        ? nicknameTarget
        : (await avatarTarget.isVisible().catch(() => false))
          ? avatarTarget
          : platform === "pgy"
            ? row
            : null;
    if (!target) return false;
    await target.scrollIntoViewIfNeeded();
    await target.click({ timeout: 3_000 });
    return true;
  }
  return false;
}

async function openDetail(listPage, platform, candidate, groups, learnedPaths) {
  const context = typeof listPage.context === "function" ? listPage.context() : null;
  let detailPage = listPage;
  let temporary = false;
  const beforePages = context?.pages?.() ?? [listPage];
  const observed = await captureDetailResponsesDuring(listPage, {
    platform,
    candidate,
    expectedGroups: groups,
    learnedPaths,
    settleMs: 8_000,
    action: async () => {
      if (candidate.detail_url && context?.newPage) {
        detailPage = await context.newPage();
        temporary = true;
        await detailPage.goto(candidate.detail_url, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        if (platform === "xingtu") await resolveXingtuDetailRedirect(detailPage, candidate);
        return true;
      }
      const popupPromise = context?.waitForEvent
        ? context.waitForEvent("page", { timeout: 8_000 }).catch(() => null)
        : null;
      const beforeUrl = listPage.url?.() ?? "";
      const clicked = await clickCandidateFromList(listPage, platform, candidate);
      if (!clicked) return false;
      const awaitedPopup = popupPromise ? await popupPromise : null;
      const afterPages = context?.pages?.() ?? [listPage];
      const popup = awaitedPopup ?? afterPages.find((page) => !beforePages.includes(page));
      if (popup) {
        detailPage = popup;
        temporary = true;
        await detailPage.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
      } else if ((listPage.url?.() ?? "") === beforeUrl) {
        return false;
      }
      return true;
    },
  });
  if (!observed.action_result) {
    return { opened: false, detailPage, temporary, capture: observed.capture };
  }
  return { opened: true, detailPage, temporary, capture: observed.capture };
}

/** Open one persisted candidate without automatically closing the resulting detail page. */
export async function openCreatorDetailPage(
  listPage,
  platform,
  candidate,
  { groups = [], learnedPaths = new Set() } = {},
) {
  return openDetail(listPage, platform, candidate, groups, learnedPaths);
}

/** Read only the evidence currently visible on an already-open detail page. */
export async function readCreatorDetailSnapshot(page, platform, candidate) {
  const body = await assertNoManualChallenge(page);
  if (platform === "pgy" && /选择合作品牌|请先选择品牌|选择品牌后查看|暂无权限查看/u.test(body)) {
    return { status: "blocked", reason: "detail_not_accessible", fields: {} };
  }
  const fields = await readDetailDom(page, candidate, platform);
  const detailUrl = page.url?.() ?? candidate.detail_url ?? null;
  const detailPlatformId =
    platform === "xingtu" ? xingtuIdFromDetailUrl(detailUrl) : (candidate.platform_id ?? null);
  if (
    platform === "xingtu" &&
    candidate.platform_id &&
    detailPlatformId &&
    clean(candidate.platform_id) !== clean(detailPlatformId)
  ) {
    return { status: "blocked", reason: "detail_identity_mismatch", fields: {} };
  }
  return {
    status: Object.keys(fields).length ? "captured" : "empty",
    reason: Object.keys(fields).length ? null : "visible_fields_missing",
    platform_id: detailPlatformId ?? candidate.platform_id ?? null,
    detail_url: detailUrl,
    fields,
  };
}

/** Activate one semantic detail section and return the evidence produced by that action. */
export async function activateCreatorDetailSection(
  page,
  platform,
  candidate,
  group,
  { learnedPaths = new Set() } = {},
) {
  const patterns = DETAIL_TABS[platform]?.[group] ?? [];
  if (!patterns.length) {
    return { applied: false, reason: "detail_section_not_supported", group, fields: {} };
  }
  const observed = await captureDetailResponsesDuring(page, {
    platform,
    candidate,
    expectedGroups: [group],
    learnedPaths,
    action: () => clickFirstText(page, patterns),
  });
  const fields = {};
  if (observed.capture?.fields) mergeFields(fields, observed.capture.fields);
  mergeFields(fields, await readDetailDom(page, candidate, platform));
  return {
    applied: Boolean(observed.action_result),
    reason: observed.action_result ? null : "detail_section_target_not_found",
    group,
    verified: groupHasEvidence(group, fields),
    fields,
    response_endpoints: observed.capture?.endpoints ?? [],
    source_type: observed.capture?.source_type ?? (Object.keys(fields).length ? "dom" : null),
  };
}

async function closeDetail(listPage, detailPage, temporary) {
  if (temporary && detailPage !== listPage) {
    await detailPage.close().catch(() => {});
    return;
  }
  if (detailPage !== listPage) return;
  await listPage.goBack({ waitUntil: "domcontentloaded", timeout: 8_000 }).catch(() => {});
}

/**
 * @param {import("playwright-core").Page} listPage
 * @param {"xingtu"|"pgy"} platform
 * @param {any} candidate
 * @param {{groups: string[], learnedPaths?: Set<string>, capturedAt: string}} options
 */
export async function collectCreatorDetail(
  listPage,
  platform,
  candidate,
  { groups, learnedPaths = new Set(), capturedAt },
) {
  const base = {
    candidate_ref: candidateReference(candidate),
    platform_id: candidate.platform_id ?? null,
    nickname: candidate.nickname ?? null,
    detail_url: candidate.detail_url ?? null,
    captured_at: capturedAt,
  };
  const opened = await openDetail(listPage, platform, candidate, groups, learnedPaths);
  if (!opened.opened) {
    return { ...base, status: "blocked", reason: "detail_not_accessible", fields: {} };
  }
  const detailPage = opened.detailPage;
  const fields = {};
  const endpoints = [];
  const sourceTypes = [];
  const completedGroups = new Set();
  const navigation = [];
  if (opened.capture) {
    mergeFields(fields, opened.capture.fields);
    endpoints.push(...opened.capture.endpoints);
    sourceTypes.push(opened.capture.source_type);
    for (const group of opened.capture.groups ?? []) completedGroups.add(group);
  }
  try {
    const initialBody = cleanText(
      await detailPage
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    if (
      platform === "pgy" &&
      /选择合作品牌|请先选择品牌|选择品牌后查看|暂无权限查看/u.test(initialBody)
    ) {
      return { ...base, status: "blocked", reason: "detail_not_accessible", fields: {} };
    }
    mergeFields(fields, await waitForInitialDetailFields(detailPage, candidate, platform, groups));
    try {
      await assertNoManualChallenge(detailPage);
    } catch (error) {
      if (/CAPTCHA|DETAIL_RISK/u.test(error?.code ?? "") && Object.keys(fields).length) {
        const completed = groups.filter((group) => groupHasCompleteEvidence(group, fields));
        const missing = groups.filter((group) => !completed.includes(group));
        error.details = {
          ...(error.details ?? {}),
          captured_detail: {
            ...base,
            status: missing.length ? "partial" : "complete",
            reason: missing.length ? "manual_challenge" : "manual_challenge_after_capture",
            fields,
            completed_groups: completed,
            missing_groups: missing,
            response_endpoints: [...new Set(endpoints)],
            source_type: [...new Set(sourceTypes)].join("+") || "dom",
          },
        };
      }
      throw error;
    }
    for (const group of groups.filter((item) => item !== "summary")) {
      if (groupHasEvidence(group, fields)) {
        completedGroups.add(group);
        continue;
      }
      const patterns = DETAIL_TABS[platform][group] ?? [];
      const observed = await captureDetailResponsesDuring(detailPage, {
        platform,
        candidate,
        expectedGroups: [group],
        learnedPaths,
        action: () => clickFirstText(detailPage, patterns),
      });
      if (observed.capture) {
        mergeFields(fields, observed.capture.fields);
        endpoints.push(...observed.capture.endpoints);
        sourceTypes.push(observed.capture.source_type);
      }
      const initialDomFields = await readDetailDom(detailPage, candidate, platform);
      mergeFields(fields, initialDomFields);
      if (Object.keys(initialDomFields).length) sourceTypes.push("dom");
      if (!groupHasEvidence(group, fields)) {
        const explored = await exploreDetailGroup(
          detailPage,
          platform,
          candidate,
          group,
          learnedPaths,
        );
        mergeFields(fields, explored.fields);
        endpoints.push(...explored.endpoints);
        sourceTypes.push(...explored.source_types);
        navigation.push({
          group,
          actions: explored.actions,
          reason: explored.reason,
          observed_controls: explored.observed_controls,
        });
      }
      if (groupHasEvidence(group, fields)) completedGroups.add(group);
    }
    const domFields = await readDetailDom(detailPage, candidate, platform);
    if (Object.keys(domFields).length) {
      mergeFields(fields, domFields);
      sourceTypes.push("dom");
    }
    const detailUrl = detailPage.url?.() ?? candidate.detail_url ?? null;
    const detailPlatformId =
      platform === "xingtu" ? xingtuIdFromDetailUrl(detailUrl) : (candidate.platform_id ?? null);
    if (
      platform === "xingtu" &&
      candidate.platform_id &&
      detailPlatformId &&
      clean(candidate.platform_id) !== clean(detailPlatformId)
    ) {
      return {
        ...base,
        status: "blocked",
        reason: "detail_identity_mismatch",
        fields: {},
      };
    }
    if (Object.keys(fields).length) completedGroups.add("summary");
    const requestedGroups = [...new Set(groups)];
    const missingGroups = requestedGroups.filter((group) => !completedGroups.has(group));
    return {
      ...base,
      platform_id: detailPlatformId ?? candidate.platform_id ?? null,
      detail_url: detailUrl,
      status: Object.keys(fields).length && !missingGroups.length ? "complete" : "partial",
      reason: missingGroups.length ? "detail_groups_missing" : null,
      fields,
      completed_groups: [...completedGroups].filter((group) => requestedGroups.includes(group)),
      missing_groups: missingGroups,
      navigation,
      response_endpoints: [...new Set(endpoints)],
      source_type: [...new Set(sourceTypes)].join("+") || "dom",
    };
  } catch (error) {
    if (/CAPTCHA|DETAIL_RISK/u.test(error?.code ?? "")) throw error;
    throw manualBrowserError("YPSCAN_MANUAL_DETAIL_FAILED", error?.message ?? "详情页采集失败", {
      candidate_ref: base.candidate_ref,
    });
  } finally {
    await closeDetail(listPage, detailPage, opened.temporary);
  }
}
