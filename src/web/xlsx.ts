import { inflateRawSync } from 'node:zlib';

/**
 * parse_xlsx_file(): reads an .xlsx workbook directly, combining EVERY sheet's rows together
 * (matching a customer list spread/duplicated across sheets -- the existing mobile-based
 * duplicate detection in the customer importer already handles the resulting overlap correctly).
 * Returns the same {headers, rows} shape parseCsv() does, using the FIRST sheet's header row as
 * the canonical header list (a later sheet's own header row, if it has one, is treated as a
 * duplicate data row and skipped via the same row-level duplicate detection downstream).
 *
 * An .xlsx is a zip of XML parts. PHP's own port used ZipArchive + SimpleXMLElement, both built
 * into PHP core -- Node has neither built in (only the DEFLATE codec, via zlib), so this reads
 * the ZIP container directly (central directory -> local file headers -> inflate) rather than
 * pulling in a full archive/XML dependency for what's a handful of well-defined binary records.
 */
export function parseXlsx(buf: Buffer): { headers: string[]; rows: Record<string, string>[] } {
  const entries = readZipEntries(buf);
  const sharedStrings = parseSharedStrings(entries.get('xl/sharedStrings.xml'));
  const sheetNames = [...entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));

  let headers: string[] = [];
  const rows: Record<string, string>[] = [];
  for (const name of sheetNames) {
    const xml = entries.get(name);
    if (!xml) continue;
    const sheetRows = parseSheetRows(xml.toString('utf8'), sharedStrings);
    if (sheetRows.length === 0) continue;
    let dataRows = sheetRows;
    if (headers.length === 0) { headers = sheetRows[0]!.map((h) => h.trim()); dataRows = sheetRows.slice(1); }
    for (const line of dataRows) {
      if (line.every((v) => v === '')) continue; // fully blank row
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = (line[i] ?? '').trim(); });
      rows.push(row);
    }
  }
  return { headers, rows };
}

/** Shared strings table: <si><t>text</t></si> or <si><r><t>run</t></r>...</si> for rich-text runs. */
function parseSharedStrings(xml: Buffer | undefined): string[] {
  if (!xml) return [];
  const text = xml.toString('utf8');
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(text))) {
    const inner = m[1]!;
    const parts: string[] = [];
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(inner))) parts.push(decodeXmlEntities(t[1]!));
    out.push(parts.join(''));
  }
  return out;
}

const colIndex = (cellRef: string): number => {
  const letters = /^([A-Z]+)/.exec(cellRef)?.[1] ?? 'A';
  let col = 0;
  for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
  return col - 1;
};

function parseSheetRows(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(xml))) {
    const cells = new Map<number, string>();
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let c: RegExpExecArray | null;
    let autoCol = 0;
    while ((c = cellRe.exec(r[1]!))) {
      const attrs = c[1] ?? c[3] ?? '';
      const inner = c[2] ?? '';
      const refMatch = /\br="([A-Z]+\d+)"/.exec(attrs);
      const col = refMatch ? colIndex(refMatch[1]!) : autoCol;
      autoCol = col + 1;
      const type = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? '';
      let value = '';
      if (type === 's') {
        const idx = Number(/<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? -1);
        value = sharedStrings[idx] ?? '';
      } else if (type === 'inlineStr') {
        value = decodeXmlEntities(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '');
      } else {
        value = decodeXmlEntities(/<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? '');
      }
      cells.set(col, value);
    }
    if (cells.size === 0) continue;
    const maxCol = Math.max(...cells.keys());
    const line: string[] = [];
    for (let col = 0; col <= maxCol; col++) line.push((cells.get(col) ?? '').trim());
    rows.push(line);
  }
  return rows;
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Reads a ZIP's central directory and inflates every entry by name -> raw bytes. */
function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const eocdSig = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Could not open this file as an Excel workbook.');
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  let cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const out = new Map<string, Buffer>();
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) break;
    const compMethod = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);
    if (/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name)) {
      const lfNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lfExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lfNameLen + lfExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      out.set(name, compMethod === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    }
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
