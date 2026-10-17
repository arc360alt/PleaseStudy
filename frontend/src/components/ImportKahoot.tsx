import { useState } from "react";
import { api, errorText, type Question } from "../api";
import Modal from "./Modal";

export type ImportResult = {
  quiz: { title: string; description: string; cover_url: string | null; questions: Question[] };
  source: string;
  imported: number;
  total: number;
  skipped: { number: number; reason: string }[];
};

/** Paste a public Kahoot link; the server converts it into a draft for the editor. */
export default function ImportKahoot({ onClose, onImported }: { onClose: () => void; onImported: (r: ImportResult) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onImported(await api<ImportResult>("/api/import/kahoot", { body: { url } }));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Import from Kahoot" onClose={onClose}>
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
          <li>Only import quizzes you made or have permission to use.</li>
        </ul>
        {error && <div className="alert">{error}</div>}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !url.trim()}>
          {busy ? "Importing…" : "Import"}
        </button>
      </form>
    </Modal>
  );
}

export function ImportSummary({ result, onDismiss }: { result: ImportResult; onDismiss: () => void }) {
  return (
    <div className="panel import-summary">
      <div>
        <strong>
          Imported {result.imported} of {result.total} question{result.total === 1 ? "" : "s"} from{" "}
          <a href={result.source} target="_blank" rel="noreferrer noopener">
            Kahoot
          </a>
          .
        </strong>{" "}
        Check everything over, then save. It stays private until you submit it for review.
        {result.skipped.length > 0 && (
          <details>
            <summary>
              {result.skipped.length} skipped
            </summary>
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
