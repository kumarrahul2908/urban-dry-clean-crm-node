/** PHP fgetcsv()/fputcsv() semantics (delimiter ",", enclosure '"', escape "\\"), as the import/export pages relied on. */
/** parse_csv_file(): BOM stripped, header row trimmed, blank lines skipped, short rows padded with ''. */
export function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff)
        text = text.slice(1);
    const records = fgetcsvAll(text);
    if (records.length === 0)
        return { headers: [], rows: [] };
    const headers = records[0].map((h) => (h ?? '').trim());
    const rows = [];
    for (const line of records.slice(1)) {
        if (line.length === 1 && (line[0] === null || line[0].trim() === ''))
            continue;
        const row = {};
        headers.forEach((h, i) => { row[h] = line[i] !== undefined && line[i] !== null ? line[i].trim() : ''; });
        rows.push(row);
    }
    return { headers, rows };
}
/** Splits CSV text into records the way a loop of fgetcsv() does (quoted fields may span lines; "\"" keeps the backslash). */
export function fgetcsvAll(text) {
    const out = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
        const rec = [];
        let blank = true;
        for (;;) {
            // one field
            let field = '';
            let quoted = false;
            while (i < n && (text[i] === ' ' || text[i] === '\t') && text[i + 1] !== undefined) {
                // leading whitespace before an opening quote is skipped by PHP; otherwise kept
                let j = i;
                while (j < n && (text[j] === ' ' || text[j] === '\t'))
                    j++;
                if (text[j] === '"') {
                    i = j;
                    break;
                }
                break;
            }
            if (text[i] === '"') {
                quoted = true;
                blank = false;
                i++;
                for (;;) {
                    if (i >= n)
                        break;
                    const c = text[i];
                    if (c === '\\' && i + 1 < n) {
                        field += c + text[i + 1];
                        i += 2;
                        continue;
                    } // escape char: the next char is taken literally, so \" does not close the field
                    if (c === '"') {
                        if (text[i + 1] === '"') {
                            field += '"';
                            i += 2;
                            continue;
                        }
                        i++;
                        break;
                    }
                    field += c;
                    i++;
                }
                // anything between the closing quote and the delimiter is appended literally
                while (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
                    field += text[i];
                    i++;
                }
            }
            else {
                while (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
                    field += text[i];
                    i++;
                }
            }
            if (field !== '' || quoted)
                blank = false;
            rec.push(field);
            if (i < n && text[i] === ',') {
                i++;
                blank = false;
                if (i >= n) {
                    rec.push('');
                    break;
                }
                continue;
            }
            break;
        }
        if (i < n && text[i] === '\r')
            i++;
        if (i < n && text[i] === '\n')
            i++;
        out.push(blank && rec.length === 1 ? [null] : rec);
    }
    return out;
}
/** fputcsv(): a field is enclosed when it contains , " \ space tab CR LF; quotes doubled; records end in "\n". */
export function fputcsv(fields) {
    return fields.map((f) => {
        const s = f === null || f === undefined ? '' : f === true ? '1' : f === false ? '' : String(f);
        return /[,"\\ \t\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',') + '\n';
}
/** csv_download(): UTF-8 BOM + header + rows. */
export function csvBody(headers, rows) {
    return '﻿' + fputcsv(headers) + rows.map(fputcsv).join('');
}
