/**
 * Import Blooket's printable answer key (the set's "Print" page saved as a PDF).
 *
 * The PDF has no structure, only positioned text, so we rebuild it from the layout Blooket uses:
 *   - the set title in large type, then numbered questions ("3. What is…") in semi-bold,
 *   - lettered answers "a) … d)" in two columns, long ones wrapping onto the next line,
 *   - correct answers set in a **bold** font, wrong ones in regular.
 * The file is read in the browser with pdf.js and never uploaded.
 */
import type { Answer, Question } from "./api";
import type { CsvImport } from "./importCsv";

/** One run of text from the PDF, in PDF points (y grows upward). */
export type PdfItem = { str: string; x: number; y: number; w: number; h: number; font: string; page: number };

type Segment = {
  x: number;
  y: number;
  h: number;
  page: number;
  text: string;
  /** Characters per font, to decide whether a run is bold. */
  fonts: Map<string, number>;
};

const isBoldFont = (name: string) => /bold|black|heavy/i.test(name) && !/semi-?bold|demi/i.test(name);

/**
 * Glue text runs into line segments. A new segment starts at a big horizontal gap, or where the
 * right answer column begins (long left-column text can run right up against it).
 */
function segments(items: PdfItem[], rightCol: number | null, mid: number): Segment[] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: PdfItem[][] = [];
  for (const it of sorted) {
    const line = lines[lines.length - 1];
    if (line && line[0].page === it.page && Math.abs(line[0].y - it.y) < 2.5) line.push(it);
    else lines.push([it]);
  }
  const out: Segment[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    let seg: Segment | null = null;
    let end = 0;
    for (const it of line) {
      const gap = it.x - end;
      const atRightCol = rightCol !== null && seg !== null && seg.x < mid && Math.abs(it.x - rightCol) < 2.5;
      if (!seg || gap > 18 || atRightCol) {
        seg = { x: it.x, y: it.y, h: it.h, page: it.page, text: "", fonts: new Map() };
        out.push(seg);
      } else if (gap > Math.max(1, it.h * 0.12)) {
        seg.text += " ";
      }
      seg.text += it.str;
      seg.h = Math.max(seg.h, it.h);
      seg.fonts.set(it.font, (seg.fonts.get(it.font) ?? 0) + it.str.length);
      end = it.x + it.w;
    }
  }
  return out.map((s) => ({ ...s, text: s.text.replace(/\s+/g, " ").trim() })).filter((s) => s.text);
}

type Draft = { text: string; h: number; answers: { letter: string; text: string; boldChars: number; chars: number; col: number }[]; extra: Segment[] };

