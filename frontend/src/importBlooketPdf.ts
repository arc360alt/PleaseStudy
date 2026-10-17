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

/** Where a picture is drawn, in PDF points. `key` identifies it until it's uploaded. */
export type PdfImage = { key: string; page: number; left: number; right: number; top: number; bottom: number };

/** Stands in for an image URL until the picture has been uploaded. */
export const PDF_IMAGE_PREFIX = "pdf-image:";

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

type DraftAnswer = { letter: string; text: string; boldChars: number; chars: number; col: number; page: number; y: number; image?: string };
type Draft = { text: string; h: number; page: number; y: number; image?: string; answers: DraftAnswer[]; extra: Segment[] };

/** Is (page, y) at or above (page2, y2) in reading order? */
const above = (page: number, y: number, page2: number, y2: number) => page < page2 || (page === page2 && y >= y2 - 2);

/**
 * Give each picture to the question it sits in: above that question's answers → the question's
 * picture; among the answers → the answer it's under, in the same column.
 */
function placeImages(drafts: Draft[], images: PdfImage[], mid: number) {
  for (const img of images) {
    let d: Draft | undefined;
    for (const q of drafts) if (above(q.page, q.y, img.page, img.top)) d = q;
    if (!d) continue; // e.g. a logo above the first question
    const firstAnswer = d.answers.reduce<DraftAnswer | null>(
      (best, a) => (!best || above(a.page, a.y, best.page, best.y) ? a : best),
      null,
    );
    const inAnswers = firstAnswer && above(firstAnswer.page, firstAnswer.y, img.page, img.top + 4);
    if (inAnswers) {
      const col = (img.left + img.right) / 2 < mid ? 0 : 1;
      let target: DraftAnswer | undefined;
      for (const a of d.answers) if (a.col === col && above(a.page, a.y, img.page, img.top + 4)) target = a;
      if (target && !target.image) {
        target.image = img.key;
        continue;
      }
    }
    if (!d.image) d.image = img.key;
  }
}

export function parseBlooketPdf(
  items: PdfItem[],
  pageWidth = 612,
  images: PdfImage[] = [],
): CsvImport & { title: string; description: string } {
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
      cur = { text: q[2], h: s.h, page: s.page, y: s.y, answers: [], extra: [] };
      drafts.push(cur);
      lastAnswer[0] = lastAnswer[1] = null;
      continue;
    }
    if (!cur) continue;
    const bold = [...s.fonts].reduce((n, [f, c]) => n + (isBoldFont(f) ? c : 0), 0);
    const chars = [...s.fonts.values()].reduce((a, b) => a + b, 0);
    const a = s.text.match(aStart);
    if (a && s.h < qHeight - 0.5) {
      const ans: DraftAnswer = { letter: a[1].toLowerCase(), text: a[2], boldChars: bold, chars, col, page: s.page, y: s.y };
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

  placeImages(drafts, images, mid);
  const ref = (key?: string) => (key ? PDF_IMAGE_PREFIX + key : null);

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
          image_url: ref(d.image),
          time_limit: 20,
          answers: typed.slice(0, 10).map((t) => ({ text: t.slice(0, 120), correct: true })),
        });
      } else skipped.push({ number, reason: "no answers on the printout" });
      return;
    }
    const answers: Answer[] = d.answers
      .sort((x, y) => x.letter.localeCompare(y.letter))
      .filter((a) => a.text || a.image)
      // A picture answer's letter is still printed bold when it's correct.
      .map((a) => ({
        text: a.text.slice(0, 120),
        correct: a.chars > 0 && a.boldChars / a.chars > 0.5,
        image_url: ref(a.image),
      }));
    if (answers.length < 2) return skipped.push({ number, reason: "fewer than 2 answers" });
    if (!answers.some((a) => a.correct)) return skipped.push({ number, reason: "no answer marked correct (bold)" });
    // Blooket: you pick one answer and any marked-correct one counts → "pick one".
    questions.push({ kind: "single", text, image_url: ref(d.image), time_limit: 20, answers: answers.slice(0, 6) });
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
    getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
    commonObjs: { get(id: string): { name?: string } | undefined };
  }>;
};

