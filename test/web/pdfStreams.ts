import { inflateSync } from 'node:zlib';

/** The inflated page content streams of an FPDF-style PDF (the part that must match PHP byte-for-byte). */
export function pdfStreams(pdf: Buffer): string[] {
  const s = pdf.toString('latin1');
  const out: string[] = [];
  const re = /<<([^>]*)>>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const len = Number(/\/Length (\d+)/.exec(m[1]!)![1]);
    const raw = pdf.subarray(start, start + len);
    // the ToUnicode CMap stream is not a page: skip anything that is not a content stream
    const body = /FlateDecode/.test(m[1]!) ? inflateSync(raw).toString('latin1') : raw.toString('latin1');
    if (!body.startsWith('/CIDInit')) out.push(body);
  }
  return out;
}
export const pdfFonts = (buf: Buffer) => [...buf.toString('latin1').matchAll(/\/BaseFont \/(\S+)/g)].map((x) => x[1]);
