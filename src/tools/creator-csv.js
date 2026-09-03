/**
 * @param {string} value
 */
export function parseCsv(value) {
  const text = String(value);
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = "";
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (char === '\r') {
      continue;
    }
    field += char;
  }

  if (quoted) {
    throw new TypeError("CSV 引号未闭合");
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) {
    return { headers: [], rows: [] };
  }

  const [headers, ...dataRows] = rows;
  const width = headers.length;
  return {
    headers,
    rows: dataRows
      .filter((columns) => columns.some((value) => value !== ""))
      .map((columns) => {
        const normalized = columns.slice(0, width);
        while (normalized.length < width) normalized.push("");
        return normalized;
      }),
  };
}

/**
 * @param {string[]} headers
 * @param {Record<string, string>[]} rows
 */
export function stringifyCsv(headers, rows) {
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [
    headers.map(escape).join(","),
    ...rows.map((row) => headers.map((header) => escape(row[header] ?? "")).join(",")),
  ].join("\n");
}

/**
 * @param {string[]} headers
 * @param {string[][]} rows
 */
export function rowsToObjects(headers, rows) {
  return rows.map((columns) =>
    Object.fromEntries(headers.map((header, index) => [header, columns[index] ?? ""])),
  );
}

/**
 * @param {string} header
 */
export function normalizeCsvHeader(header) {
  return String(header).trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

/**
 * @param {string[]} headers
 * @param {string[]} requiredHeaders
 */
export function findRequiredHeaders(headers, requiredHeaders) {
  const byNormalized = new Map(headers.map((header) => [normalizeCsvHeader(header), header]));
  const resolved = new Map();
  for (const requiredHeader of requiredHeaders) {
    const header = byNormalized.get(normalizeCsvHeader(requiredHeader));
    if (!header) return null;
    resolved.set(requiredHeader, header);
  }
  return resolved;
}

/**
 * @param {string[][] | Record<string, string>[]} rows
 */
export function countCsvDataRows(rows) {
  return rows.length;
}
