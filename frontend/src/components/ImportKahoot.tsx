import { useEffect, useRef, useState } from "react";
import { api, apiUpload, errorText, type Question } from "../api";
import { importSpreadsheet, templateCsv } from "../importCsv";
import { BLOOKET_BOOKMARKLET, importBlooket } from "../importBlooket";
import Modal from "./Modal";

export type ImportResult = {
  quiz: { title: string; description: string; cover_url: string | null; questions: Question[] };
  /** Link back to where it came from, if it was online. */
  source: string | null;
  /** PDF imports with pictures: the import session holding them (and the quiz id it will get). */
  importId?: string;
  imagesSaved?: number;
  sourceLabel: string;
  imported: number;
  total: number;
  skipped: { number: number; reason: string }[];
};

type Tab = "kahoot" | "blooket" | "sheet";

/** Import a quiz from a public Kahoot link or a spreadsheet (Blooket's CSV template works as-is). */
export default function ImportKahoot({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (r: ImportResult) => void;
}) {
  const [tab, setTab] = useState<Tab>("kahoot");
  return (
    <Modal title="Import a quiz" onClose={onClose}>
      <div className="seg seg-full">
        <button type="button" className={tab === "kahoot" ? "on" : ""} onClick={() => setTab("kahoot")}>
          Kahoot link
        </button>
        <button type="button" className={tab === "blooket" ? "on" : ""} onClick={() => setTab("blooket")}>
          Blooket
        </button>
        <button type="button" className={tab === "sheet" ? "on" : ""} onClick={() => setTab("sheet")}>
          Spreadsheet
        </button>
      </div>
      {tab === "kahoot" && <KahootTab onImported={onImported} />}
      {tab === "blooket" && <BlooketTab onImported={onImported} />}
      {tab === "sheet" && <SheetTab onImported={onImported} />}
      <p className="muted small-print">Only import quizzes you made or have permission to use.</p>
    </Modal>
  );
}

function KahootTab({ onImported }: { onImported: (r: ImportResult) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<Omit<ImportResult, "sourceLabel">>("/api/import/kahoot", { body: { url } });
      onImported({ ...r, sourceLabel: "Kahoot" });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form className="import-form" onSubmit={run}>
      <p className="muted">
        Paste the link to a <strong>public</strong> kahoot (from create.kahoot.it). It opens here as a draft you can
        check and edit before saving.
      </p>
      <input
        className="input input-lg"
        autoFocus
        placeholder="https://create.kahoot.it/details/…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <ul className="import-notes muted">
        <li>Multiple choice, multi-select and type-answer questions come across, with their images and timers.</li>
        <li>Polls, puzzles, sliders and info slides are skipped.</li>
      </ul>
      {error && <div className="alert">{error}</div>}
      <button className="btn btn-primary btn-lg btn-block" disabled={busy || !url.trim()}>
        {busy ? "Importing…" : "Import"}
      </button>
    </form>
  );
}

function BlooketTab({ onImported }: { onImported: (r: ImportResult) => void }) {
  const [method, setMethod] = useState<"pdf" | "bookmark">("pdf");
  return (
    <>
      <div className="seg seg-full seg-tall">
        <button type="button" className={method === "pdf" ? "on" : ""} onClick={() => setMethod("pdf")}>
          <strong>Answer key PDF</strong>
          <small>Easiest. Works for any set you can open</small>
        </button>
        <button type="button" className={method === "bookmark" ? "on" : ""} onClick={() => setMethod("bookmark")}>
          <strong>Copy bookmark</strong>
          <small>Also keeps time limits and images</small>
        </button>
      </div>
      {method === "pdf" ? <BlooketPdf onImported={onImported} /> : <BlooketBookmark onImported={onImported} />}
    </>
  );
}

