/**
 * A CSV reader.
 *
 * Both B6 exports hold quoted fields with line breaks inside them: Riya's emails
 * are multi-paragraph, and splitting on newlines turns one 48-word email into
 * five rows of nonsense. That rules out the one-line `split(',')` version, so
 * this is a small state machine over quotes instead.
 *
 * It handles what those files contain and nothing more: a header row, `""` as an
 * escaped quote, CRLF, and a UTF-8 BOM. No streaming, no type coercion, no
 * dialect sniffing.
 */

export type CsvRow = Record<string, string>;

/** Split CSV text into raw cells, respecting quoted fields. */
export function parseCsvGrid(text: string): string[][] {
  const rows: string[][] = [[]];
  let field = '';
  let inQuotes = false;

  // A BOM on the first header name would make that column unfindable by name.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ',') {
      rows[rows.length - 1].push(field);
      field = '';
    } else if (char === '\n') {
      rows[rows.length - 1].push(field);
      field = '';
      rows.push([]);
    } else if (char !== '\r') {
      field += char;
    }
  }
  rows[rows.length - 1].push(field);

  // A trailing newline leaves one empty row behind.
  return rows.filter((row) => row.some((cell) => cell.trim() !== ''));
}

/**
 * Read CSV text as objects keyed by header name.
 *
 * Header names are trimmed and unquoted: `B6_Loop2_Email_Export.csv` quotes its
 * first header, so the column is literally `"row_id"` until it is cleaned up.
 */
export function parseCsv(text: string): CsvRow[] {
  const grid = parseCsvGrid(text);
  if (grid.length === 0) return [];

  const headers = grid[0].map((h) => h.trim().replace(/^"|"$/g, ''));
  return grid.slice(1).map((cells) => {
    const row: CsvRow = {};
    headers.forEach((header, i) => {
      row[header] = (cells[i] ?? '').trim();
    });
    return row;
  });
}
