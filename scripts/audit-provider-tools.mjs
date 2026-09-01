/** Live Provider MCP metadata audit for stability-risk review. */

const PROVIDER_URL = process.env.YPSCAN_PROVIDER_URL ?? "https://mcp.eshypdata.com/mcp";
const ACCEPT = "application/json, text/event-stream";

async function postJsonRpc(method, params, id) {
  const response = await fetch(PROVIDER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: ACCEPT,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

  const body = await response.text();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

function parseSseJson(body) {
  const match = body.match(/data: (\{.*\})/su);
  if (!match) {
    throw new Error(`Unable to parse MCP SSE payload: ${body.slice(0, 400)}`);
  }
  return JSON.parse(match[1]);
}

function propertyKind(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "invalid";
  if (typeof spec.type === "string") return spec.type;
  if (Array.isArray(spec.type)) return spec.type.join("|");
  if (Array.isArray(spec.anyOf)) {
    return spec.anyOf
      .map((item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          if (typeof item.type === "string") return item.type;
          if (Array.isArray(item.type)) return item.type.join("|");
        }
        return "unknown";
      })
      .join(" | ");
  }
  if (Array.isArray(spec.enum)) return `enum(${spec.enum.join(",")})`;
  return "unspecified";
}

function analyzeTool(tool) {
  const schema = tool.inputSchema ?? {};
  const properties = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const issues = [];

  if (!(typeof tool.description === "string" && tool.description.trim())) {
    issues.push({ severity: "high", code: "missing_description", detail: "工具缺少 description" });
  }
  if (schema.type !== "object") {
    issues.push({
      severity: "high",
      code: "schema_not_object",
      detail: `inputSchema.type=${JSON.stringify(schema.type)}`,
    });
  }
  if (!Object.hasOwn(schema, "additionalProperties")) {
    issues.push({
      severity: "medium",
      code: "additional_properties_unspecified",
      detail: "inputSchema 未显式声明 additionalProperties",
    });
  }

  for (const field of required) {
    if (!Object.hasOwn(properties, field)) {
      issues.push({
        severity: "high",
        code: "required_field_missing_in_properties",
        detail: `required 字段 ${field} 未出现在 properties`,
      });
    }
  }

  for (const [field, spec] of Object.entries(properties)) {
    const kind = propertyKind(spec);
    if (kind === "invalid") {
      issues.push({
        severity: "high",
        code: "invalid_property_schema",
        detail: `${field} 的 schema 不是对象`,
      });
      continue;
    }
    if (kind === "unspecified") {
      issues.push({
        severity: "high",
        code: "property_type_unspecified",
        detail: `${field} 未声明 type / anyOf / enum`,
      });
    }
  }

  return {
    name: tool.name,
    descriptionPresent: typeof tool.description === "string" && tool.description.trim().length > 0,
    requiredCount: required.length,
    propertyCount: Object.keys(properties).length,
    issues,
  };
}

const initializeResponse = await postJsonRpc(
  "initialize",
  {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "ypscan-provider-audit", version: "0.1.0" },
  },
  1,
);
const initializePayload = parseSseJson(initializeResponse.body);

const listResponse = await postJsonRpc("tools/list", {}, 2);
const listPayload = parseSseJson(listResponse.body);
const tools = listPayload.result?.tools ?? [];
const summary = tools.map(analyzeTool);
const issueCounts = summary.reduce(
  (accumulator, tool) => {
    for (const issue of tool.issues) {
      accumulator.total += 1;
      accumulator.bySeverity[issue.severity] = (accumulator.bySeverity[issue.severity] ?? 0) + 1;
      accumulator.byCode[issue.code] = (accumulator.byCode[issue.code] ?? 0) + 1;
    }
    return accumulator;
  },
  { total: 0, bySeverity: {}, byCode: {} },
);

const report = {
  providerUrl: PROVIDER_URL,
  inspectedAt: new Date().toISOString(),
  serverInfo: initializePayload.result?.serverInfo ?? null,
  initializeStatus: initializeResponse.status,
  toolsListStatus: listResponse.status,
  toolCount: tools.length,
  issueCounts,
  tools: summary,
};

console.log(JSON.stringify(report, null, 2));