function BlooketPdf({ onImported }: { onImported: (r: ImportResult) => void }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  async function pick(f: File | undefined) {
    if (!f) return;
    setError("");
    if (f.size > 20 * 1024 * 1024) return setError("That PDF is too big (max 20 MB).");
    setBusy(true);
    try {
      const { readBlooketPdf, PDF_IMAGE_PREFIX } = await import("../importBlooketPdf");
      const r = await readBlooketPdf(f);
      let importId: string | undefined;
      let imagesSaved = 0;
      const urls = new Map<string, string>();
      if (r.images.size) {
        setStatus(`Saving ${r.images.size} picture${r.images.size === 1 ? "" : "s"}…`);
        importId = (await api<{ id: string }>("/api/import/session", { method: "POST" })).id;
        let n = 0;
        for (const [key, blob] of r.images) {
          setStatus(`Saving pictures ${++n}/${r.images.size}…`);
          try {
            const up = await apiUpload<{ url: string }>(`/api/import/session/${importId}/images`, blob);
            urls.set(key, up.url);
            imagesSaved++;
          } catch {
            /* a picture that fails to save is just left out */
          }
        }
      }
      const resolve = (u: string | null | undefined) =>
        u?.startsWith(PDF_IMAGE_PREFIX) ? (urls.get(u.slice(PDF_IMAGE_PREFIX.length)) ?? null) : (u ?? null);
      r.questions = r.questions
        .map((q) => ({
          ...q,
          image_url: resolve(q.image_url),
          answers: q.answers
            .map((a) => ({ ...a, image_url: resolve(a.image_url) }))
            .filter((a) => a.text || a.image_url),
        }))
        .filter((q) => q.kind === "text" || q.answers.length >= 2);
      const fromName = f.name.replace(/\.pdf$/i, "").replace(/\s*\|\s*Blooket\s*$/i, "").trim();
      onImported({
        quiz: { title: (fromName || r.title || "Imported from Blooket").slice(0, 120), description: r.description, cover_url: null, questions: r.questions },
        source: null,
        sourceLabel: "the Blooket answer key",
        importId,
        imagesSaved,
        imported: r.questions.length,
        total: r.total,
        skipped: r.skipped,
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setStatus("");
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="import-form">
      <ol className="blooket-steps">
        <li>
          On Blooket, open the set and choose <strong>Print</strong>, then the <strong>answer key</strong>.
        </li>
        <li>
          <strong>Wait for the page to finish loading</strong>, then print it and choose <strong>Save as PDF</strong>.
        </li>
        <li>Upload that PDF here.</li>
      </ol>
      <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => pick(e.target.files?.[0])} />
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={busy} onClick={() => fileInput.current?.click()}>
        {busy ? status || "Reading PDF…" : "Choose answer key PDF"}
      </button>
      <small className="muted">
        The PDF is read on your device. Pictures in it are saved with your quiz (as compressed images); if you leave
        without saving, they're deleted. Time limits aren't in the printout, so questions get 20 seconds each.
      </small>
      {error && <div className="alert">{error}</div>}
    </div>
  );
}

function BlooketBookmark({ onImported }: { onImported: (r: ImportResult) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const link = useRef<HTMLAnchorElement>(null);

  // React refuses javascript: links in JSX, so set the bookmark's address directly.
  useEffect(() => {
    link.current?.setAttribute("href", BLOOKET_BOOKMARKLET);
  }, []);

  function run(content: string) {
    setError("");
    try {
      const r = importBlooket(content);
      onImported({
        quiz: { title: r.title, description: r.description, cover_url: r.cover_url, questions: r.questions },
        source: null,
        sourceLabel: "Blooket",
        imported: r.questions.length,
        total: r.total,
        skipped: r.skipped,
      });
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="import-form">
      <p className="muted">
        Blooket doesn't have an export button, so this uses a bookmark that copies a set while you're on Blooket.
      </p>
      <ol className="blooket-steps">
        <li>
          <strong>Drag this button to your bookmarks bar</strong> (one time only):
          <div className="bookmarklet-row">
            <a
              ref={link}
              className="btn btn-sm bookmarklet"
              onClick={(e) => {
                e.preventDefault();
                alert("Drag this button onto your bookmarks bar instead of clicking it. Then use it on blooket.com.");
              }}
              draggable
            >
              ⇩ Copy from Blooket
            </a>
            <small className="muted">No bookmarks bar? Press Ctrl+Shift+B (Cmd+Shift+B on Mac).</small>
          </div>
        </li>
        <li>
          Open <strong>one of your sets</strong> on blooket.com while logged in. The address should contain{" "}
          <code>/set/</code>.
        </li>
        <li>Click the <strong>Copy from Blooket</strong> bookmark. It tells you when the set is copied.</li>
        <li>Come back here and paste it below.</li>
      </ol>
      <textarea
        className="input paste-box"
        rows={4}
        value={text}
        placeholder="Paste what the bookmark copied…"
        onChange={(e) => {
          setText(e.target.value);
          setError("");
        }}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData("text");
          if (pasted.trim().startsWith("{")) {
            e.preventDefault();
            setText(pasted);
            run(pasted);
          }
        }}
      />
      {error && <div className="alert">{error}</div>}
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!text.trim()} onClick={() => run(text)}>
        Import
      </button>
    </div>
  );
}

function SheetTab({ onImported }: { onImported: (r: ImportResult) => void }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  function run(content: string, name: string) {
    setError("");
    try {
      const r = importSpreadsheet(content);
      const title = name.replace(/\.(csv|tsv|txt)$/i, "").replace(/[_-]+/g, " ").trim();
      onImported({
        quiz: { title: title || "Imported quiz", description: "", cover_url: null, questions: r.questions },
        source: null,
        sourceLabel: name ? `“${name}”` : "your spreadsheet",
        imported: r.questions.length,
        total: r.total,
        skipped: r.skipped,
      });
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function pickFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) {
      setError("That file is too big for a quiz spreadsheet (max 2 MB).");
      return;
    }
    setFileName(f.name);
    run(await f.text(), f.name);
    if (fileInput.current) fileInput.current.value = "";
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([templateCsv()], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "pleasestudy-import-template.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="import-form">
      <p className="muted">
        Use <strong>Blooket's spreadsheet template</strong> as-is (if you built a set from a CSV), or any sheet with a <em>Question</em> column,{" "}
        <em>Answer 1</em>, <em>Answer 2</em>… columns and a <em>Correct</em> column (numbers like <code>1,3</code>,
        letters, or the answer text).
      </p>
      <input
        ref={fileInput}
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
        hidden
        onChange={(e) => pickFile(e.target.files?.[0])}
      />
      <div className="row-wrap">
        <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()}>
          Choose CSV file
        </button>
        <button type="button" className="btn" onClick={downloadTemplate}>
          Download template
        </button>
        {fileName && <span className="muted">{fileName}</span>}
      </div>
      <label className="field">
        <span>…or paste cells copied from Google Sheets or Excel</span>
        <textarea
          className="input paste-box"
          rows={5}
          value={text}
          placeholder={"Question\tAnswer 1\tAnswer 2\tCorrect\nWhat is 2+2?\t3\t4\t2"}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <ul className="import-notes muted">
        <li>
          Two or more correct answers make a “pick several” question. A <em>Type</em> column can say{" "}
          <code>text</code> for type-answer questions.
        </li>
        <li>Optional columns: Time Limit (seconds), Image URL, Answer 5 and Answer 6.</li>
      </ul>
      {error && <div className="alert">{error}</div>}
      <button
        type="button"
        className="btn btn-primary btn-lg btn-block"
        disabled={!text.trim()}
        onClick={() => run(text, "")}
      >
        Import pasted cells
      </button>
    </div>
  );
}

export function ImportSummary({
  result,
  onDismiss,
  onDiscard,
}: {
  result: ImportResult;
  onDismiss: () => void;
  onDiscard?: () => void;
}) {
  return (
    <div className="panel import-summary">
      <div>
        <strong>
          Imported {result.imported} of {result.total} question{result.total === 1 ? "" : "s"} from{" "}
          {result.source ? (
            <a href={result.source} target="_blank" rel="noreferrer noopener">
              {result.sourceLabel}
            </a>
          ) : (
            result.sourceLabel
          )}
          .
        </strong>{" "}
        {!!result.imagesSaved && (
          <>
            {result.imagesSaved} picture{result.imagesSaved === 1 ? "" : "s"} saved with it.{" "}
          </>
        )}
        Check everything over (including the title), then save. It stays private until you submit it for review.
        {onDiscard && (
          <>
            {" "}
            <button className="link-btn" onClick={onDiscard}>
              Discard import
            </button>
          </>
        )}
        {result.skipped.length > 0 && (
          <details>
            <summary>{result.skipped.length} skipped</summary>
            <ul>
              {result.skipped.map((s) => (
                <li key={s.number}>
                  Question {s.number}: {s.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <button className="icon-btn" onClick={onDismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
