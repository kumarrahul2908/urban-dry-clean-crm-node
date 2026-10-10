import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fgetcsvAll, fputcsv, parseCsv } from '../src/web/csv.js';

const hasPhp = spawnSync('php', ['-v']).status === 0;

const SAMPLES: Record<string, string> = {
  plain: 'a,b,c\n1,2,3\n',
  crlf: 'a,b\r\n1,2\r\n',
  noFinalNewline: 'a,b\n1,2',
  quoted: 'a,b\n"x, y","say ""hi"""\n',
  multiline: 'a,b\n"line1\nline2",z\n',
  blankLines: 'a,b\n\n1,2\n\n\n3,4\n',
  trailingComma: 'a,b,c\n1,2,\n,,\n',
  escapeBackslash: 'a,b\n"x\\"y",2\n"p\\\\",q\n',
  midQuote: 'a,b\nab"cd,e\n',
  spacesBeforeQuote: 'a,b\n  "x",y\n',
  afterQuote: 'a,b\n"x"junk,y\n',
  unclosed: 'a,b\n"never closed,2\n3,4\n',
  unicode: 'नाम,city\nराहुल,दिल्ली\n',
  singleCol: 'a\n1\n\n2\n',
  emptyFields: ',\n,x\n',
  bom: '﻿Name,Mobile\nA,1\n',
};

describe('CSV helpers vs PHP fgetcsv/fputcsv', () => {
  it.skipIf(!hasPhp)('fgetcsvAll matches fgetcsv on tricky input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-'));
    for (const [name, text] of Object.entries(SAMPLES)) {
      const file = join(dir, `${name}.csv`);
      writeFileSync(file, text);
      const out = execFileSync('php', ['-r', '$h=fopen($argv[1],"r"); $r=[]; while(($l=fgetcsv($h))!==false) $r[]=$l; echo json_encode($r);', file]).toString();
      expect(fgetcsvAll(text), name).toEqual(JSON.parse(out));
    }
  });

  it.skipIf(!hasPhp)('fputcsv matches PHP quoting rules', () => {
    const rows = [['a', 'b c', 'd,e', 'f"g', 'h\\i', "j\tk", 'l\nm', '', null, 12, 1.5, true, false, 'नाम', ' lead', 'trail ']];
    const out = execFileSync('php', ['-r', '$o=fopen("php://output","w"); fputcsv($o, json_decode($argv[1], true)); fclose($o);', JSON.stringify(rows[0])]).toString();
    expect(fputcsv(rows[0]!)).toBe(out);
  });

  it('parseCsv strips the BOM, trims, pads short rows and skips blank lines', () => {
    expect(parseCsv('﻿ Name , Mobile \n a , 1 \n\n b \n')).toEqual({ headers: ['Name', 'Mobile'], rows: [{ Name: 'a', Mobile: '1' }, { Name: 'b', Mobile: '' }] });
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });
});
