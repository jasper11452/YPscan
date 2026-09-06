import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";

const xml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

export function previewFixture(workspaceDir, { rows, name = "preview.xlsx" } = {}) {
  const data = rows ?? [
    ["机构原始回填，未核验"],
    [],
    ["项目", "测试需求"],
    ["基础数据"],
    [
      "平台",
      "蒲公英ID",
      "小红书ID",
      "昵称",
      "返点",
      "粉丝数（万）",
      "小红书主页",
      "所属机构",
      "视频笔记一口价",
    ],
    [
      "小红书",
      "000000000000000000000001",
      "display-1",
      "达人甲",
      "25%",
      "3.84",
      "https://www.xiaohongshu.com/user/profile/000000000000000000000001",
      "机构甲",
      "1500",
    ],
    [
      "小红书",
      "000000000000000000000002",
      "display-2",
      "达人乙",
      "25%",
      "69.13",
      "https://www.xiaohongshu.com/user/profile/000000000000000000000002",
      "机构乙",
      "108000",
    ],
    [
      "小红书",
      "000000000000000000000003",
      "display-3",
      "达人丙",
      "25%",
      "155.66",
      "https://www.xiaohongshu.com/user/profile/000000000000000000000003",
      "机构丙",
      "168000",
    ],
  ];
  const sheetData = data
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row
          .map((value, c) => {
            const address = `${String.fromCharCode(65 + c)}${r + 1}`;
            if (value && typeof value === "object" && "number" in value)
              return `<c r="${address}" t="n"><v>${xml(value.number)}</v></c>`;
            return `<c r="${address}" t="inlineStr">${value == null ? "" : `<is><t>${xml(value)}</t></is>`}</c>`;
          })
          .join("")}</row>`,
    )
    .join("");
  const entries = {
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    "xl/workbook.xml":
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="原始回填" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`,
  };
  const buffer = Buffer.from(
    zipSync(
      Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, strToU8(value)])),
    ),
  );
  const filePath = join(workspaceDir, name);
  writeFileSync(filePath, buffer);
  return { file_path: filePath, sha256: createHash("sha256").update(buffer).digest("hex"), buffer };
}
