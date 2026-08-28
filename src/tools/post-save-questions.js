export function businessModeQuestionPayload() {
  return {
    questions: [
      {
        header: "选择业务模式",
        question: "请选择本次需求的业务模式。选择后再进行需求解析和落库。",
        options: [
          { label: "询价机构", description: "搜索刊例数据、推荐机构并发起企微询价" },
          { label: "直接手扒", description: "通过后台 API 搜索、抓取并筛选达人" },
        ],
        multiSelect: false,
      },
    ],
  };
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
    return {
      questions: [
        {
          header: "选择询价机构",
          question: singleInstitution
            ? "当前仅有 1 家候选机构，请选择是否进入询价。"
            : "请选择本次需要询价的机构，可多选。",
          options,
          multiSelect: !singleInstitution,
        },
      ],
    };
  }
  return {
    questions: [
      {
        header: "询价机构提示",
        question: [
          `候选机构共 ${options.length} 家，超过单题最多 4 个选项。`,
          "完整机构名单已在弹窗前的 MCN 表格中展示。询价全部机构可直接选择；只询价部分机构时，请在自定义输入中填写表格编号或完整名称，可多选。",
        ].join("\n"),
        options: [
          { label: "询价全部机构", description: "选择本轮全部候选机构并进入字段选择" },
          { label: "暂不询价", description: "结束本次询价分支，不发送消息" },
        ],
        multiSelect: false,
      },
    ],
  };
}

export function submissionEnrichmentQuestionPayload() {
  return {
    questions: [
      {
        header: "达人信息",
        question: "提报表已生成并保存，是否要补充更新达人信息？",
        options: [
          {
            label: "补充更新达人信息",
            description: "立即调用 get_creator_detail 异步补全当前批次，不再选择字段或追问",
          },
          {
            label: "暂不补充",
            description: "保留当前提报表，结束本次处理",
          },
        ],
        multiSelect: false,
      },
    ],
  };
}
