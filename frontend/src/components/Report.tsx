import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, errorText } from "../api";
import { useAuth } from "../auth";
import Modal from "./Modal";

export const REASONS: Record<"quiz" | "user", [string, string, string][]> = {
  quiz: [
    ["inappropriate", "Inappropriate content", "Sexual, violent, or not school-friendly"],
    ["hateful", "Hateful or bullying", "Targets a person or group"],
    ["spam", "Spam or junk", "Gibberish, ads, or a copy of another quiz"],
    ["wrong_answers", "Wrong answers", "The answer key is incorrect"],
    ["copyright", "Copyright", "Copied from someone without permission"],
    ["other", "Something else", ""],
  ],
  user: [
    ["inappropriate", "Inappropriate name or content", "Not school-friendly"],
    ["harassment", "Harassment or bullying", "Targeting or picking on someone"],
    ["spam", "Spam", "Posting junk or advertising"],
    ["impersonation", "Pretending to be someone", "Impersonating a teacher, student, or another user"],
    ["other", "Something else", ""],
  ],
};

export function reasonLabel(kind: "quiz" | "user", reason: string) {
  return REASONS[kind].find(([k]) => k === reason)?.[1] ?? reason;
}

export default function ReportButton({
  kind,
  target,
  label,
  name,
}: {
  kind: "quiz" | "user";
  /** Quiz id, or username. */
  target: string;
  label: string;
  /** Display name for account reports. */
  name?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="report-link" onClick={() => setOpen(true)}>
        ⚑ {label}
      </button>
      {open && <ReportModal kind={kind} target={target} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReportModal({
  kind,
  target,
  name,
  onClose,
}: {
  kind: "quiz" | "user";
  target: string;
  name?: string;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const location = useLocation();
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<null | boolean>(null);
  const title = kind === "quiz" ? "Report this quiz" : `Report ${name ?? target}`;

  if (!user) {
    return (
      <Modal title={title} onClose={onClose}>
        <p>You need an account to send reports. This keeps people from spamming the moderators.</p>
        <Link className="btn btn-primary" to={`/login?next=${location.pathname}`}>
          Log in
        </Link>
      </Modal>
    );
  }

  if (sent !== null) {
    return (
      <Modal title="Thanks for telling us" onClose={onClose}>
        <p>
          {sent
            ? "You already reported this. The moderators have it."
            : "A moderator will look at it. You won't be named to the person you reported."}
        </p>
        <button className="btn btn-ink" onClick={onClose}>
          Done
        </button>
      </Modal>
    );
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ already: boolean }>("/api/reports", { body: { kind, target, reason, details } });
      setSent(r.already);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="reason-list">
        {REASONS[kind].map(([key, label, hint]) => (
          <label key={key} className="reason-option">
            <input type="radio" name="reason" value={key} checked={reason === key} onChange={() => setReason(key)} />
            <span>
              <strong>{label}</strong>
              {hint && <small>{hint}</small>}
            </span>
          </label>
        ))}
      </div>
      <label className="field">
        <span>Anything else? (optional)</span>
        <textarea
          className="input"
          rows={3}
          maxLength={1000}
          value={details}
          placeholder={kind === "quiz" ? "Which question? What's wrong with it?" : "What happened?"}
          onChange={(e) => setDetails(e.target.value)}
        />
      </label>
      {error && <div className="alert">{error}</div>}
      <button className="btn btn-primary btn-lg btn-block" disabled={!reason || busy} onClick={submit}>
        Send report
      </button>
    </Modal>
  );
}
