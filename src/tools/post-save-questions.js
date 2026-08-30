export const MAX_POPUP_LINE_LENGTH = 20;

const POPUP_BREAK_AFTER = /[。！？；：，、…～）】》」』\s]/u;

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
        isAsciiWordCharacter(characters[index - 1]) !==
        isAsciiWordCharacter(characters[index])
      ) score = 2;
      else if (
        !(
          isAsciiWordCharacter(characters[index - 1]) &&
          isAsciiWordCharacter(characters[index])
        )
      ) score = 1;
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
  return String(value)
    .split("\n")
    .flatMap(wrapSemanticLine)
    .join("\n");
}

/**
 * @param {string} header
 * @param {string} question
 * @param {{label: string, description: string}[]} options
 * @param {boolean} [multiSelect]
 */
export function popupQuestionPayload(header, question, options, multiSelect = false) {
  return {
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
}

export function businessModeQuestionPayload() {
  return popupQuestionPayload(
    "选择业务模式",
    "请选择本次需求的业务模式。选择后再进行需求解析和落库。",
    [
      { label: "询价机构", description: "搜索刊例数据、推荐机构并发起企微询价" },
      { label: "直接手扒", description: "通过后台 API 搜索、抓取并筛选达人" },
    ],
  );
}

export function mcnRankingRecipientQuestionPayload(names) {
  const singleInstitution = names.length === 1;
  const options = names.map((name) => ({
    label: name,
    description: "选择该机构作为本次询价收件人",
  }));
  if (options.length === 1) {
    options.push({ label: "暂不询价", description: "结束本次询价分支，不发送消息" });
  }
  if (options.length <= 4) {
    return popupQuestionPayload(
      "选择询价机构",
      singleInstitution
        ? "当前仅有 1 家候选机构，请选择是否进入询价。"
        : "请选择本次需要询价的机构，可多选。",
      options,
      !singleInstitution,
    );
  }
  return popupQuestionPayload(
    "选择询价机构",
    [
      `候选机构共 ${options.length} 家。`,
      "完整机构名单已在弹窗前的 MCN 表格中展示。",
      "询价全部机构可直接选择；只询价部分机构时，请在自定义输入中填写表格编号或完整名称，可多选。",
    ].join("\n"),
    [
      { label: "询价全部机构", description: "选择本轮全部候选机构并进入字段选择" },
      { label: "暂不询价", description: "结束本次询价分支，不发送消息" },
    ],
  );
}

export function submissionEnrichmentQuestionPayload() {
  return popupQuestionPayload(
    "达人信息",
    "提报表已生成并保存，是否要补充更新达人信息？",
    [
      {
        label: "补充更新达人信息",
        description: "立即调用 get_creator_detail 异步补全当前批次，不再选择字段或追问",
      },
      {
        label: "暂不补充",
        description: "保留当前提报表，结束本次处理",
      },
    ],
  );
}
