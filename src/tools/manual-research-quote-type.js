function clean(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function quoteTypeError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

export function normalizeManualQuoteType(platform, raw) {
  const value = clean(raw).toLowerCase();
  if (!value) return null;
  if (platform === "xingtu") {
    if (/^(?:植入|植入视频|placement)$/u.test(value)) return "植入视频";
    if (/^(?:定制|定制视频|custom)$/u.test(value)) return "定制视频";
    return null;
  }
  if (/^(?:图文|图文笔记|picture|image)$/u.test(value)) return "图文";
  if (/^(?:视频|视频笔记|video)$/u.test(value)) return "视频";
  return null;
}

function factText(fact) {
  return clean(
    [fact?.quote, fact?.source?.quote, fact?.source, fact?.value, fact?.normalized_value]
      .flat()
      .filter((value) => typeof value !== "object")
      .join(" "),
  );
}

function xingtuFactEvidence(fact) {
  if (fact?.kind !== "creator_price") return { supported: [], unsupported: [] };
  let text = factText(fact);
  const unsupported = text.match(/短直种草|定制短剧(?:单集)?|直播报价|图文报价/gu) ?? [];
  text = text
    .replace(/(?:不要|不做|不选|不接受|排除|非)\s*(?:植入视频|植入)/gu, "")
    .replace(/(?:不要|不做|不选|不接受|排除|非)\s*(?:定制视频|定制)/gu, "");
  const supported = [];
  if (/植入视频|植入报价|植入/u.test(text)) supported.push("植入视频");
  if (/定制视频|定制报价|定制/u.test(text)) supported.push("定制视频");
  return { supported, unsupported };
}

function pgyFactEvidence(fact) {
  if (fact?.kind !== "creator_price") return [];
  const qualifier = clean(fact.qualifier).toLowerCase();
  if (["picture", "image"].includes(qualifier)) return ["图文"];
  if (qualifier === "video") return ["视频"];
  const text = factText(fact);
  const supported = [];
  if (/图文(?:笔记)?(?:报价|一口价|价格)|图文价/u.test(text)) supported.push("图文");
  if (/视频(?:笔记)?(?:报价|一口价|价格)|视频价/u.test(text)) supported.push("视频");
  return supported;
}

function contentFormatFallback(facts) {
  const text = facts
    .filter((fact) => fact?.kind === "content_format")
    .map(factText)
    .join(" ");
  if (/图文|图片|picture|image/iu.test(text)) return "图文";
  if (/视频|video/iu.test(text)) return "视频";
  return null;
}

/** Resolve one Browser quote type without changing Provider duration qualifiers. */
export function resolveManualQuoteType({ platform, facts = [], quoteType = null }) {
  const creatorPriceFacts = facts.filter((fact) => fact?.kind === "creator_price");
  const requested = clean(quoteType);
  const parameterType = normalizeManualQuoteType(platform, requested);
  if (requested && !parameterType) {
    throw quoteTypeError(
      "YPSCAN_MANUAL_QUOTE_TYPE_UNSUPPORTED",
      `当前${platform === "xingtu" ? "星图" : "蒲公英"}手扒不支持报价类型：${requested}`,
      { quote_type: requested },
    );
  }

  let factTypes;
  if (platform === "xingtu") {
    const evidence = creatorPriceFacts.map(xingtuFactEvidence);
    const unsupported = [...new Set(evidence.flatMap((item) => item.unsupported))];
    if (unsupported.length) {
      throw quoteTypeError(
        "YPSCAN_MANUAL_QUOTE_TYPE_UNSUPPORTED",
        `当前星图手扒仅支持植入视频或定制视频；原需求包含：${unsupported.join("、")}`,
        { unsupported_quote_types: unsupported },
      );
    }
    factTypes = evidence.flatMap((item) => item.supported);
  } else {
    factTypes = creatorPriceFacts.flatMap(pgyFactEvidence);
  }

  const uniqueFactTypes = [...new Set(factTypes)];
  const explicitTypes = [...new Set([...uniqueFactTypes, parameterType].filter(Boolean))];
  if (explicitTypes.length > 1) {
    throw quoteTypeError(
      "YPSCAN_MANUAL_QUOTE_TYPE_CONFLICT",
      `单次手扒只能使用一种报价类型：${explicitTypes.join("、")}`,
      { quote_types: explicitTypes },
    );
  }
  if (explicitTypes.length) {
    return {
      price_view: explicitTypes[0],
      source: uniqueFactTypes.length ? "fact" : "explicit_param",
    };
  }
  if (!creatorPriceFacts.length) return { price_view: null, source: "none" };
  if (platform === "xingtu") return { price_view: "植入视频", source: "platform_default" };
  const fallback = contentFormatFallback(facts);
  return fallback
    ? { price_view: fallback, source: "content_format_fallback" }
    : { price_view: null, source: "none" };
}
