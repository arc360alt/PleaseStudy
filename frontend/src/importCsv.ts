/**
 * Spreadsheet import: Blooket's CSV template, PleaseStudy's own template, or most
 * "question, answers, correct answer" sheets. Columns are found by their header names, so
 * title rows above the headers, extra columns and line breaks inside header cells are fine.
 */
import type { Answer, Question, QuestionKind } from "./api";

export type CsvImport = {
  questions: Question[];
  total: number;
  skipped: { number: number; reason: string }[];
};

const MAX_QUESTIONS = 100;
const MAX_ANSWERS = 6;

/** RFC 4180-ish parser: quoted fields, doubled quotes, newlines inside quotes. */
export function parseDelimited(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const counts = { "\t": 0, ",": 0, ";": 0 } as Record<string, number>;
  for (const d of Object.keys(counts)) counts[d] = firstLine.split(d).length - 1;
  // Sheets/Excel copy-paste is tab separated; some European Excel exports use semicolons.
  const delim = counts["\t"] > 0 ? "\t" : counts[";"] > counts[","] ? ";" : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

type Columns = {
  question: number;
  answers: number[];
  correct: number;
  time: number;
  image: number;
  type: number;
};

/** Find the header row and which column holds what. */
function findColumns(rows: string[][]): { headerRow: number; cols: Columns } | null {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const h = rows[r].map(norm);
    const answers: { n: number; col: number }[] = [];
    h.forEach((cell, col) => {
      const m = cell.match(/^(?:answer|option|choice)\s*#?\s*(\d)/);
      if (m) answers.push({ n: Number(m[1]), col });
    });
    const correct = h.findIndex((c) => c.includes("correct"));
    const question = h.findIndex(
      (c) => (c.includes("question") || c === "prompt" || c.startsWith("question prompt")) && !/#|number|no\.|num\b/.test(c),
    );
    if (question >= 0 && answers.length >= 1) {
      return {
        headerRow: r,
        cols: {
          question,
          answers: answers.sort((a, b) => a.n - b.n).map((a) => a.col),
          correct,
          time: h.findIndex((c) => c.includes("time")),
          image: h.findIndex((c) => c.includes("image") || c.includes("picture") || c.includes("gif")),
          type: h.findIndex((c) => c === "type" || c.startsWith("question type") || c.startsWith("type ")),
        },
      };
    }
  }
  return null;
}

function kindOf(raw: string): QuestionKind | null {
  const t = norm(raw);
  if (!t) return null;
  if (/type|text|typed|open|short|fill/.test(t)) return "text";
  // Note "multiple choice" means pick one; only multi-*select* style labels mean pick several.
  if (/select|several|checkbox|all that apply|^multi$|multi[- ]?answer|multiple answers?/.test(t)) return "multi";
  if (/single|one|choice|^mc$|^mcq$/.test(t)) return "single";
  return null;
}

/** Correct answers as 1-based numbers ("1,3"), letters ("A, C") or the answer text itself. */
function correctIndices(raw: string, answers: string[]): number[] | null {
  // The whole cell might be one answer's text, commas and all ("Paris, France").
  const whole = answers.findIndex((a) => a && norm(a) === norm(raw));
  if (whole >= 0) return [whole];
  const parts = raw
    .split(/[,;|]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const out = new Set<number>();
  for (const p of parts) {
    let i = -1;
    if (/^\d+$/.test(p)) i = Number(p) - 1;
    else if (/^[a-f]$/i.test(p)) i = p.toLowerCase().charCodeAt(0) - 97;
    else i = answers.findIndex((a) => norm(a) === norm(p));
    if (i < 0 || i >= answers.length || !answers[i]) return null;
    out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s);

export function importSpreadsheet(text: string): CsvImport {
  const rows = parseDelimited(text);
  const found = findColumns(rows);
  if (!found) {
    throw new Error(
      "Couldn't find the header row. It needs a “Question” column and “Answer 1”, “Answer 2”… columns (Blooket's template works as-is).",
    );
  }
  const { headerRow, cols } = found;
  const questions: Question[] = [];
  const skipped: CsvImport["skipped"] = [];
  let total = 0;

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const cell = (c: number) => (c >= 0 ? (row[c] ?? "").trim() : "");
    const text = cell(cols.question).replace(/\s+/g, " ");
    const answerCells = cols.answers.map(cell);
    if (!text && answerCells.every((a) => !a)) continue; // blank row
    total++;
    const number = total;
    if (!text) {
      skipped.push({ number, reason: "no question text" });
      continue;
    }

    const time = Math.round(Number(cell(cols.time).replace(/[^\d.]/g, "")));
    const time_limit = Number.isFinite(time) && time > 0 ? Math.min(240, Math.max(5, time)) : 20;
    const imageCell = cell(cols.image);
    const image_url = isUrl(imageCell) ? imageCell : null;
    const declared = kindOf(cell(cols.type));

    // Typed answers: every filled answer cell is an accepted wording.
    if (declared === "text") {
      const seen = new Set<string>();
      const accepted = answerCells.filter((a) => a && !seen.has(norm(a)) && seen.add(norm(a))).slice(0, 10);
      if (!accepted.length) {
        skipped.push({ number, reason: "type-answer question with no accepted answers" });
        continue;
      }
      questions.push({
        kind: "text",
        text: text.slice(0, 300),
        image_url,
        time_limit,
        answers: accepted.map((a) => ({ text: a.slice(0, 120), correct: true })),
      });
      continue;
    }

    // Keep answer positions so "Correct: 3" still points at Answer 3 even if Answer 2 is blank.
    const correct = correctIndices(cell(cols.correct), answerCells);
    if (!correct) {
      skipped.push({
        number,
        reason: cell(cols.correct) ? `correct answer “${cell(cols.correct)}” doesn't match an answer` : "no correct answer given",
      });
      continue;
    }
    const answers: Answer[] = [];
    answerCells.forEach((a, i) => {
      if (!a) return;
      const asImage = isUrl(a);
      answers.push({
        text: asImage ? "" : a.slice(0, 120),
        image_url: asImage ? a : null,
        correct: correct.includes(i),
      });
    });
    if (answers.length < 2) {
      skipped.push({ number, reason: "needs at least 2 answers" });
      continue;
    }
    if (answers.length > MAX_ANSWERS) {
      skipped.push({ number, reason: "more than 6 answers" });
      continue;
    }
    if (questions.length >= MAX_QUESTIONS) {
      skipped.push({ number, reason: "over the 100-question limit" });
      continue;
    }
    questions.push({
      kind: declared ?? (correct.length > 1 ? "multi" : "single"),
      text: text.slice(0, 300),
      image_url,
      time_limit,
      answers,
    });
  }

  if (!questions.length) {
    throw new Error(
      total ? "None of the rows could be imported. Check the correct-answer column." : "The sheet has no questions under the header row.",
    );
  }
  return { questions, total, skipped };
}

/** A starter sheet. The first eight columns match Blooket's template; the rest are optional extras. */
export function templateCsv(): string {
  const rows = [
    ["PleaseStudy import template (Blooket compatible)"],
    [
      "Question #",
      "Question Text",
      "Answer 1",
      "Answer 2",
      "Answer 3 (Optional)",
      "Answer 4 (Optional)",
      "Time Limit (sec)",
      "Correct Answer(s) (Only include Answer #)",
      "Answer 5 (Optional)",
      "Answer 6 (Optional)",
      "Image URL (Optional)",
      "Type (Optional: single, multi, text)",
    ],
    ["1", "What is the capital of France?", "Berlin", "Paris", "Madrid", "Rome", "20", "2", "", "", "", ""],
    ["2", "Which of these are prime numbers?", "2", "4", "5", "9", "30", "1,3", "", "", "", "multi"],
    ["3", "Spell the color of the sky on a clear day", "blue", "light blue", "", "", "20", "", "", "", "", "text"],
  ];
  const esc = (c: string) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}
