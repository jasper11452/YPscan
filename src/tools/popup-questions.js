export const MAX_POPUP_LINE_LENGTH = 20;

const POPUP_BREAK_AFTER = /[。！？；：，、…～）】》」』\s]/u;

function normalizePopupLineEndings(value) {
  return String(value).replace(/\r\n?/gu, "\n");
}

function isAsciiWordCharacter(character) {
  return character.length === 1 && /[A-Za-z0-9_]/u.test(character);
}

/**
 * Wrap one logical line into lines of at most MAX_POPUP_LINE_LENGTH
 * characters, preferring semantic break points: after punctuation or
 * whitespace, then at ASCII word boundaries, and only hard-splitting
 * when none exist.
 * @param {string} line
 */
function wrapSemanticLine(line) {
  const characters = [...line];
  if (characters.length === 0) return [""];
  const lines = [];
  let start = 0;
  while (characters.length - start > MAX_POPUP_LINE_LENGTH) {
    const windowEnd = start + MAX_POPUP_LINE_LENGTH;
    let breakAt = -1;
    let priority = 0;
    for (let index = windowEnd; index > start; index -= 1) {
      let score = 0;
      if (POPUP_BREAK_AFTER.test(characters[index - 1])) score = 3;
      else if (
        isAsciiWordCharacter(characters[index - 1]) !== isAsciiWordCharacter(characters[index])
      )
        score = 2;
      else if (!(
        isAsciiWordCharacter(characters[index - 1]) && isAsciiWordCharacter(characters[index])
      ))
        score = 1;
      if (score > priority) {
        priority = score;
        breakAt = index;
      }
    }
    if (breakAt < 0) breakAt = windowEnd;
    lines.push(characters.slice(start, breakAt).join(""));
    start = breakAt;
  }
  lines.push(characters.slice(start).join(""));
  return lines;
}

/**
 * Keep every visible popup line within the host dialog width, breaking at
 * semantic positions where possible.
 * @param {string} value
 */
export function wrapPopupText(value) {
  return normalizePopupLineEndings(value).split("\n").flatMap(wrapSemanticLine).join("\n");
}

function isValidPopupText(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\r") &&
    value.split("\n").every((line) => [...line].length <= MAX_POPUP_LINE_LENGTH)
  );
}

/** @param {unknown} value */
export function isPopupQuestionPayload(value) {
  if (!value || typeof value !== "object") return false;
  const payload = /** @type {Record<string, unknown>} */ (value);
  const questions = payload.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) return false;
  return questions.every((question) => {
    if (!question || typeof question !== "object") return false;
    if (
      !isValidPopupText(question.header) ||
      !isValidPopupText(question.question) ||
      typeof question.multiSelect !== "boolean" ||
      !Array.isArray(question.options) ||
      question.options.length < 2 ||
      question.options.length > 4
    ) {
      return false;
    }
    const labels = new Set();
    return question.options.every((option) => {
      if (!option || typeof option !== "object") return false;
      if (!isValidPopupText(option.label) || !isValidPopupText(option.description)) return false;
      const identity = option.label.replaceAll("\n", "");
      if (labels.has(identity)) return false;
      labels.add(identity);
      return true;
    });
  });
}

/**
 * @param {string} header
 * @param {string} question
 * @param {{label: string, description: string}[]} options
 * @param {boolean} [multiSelect]
 */
export function popupQuestionPayload(header, question, options, multiSelect = false) {
  const payload = {
    questions: [
      {
        header: wrapPopupText(header),
        question: wrapPopupText(question),
        options: options.map((option) => ({
          label: wrapPopupText(option.label),
          description: wrapPopupText(option.description),
        })),
        multiSelect,
      },
    ],
  };
  if (!isPopupQuestionPayload(payload)) {
    throw new TypeError("Invalid AskUserQuestion payload");
  }
  return payload;
}

