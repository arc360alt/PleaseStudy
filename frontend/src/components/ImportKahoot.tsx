import { useRef, useState } from "react";
import { api, errorText, type Question } from "../api";
import { importSpreadsheet, templateCsv } from "../importCsv";
import Modal from "./Modal";

export type ImportResult = {
  quiz: { title: string; description: string; cover_url: string | null; questions: Question[] };
  /** Link back to where it came from, if it was online. */
  source: string | null;
  sourceLabel: string;
  imported: number;
  total: number;
  skipped: { number: number; reason: string }[];
};

type Tab = "kahoot" | "sheet";

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
        <button type="button" className={tab === "sheet" ? "on" : ""} onClick={() => setTab("sheet")}>
          Spreadsheet / Blooket
        </button>
      </div>
      {tab === "kahoot" ? <KahootTab onImported={onImported} /> : <SheetTab onImported={onImported} />}
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
        Use <strong>Blooket's spreadsheet template</strong> as-is, or any sheet with a <em>Question</em> column,{" "}
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

export function ImportSummary({ result, onDismiss }: { result: ImportResult; onDismiss: () => void }) {
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
        Check everything over (including the title), then save. It stays private until you submit it for review.
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
