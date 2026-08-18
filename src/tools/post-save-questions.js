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