export function businessModeQuestionPayload() {
  return popupQuestionPayload(
    "选择业务模式",
    "请选择本次需求的业务模式。选择后再进行需求解析和落库。",
    [
      { label: "询价机构", description: "搜索刊例数据、推荐机构并发起企微询价" },
      { label: "手动拓展", description: "通过后台 API 搜索、抓取并筛选达人" },
      { label: "只扒达人信息", description: "按达人 ID 或链接导出指定字段的达人表，不建需求不询价" },
    ],
  );
}

/** @param {string} stage */
export function flowRetryQuestionPayload(stage) {
  return popupQuestionPayload("悦普识星下一步", `${stage} 无法自动继续，请选择下一步。`, [
    { label: "重试", description: "按当前参数重试" },
    { label: "结束本次", description: "保留结果并结束" },
  ]);
}

export function ingestJobRecoveryQuestionPayload() {
  return popupQuestionPayload("异步入库任务", "机构入库请求已返回，但缺少任务 ID，请选择下一步。", [
    { label: "重试", description: "使用本轮 inquiry_ids 重新发起入库" },
    { label: "结束本次", description: "停止本次机构提报取回" },
  ]);
}

export function browserVerificationQuestionPayload() {
  return popupQuestionPayload(
    "Browser 验证",
    "当前平台需要登录或完成全局安全验证，请处理后继续。",
    [
      { label: "已处理，继续", description: "重新观察页面后继续当前手扒任务" },
      { label: "结束本次", description: "保留当前 checkpoint 并结束" },
    ],
  );
}

const RESERVED_RECIPIENT_LABELS = new Set(["询价全部机构", "暂不询价"]);

/** @param {unknown} names */
export function mcnRankingRecipientQuestionPayload(names) {
  if (!Array.isArray(names)) return null;
  const seen = new Set();
  const recipientNames = names.flatMap((name) => {
    if (typeof name !== "string") return [];
    const restored = normalizePopupLineEndings(name).replaceAll("\n", "").trim();
    if (!restored || seen.has(restored)) return [];
    seen.add(restored);
    return [restored];
  });
  if (recipientNames.length === 0) return null;
  const directOptions = recipientNames.slice(0, 2).map((name, index) => {
    const position = index + 1;
    if (RESERVED_RECIPIENT_LABELS.has(name)) {
      return {
        label: `表格第 ${position} 家`,
        description: `按 MCN 表格顺序选择第 ${position} 家机构`,
      };
    }
    return {
      label: name,
      description: "选择该机构作为本次询价收件人",
    };
  });
  const allInstitutionsOption = {
    label: "询价全部机构",
    description: "选择本轮全部候选机构并进入字段选择",
  };
  const skipInquiryOption = {
    label: "暂不询价",
    description: "本轮不发送，可按当前列表继续",
  };
  let question =
    "当前仅有 1 家候选机构；可直接选择当前机构。若需其他机构、榜单外机构或使用表格编号，请在自定义输入中填写完整名称或编号。";
  if (recipientNames.length === 2) {
    question =
      "请选择本次需要询价的机构；如需一次询价多家、补充榜单外机构或使用表格编号，请在自定义输入中填写完整名称或编号。";
  } else if (recipientNames.length > 2) {
    question = [
      `候选机构共 ${recipientNames.length} 家。`,
      "完整机构名单已在弹窗前的 MCN 表格中展示。",
      "可直接选择下方快捷选项；如需其他当前机构、一次询价多家、榜单外机构或使用表格编号，请在自定义输入中填写完整名称或编号。",
    ].join("\n");
  }
  return popupQuestionPayload(
    "选择询价机构",
    question,
    recipientNames.length > 2
      ? [allInstitutionsOption, ...directOptions, skipInquiryOption]
      : [...directOptions, allInstitutionsOption, skipInquiryOption],
  );
}

export function mcnCreatorCompletionQuestionPayload() {
  return popupQuestionPayload("回填后续", "机构回填预览表已就绪。是否补全已回填达人的信息并打分排序？", [
    {
      label: "补全并打分排序",
      description: "读取 Excel、派生 links CSV、原生补全、合并上传并打分",
    },
    {
      label: "暂不补全",
      description: "保留预览表并结束，其余机构可稍后处理",
    },
  ]);
}
