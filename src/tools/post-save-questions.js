export function mcnRankingBranchQuestionPayload(empty) {
  const options = empty
    ? [
        { label: "人工拓展并提报", description: "推荐使用后台默认手扒并直接生成 Excel" },
        { label: "结束本次", description: "保留机构表格的空结果并结束本次流程" },
      ]
    : [
        { label: "询价机构", description: "先选择具体机构，再配置询价字段" },
        { label: "人工拓展并提报", description: "推荐使用后台默认手扒并直接生成 Excel" },
      ];
  return {
    questions: [
      {
        header: "悦普识星下一步",
        question: [
          "机构排序已完成。",
          `机构明细：${empty ? "弹窗打开前已展示的“暂无匹配机构”Markdown 表格" : "弹窗打开前已在对话中完整展示"}`,
          "MCN 排名表本地文件路径：请以弹窗前展示的保存结果为准",
          "请选择下一步。",
        ].join("\n"),
        options,
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