export function parseBlooketPdf(items: PdfItem[], pageWidth = 612): CsvImport & { title: string; description: string } {
  // Page header/footer (date, URL, "Page 1 of 2") is set much smaller than the content.
  const content = items.filter((i) => i.str.trim() && i.h >= 9);
  const mid = pageWidth * 0.42;
  // Where the right answer column starts: the x of the "b", "d", "f" answer letters.
  const letters = content.filter((i) => /^[bdf]\s*\)?$/i.test(i.str.trim()) && i.x > mid).map((i) => Math.round(i.x));
  const rightCol = letters.length ? Math.min(...letters) : null;
  const segs = segments(content, rightCol, mid);
  const qStart = /^(\d+)\s*\.\s*(.*)$/;
  const aStart = /^([a-f])\s*\)\s*(.*)$/i;

  const first = segs.findIndex((s) => s.x < mid && qStart.test(s.text));
  if (first < 0) {
    throw new Error("Couldn't find any numbered questions. Make sure this is a Blooket answer key PDF (Print → Save as PDF).");
  }
  const qHeight = segs[first].h;

  // Title: the biggest text above the first question, skipping Blooket's own heading and the form fields.
  // (Blooket's heading "Blooket | Question Set - Answer Key" can come out as one line or several.)
  const pre = segs
    .slice(0, first)
    .filter((s) => !/^(blooket|name|date|class)$/i.test(s.text) && !/question set|answer key/i.test(s.text));
  const titleH = Math.max(0, ...pre.map((s) => s.h));
  const title = pre.filter((s) => s.h >= titleH - 0.5).map((s) => s.text).join(" ").trim();
  const description = pre
    .filter((s) => s.h < titleH - 0.5 && s.x < mid)
    .map((s) => s.text)
    .join(" ")
    .trim();

  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  const lastAnswer: (Draft["answers"][number] | null)[] = [null, null];

  for (const s of segs.slice(first)) {
    const col = s.x < mid ? 0 : 1;
    const q = s.x < mid && s.h >= qHeight - 0.5 ? s.text.match(qStart) : null;
    if (q && (!cur || cur.answers.length > 0 || cur.text)) {
      cur = { text: q[2], h: s.h, answers: [], extra: [] };
      drafts.push(cur);
      lastAnswer[0] = lastAnswer[1] = null;
      continue;
    }
    if (!cur) continue;
    const bold = [...s.fonts].reduce((n, [f, c]) => n + (isBoldFont(f) ? c : 0), 0);
    const chars = [...s.fonts.values()].reduce((a, b) => a + b, 0);
    const a = s.text.match(aStart);
    if (a && s.h < qHeight - 0.5) {
      const ans = { letter: a[1].toLowerCase(), text: a[2], boldChars: bold, chars, col };
      cur.answers.push(ans);
      lastAnswer[col] = ans;
    } else if (cur.answers.length === 0 && s.h >= qHeight - 0.5) {
      cur.text = `${cur.text} ${s.text}`.trim(); // question text wrapped onto another line
    } else if (lastAnswer[col]) {
      const ans = lastAnswer[col]!;
      ans.text = `${ans.text} ${s.text}`.trim(); // answer wrapped onto another line
      ans.boldChars += bold;
      ans.chars += chars;
    } else {
      cur.extra.push(s);
    }
  }

  const questions: Question[] = [];
  const skipped: CsvImport["skipped"] = [];
  drafts.forEach((d, i) => {
    const number = i + 1;
    const text = d.text.slice(0, 300);
    if (!text) return skipped.push({ number, reason: "no question text" });
    if (d.answers.length === 0) {
      // A question without lettered options: treat bold lines underneath as accepted typed answers.
      const typed = d.extra.filter((s) => [...s.fonts].some(([f]) => isBoldFont(f))).map((s) => s.text);
      if (typed.length) {
        questions.push({
          kind: "text",
          text,
          image_url: null,
          time_limit: 20,
          answers: typed.slice(0, 10).map((t) => ({ text: t.slice(0, 120), correct: true })),
        });
      } else skipped.push({ number, reason: "no answers on the printout" });
      return;
    }
    const answers: Answer[] = d.answers
      .sort((x, y) => x.letter.localeCompare(y.letter))
      .filter((a) => a.text)
      .map((a) => ({ text: a.text.slice(0, 120), correct: a.chars > 0 && a.boldChars / a.chars > 0.5 }));
    if (answers.length < 2) return skipped.push({ number, reason: "fewer than 2 answers" });
    if (!answers.some((a) => a.correct)) return skipped.push({ number, reason: "no answer marked correct (bold)" });
    // Blooket: you pick one answer and any marked-correct one counts → "pick one".
    questions.push({ kind: "single", text, image_url: null, time_limit: 20, answers: answers.slice(0, 6) });
  });

  if (!questions.length) throw new Error("None of the questions in this PDF could be read.");
  return { questions: questions.slice(0, 100), total: drafts.length, skipped, title, description };
}

/** Minimal slice of the pdf.js API we use, so the parser can be tested with any pdf.js build. */
type PdfDoc = {
  numPages: number;
  getPage(n: number): Promise<{
    getViewport(o: { scale: number }): { width: number };
    getTextContent(): Promise<{ items: unknown[] }>;
    getOperatorList(): Promise<unknown>;
    commonObjs: { get(id: string): { name?: string } | undefined };
  }>;
};

/** Pull positioned text and real font names (e.g. "Nunito-Bold") out of a pdf.js document. */
export async function pdfItems(doc: PdfDoc): Promise<{ items: PdfItem[]; pageWidth: number }> {
  const items: PdfItem[] = [];
  let pageWidth = 612;
  for (let p = 1; p <= Math.min(doc.numPages, 60); p++) {
    const page = await doc.getPage(p);
    pageWidth = page.getViewport({ scale: 1 }).width;
    const tc = await page.getTextContent();
    await page.getOperatorList(); // loads the fonts so their names are available
    const names = new Map<string, string>();
    for (const raw of tc.items) {
      const it = raw as { str?: string; transform?: number[]; width?: number; height?: number; fontName?: string };
      if (!it.str || !it.transform || !it.fontName) continue;
      if (!names.has(it.fontName)) {
        let name = it.fontName;
        try {
          name = page.commonObjs.get(it.fontName)?.name ?? it.fontName;
        } catch {
          /* font not loaded: fall back to the internal id */
        }
        names.set(it.fontName, name);
      }
      items.push({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        w: it.width ?? 0,
        h: it.height ?? Math.abs(it.transform[3]),
        font: names.get(it.fontName)!,
        page: p,
      });
    }
  }
  return { items, pageWidth };
}

/** Read a Blooket answer-key PDF in the browser. pdf.js is loaded only when this is used. */
export async function readBlooketPdf(file: File) {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    fontExtraProperties: true,
    isEvalSupported: false,
  }).promise;
  try {
    const { items, pageWidth } = await pdfItems(doc as unknown as PdfDoc);
    if (!items.length) {
      throw new Error(
        "This PDF has no text in it. It may have been saved before the page finished loading. Open the print page again, wait for it to load, then save.",
      );
    }
    return parseBlooketPdf(items, pageWidth);
  } finally {
    doc.destroy();
  }
}
