/**
 * "Copy from Blooket" support.
 *
 * Blooket has no export and blocks servers with a bot check, so a bookmarklet runs on blooket.com
 * in the user's own (logged-in) browser, grabs the set's raw data and copies it. All the
 * converting happens here, so it can be fixed without anyone reinstalling the bookmark.
 * Blooket's internal format isn't documented, so the converter accepts several field names.
 */
import type { Answer, Question } from "./api";
import type { CsvImport } from "./importCsv";

/** Runs on blooket.com. Kept dependency-free and small; it only fetches and copies. */
const BOOKMARKLET_SRC = `(async()=>{
const m=location.href.match(/[0-9a-f]{24}/i);
if(!/blooket\\.com$/.test(location.hostname)||!m){alert("Open one of your sets on blooket.com first (its address contains /set/…), then click this bookmark again.");return;}
const id=m[0],errs=[];let data=null;
const hasQ=o=>o&&typeof o==="object"&&(Array.isArray(o.questions)||(o.data&&Array.isArray(o.data.questions)));
for(const u of["https://dashboard.blooket.com/api/games?gameId=","https://play.blooket.com/api/gamequestionsets?gameId=","https://api.blooket.com/api/games?gameId="]){
try{const r=await fetch(u+id,{credentials:"include"});if(!r.ok){errs.push(u.split("/")[2]+" "+r.status);continue;}
const j=await r.json();if(hasQ(j)){data=j;break;}errs.push(u.split("/")[2]+" no questions");}catch(e){errs.push(u.split("/")[2]+" "+e.message);}}
if(!data){const seen=new Set();const find=o=>{if(!o||typeof o!=="object"||seen.has(o))return null;seen.add(o);
if(Array.isArray(o.questions)&&o.questions.some(q=>q&&(q.question||q.text)))return o;
for(const k in o){try{const f=find(o[k]);if(f)return f;}catch(e){}}return null;};
for(const el of document.querySelectorAll("script[type='application/json'],script#__NEXT_DATA__")){try{data=find(JSON.parse(el.textContent));if(data)break;}catch(e){}}
if(!data)errs.push("page: no questions");}
if(!data){prompt("Couldn't read this set. Copy these details and send them to your PleaseStudy admin:",errs.join(" | "));return;}
const text=JSON.stringify({pleasestudy:"blooket",id:id,data:data});
const n=(data.questions||data.data.questions).length;
try{await navigator.clipboard.writeText(text);alert("Copied "+n+" questions! Go back to PleaseStudy, open Import quiz → Blooket, and paste.");}
catch(e){const t=document.createElement("textarea");t.value=text;t.style.cssText="position:fixed;inset:10%;z-index:2147483647;width:80%;height:80%";document.body.appendChild(t);t.select();
alert("Press Ctrl+C (Cmd+C on Mac) to copy the selected text, then paste it into PleaseStudy. Click OK to close.");t.remove();}
})()`;

export const BLOOKET_BOOKMARKLET = "javascript:" + encodeURIComponent(BOOKMARKLET_SRC.replace(/\n/g, ""));

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Blooket text may contain light HTML and entities. */
function plain(s: string): string {
  return s
    .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Images show up as a URL string or an object with a url. */
function imageOf(v: unknown): string | null {
  const u = isObj(v) ? str(v.url) || str(v.src) : str(v);
  return /^https?:\/\//i.test(u) ? u : null;
}

/** Find the set object (the one holding a questions array) wherever it sits in the pasted data. */
function findSet(root: unknown): Raw | null {
  const seen = new Set<unknown>();
  const walk = (o: unknown): Raw | null => {
    if (!o || typeof o !== "object" || seen.has(o)) return null;
    seen.add(o);
    if (isObj(o) && Array.isArray(o.questions) && o.questions.some((q) => isObj(q) && (q.question || q.text))) return o;
    for (const v of Object.values(o as Raw)) {
      const f = walk(v);
      if (f) return f;
    }
    return null;
  };
  return walk(root);
}

export function looksLikeBlooket(text: string) {
  return /"pleasestudy"\s*:\s*"blooket"/.test(text) || /"correctAnswers"\s*:/.test(text);
}

export function importBlooket(text: string): CsvImport & { title: string; description: string; cover_url: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new Error("That isn't what the Blooket bookmark copies. Click the bookmark on your Blooket set, then paste here.");
  }
  const set = findSet(parsed);
  if (!set) throw new Error("Couldn't find any questions in what you pasted.");

  const questions: Question[] = [];
  const skipped: CsvImport["skipped"] = [];
  const rawQs = set.questions as unknown[];
  rawQs.forEach((rq, i) => {
    const number = i + 1;
    if (!isObj(rq)) return skipped.push({ number, reason: "unreadable question" });
    const text = plain(str(rq.question) || str(rq.text)).slice(0, 300);
    if (!text) return skipped.push({ number, reason: "no question text" });
    const time = Number(rq.timeLimit ?? rq.time ?? 20);
    const time_limit = Math.min(240, Math.max(5, Number.isFinite(time) && time > 0 ? Math.round(time) : 20));
    const image_url = imageOf(rq.image);
    const answers = (Array.isArray(rq.answers) ? rq.answers : []).map((a) => plain(isObj(a) ? str(a.text) || str(a.answer) : str(a)));
    const rawCorrect = Array.isArray(rq.correctAnswers) ? rq.correctAnswers : rq.correctAnswer != null ? [rq.correctAnswer] : [];
    const correctText = rawCorrect.map((c) => plain(str(c)));
    const qType = str(rq.qType || rq.type).toLowerCase();

    if (qType.includes("typ") || qType.includes("text")) {
      const seen = new Set<string>();
      const accepted = [...correctText, ...answers]
        .filter((a) => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()))
        .slice(0, 10);
      if (!accepted.length) return skipped.push({ number, reason: "typing question with no answer" });
      questions.push({ kind: "text", text, image_url, time_limit, answers: accepted.map((a) => ({ text: a.slice(0, 120), correct: true })) });
      return;
    }

    // Correct answers are usually the answer text; accept indices too, just in case.
    const isCorrect = (a: string, idx: number) =>
      correctText.some((c) => c === a) || rawCorrect.some((c) => typeof c === "number" && (c === idx || c === idx + 1));
    const list: Answer[] = answers
      .map((a, idx) => ({ text: a.slice(0, 120), correct: !!a && isCorrect(a, idx) }))
      .filter((a) => a.text);
    if (list.length < 2) return skipped.push({ number, reason: "fewer than 2 answers" });
    if (!list.some((a) => a.correct)) return skipped.push({ number, reason: "no correct answer marked" });
    // In Blooket you pick one answer and any marked-correct one counts: that's our "pick one".
    questions.push({ kind: "single", text, image_url, time_limit, answers: list.slice(0, 6) });
  });

  if (!questions.length) throw new Error("None of the questions could be imported.");
  const title = plain(str(set.title) || str(set.name)).slice(0, 120) || "Imported from Blooket";
  return {
    questions: questions.slice(0, 100),
    total: rawQs.length,
    skipped,
    title,
    description: plain(str(set.desc) || str(set.description)).slice(0, 1000),
    cover_url: imageOf(set.coverImage) ?? imageOf(set.image),
  };
}