type Ops = Record<"save" | "restore" | "transform" | "paintImageXObject" | "paintInlineImageXObject" | "paintFormXObjectBegin" | "paintFormXObjectEnd", number>;
type Matrix = [number, number, number, number, number, number];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/**
 * Where every picture is drawn, by replaying the page's drawing commands and tracking the
 * current transform (a picture fills the unit square of the transform it's drawn with).
 */
export async function pdfImagePlacements(doc: PdfDoc, ops: Ops): Promise<PdfImage[]> {
  const out: PdfImage[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, 60); p++) {
    const page = await doc.getPage(p);
    const { fnArray, argsArray } = await page.getOperatorList();
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    fnArray.forEach((fn, i) => {
      const args = argsArray[i] as unknown[];
      if (fn === ops.save) stack.push(ctm);
      else if (fn === ops.restore) ctm = stack.pop() ?? ctm;
      else if (fn === ops.transform) ctm = mul(ctm, args as Matrix);
      else if (fn === ops.paintFormXObjectBegin) {
        stack.push(ctm);
        const m = args[0] as number[] | null;
        if (Array.isArray(m) && m.length === 6) ctm = mul(ctm, m as Matrix);
      } else if (fn === ops.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject) {
        const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]];
        const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]];
        const img = { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) };
        // Skip tiny things (icons, bullets) and repeats drawn in the same spot.
        if (img.right - img.left < 24 || img.top - img.bottom < 24) return;
        if (out.some((o) => o.page === p && Math.abs(o.left - img.left) < 1 && Math.abs(o.top - img.top) < 1)) return;
        out.push({ key: `${p}-${out.length}`, page: p, ...img });
      }
    });
  }
  return out;
}

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

/** Render each page once and cut the pictures out exactly as they appear. */
async function cropImages(doc: unknown, images: PdfImage[]): Promise<Map<string, Blob>> {
  const blobs = new Map<string, Blob>();
  const pages = [...new Set(images.map((i) => i.page))];
  for (const p of pages) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = await (doc as any).getPage(p);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvasContext: ctx, viewport }).promise;
    for (const img of images.filter((i) => i.page === p)) {
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([img.left, img.bottom, img.right, img.top]);
      const x = Math.max(0, Math.floor(Math.min(x1, x2)));
      const y = Math.max(0, Math.floor(Math.min(y1, y2)));
      const w = Math.min(canvas.width - x, Math.ceil(Math.abs(x2 - x1)));
      const h = Math.min(canvas.height - y, Math.ceil(Math.abs(y2 - y1)));
      if (w < 8 || h < 8) continue;
      // Uploads are capped at 1 MB: shrink to the size the server keeps anyway (1280px), then use a
      // PNG if it fits (crisp for diagrams), otherwise a JPEG. The server re-encodes it as WebP.
      const fit = Math.min(1, 1280 / Math.max(w, h));
      const crop = document.createElement("canvas");
      crop.width = Math.max(1, Math.round(w * fit));
      crop.height = Math.max(1, Math.round(h * fit));
      crop.getContext("2d")!.drawImage(canvas, x, y, w, h, 0, 0, crop.width, crop.height);
      const encode = (type: string, q?: number) => new Promise<Blob | null>((res) => crop.toBlob(res, type, q));
      let blob = await encode("image/png");
      for (const q of [0.9, 0.8, 0.65]) {
        if (blob && blob.size <= 1024 * 1024) break;
        blob = await encode("image/jpeg", q);
      }
      if (blob && blob.size <= 1024 * 1024) blobs.set(img.key, blob);
    }
    canvas.width = canvas.height = 0;
  }
  return blobs;
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
    const placements = await pdfImagePlacements(doc as unknown as PdfDoc, pdfjs.OPS as unknown as Ops);
    const parsed = parseBlooketPdf(items, pageWidth, placements);
    // Only crop the pictures that ended up attached to a question or answer.
    const used = new Set(
      parsed.questions.flatMap((q) => [q.image_url, ...q.answers.map((a) => a.image_url)]).filter((u): u is string => !!u?.startsWith(PDF_IMAGE_PREFIX)).map((u) => u.slice(PDF_IMAGE_PREFIX.length)),
    );
    const images = await cropImages(doc, placements.filter((p) => used.has(p.key)));
    return { ...parsed, images };
  } finally {
    doc.destroy();
  }
}
