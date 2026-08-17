export function submissionEnrichmentQuestionPayload() {
  return {
    questions: [
      {
        header: "达人信息",
        question: "提报表已生成并保存，是否要补充更新达人信息？",
        options: [
          {
            label: "补充更新达人信息",
            description: "使用当前批次和字段补齐达人信息，并导出新版提报表",
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
