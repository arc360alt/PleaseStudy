import { useState } from "react";
import type { AccountInfo } from "../api";
import { useAuth } from "../auth";

export type StaffAction =
  | "dismiss"
  | "takedown"
  | "delete_quiz"
  | "warn"
  | "reset_profile"
  | "ban"
  | "unban"
  | "delete_account";

const BAN_DAYS = [1, 3, 7, 14, 30, 90, 365];

function canTouch(actorRole: string | undefined, actorId: number | undefined, target: AccountInfo | null) {
  if (!target || target.id === actorId) return false;
  if (target.role === "admin") return false;
  if (target.role === "moderator") return actorRole === "admin";
  return true;
}

/**
 * The buttons staff use to respond to a report (or to an account directly).
 * Moderators: dismiss, take down, warn. Admins also: delete quiz, ban, unban, delete account.
 */
export default function StaffActions({
  account,
  quiz,
  showDismiss,
  onAction,
}: {
  account: AccountInfo | null;
  quiz?: { id: string; title: string; status: string } | null;
  showDismiss?: boolean;
  onAction: (action: StaffAction, message: string, days?: number) => Promise<void>;
}) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [message, setMessage] = useState("");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const touchable = canTouch(user?.role, user?.id, account);
  const who = account
    ? account.display_name
      ? `${account.display_name} (@${account.username})`
      : `@${account.username}`
    : "the owner";

  async function run(action: StaffAction, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setError("");
    try {
      await onAction(action, message, action === "ban" ? days : undefined);
      setMessage("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="action-panel">
      <label className="field">
        <span>Message to {quiz ? `the owner (${who})` : who}</span>
        <textarea
          className="input"
          rows={2}
          maxLength={1000}
          value={message}
          placeholder="Required for take-downs, warnings and bans. They'll see this."
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>
      {error && <div className="alert">{error}</div>}
      <div className="action-buttons">
        {showDismiss && (
          <button className="btn btn-sm" disabled={busy} onClick={() => run("dismiss")}>
            Dismiss
          </button>
        )}
        {quiz && quiz.status === "approved" && (
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => run("takedown")}>
            Take quiz down
          </button>
        )}
        {quiz && isAdmin && (
          <button
            className="btn btn-sm btn-danger"
            disabled={busy}
            onClick={() => run("delete_quiz", `Delete “${quiz.title}” permanently?`)}
          >
            Delete quiz
          </button>
        )}
        {touchable && (
          <>
            <span className="divider" />
            <button className="btn btn-sm" disabled={busy} onClick={() => run("warn")}>
              Warn
            </button>
            <button
              className="btn btn-sm"
              disabled={busy}
              title="Clears their profile picture, display name and bio"
              onClick={() => run("reset_profile", `Reset ${who}'s picture, display name and bio?`)}
            >
              Reset profile
            </button>
            {isAdmin && !account?.banned_until && (
              <span className="row-wrap">
                <select className="input input-sm" value={days} onChange={(e) => setDays(+e.target.value)}>
                  {BAN_DAYS.map((d) => (
                    <option key={d} value={d}>
                      {d} day{d === 1 ? "" : "s"}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-sm btn-danger"
                  disabled={busy}
                  onClick={() => run("ban", `Suspend ${who} for ${days} day${days === 1 ? "" : "s"}?`)}
                >
                  Ban
                </button>
              </span>
            )}
            {isAdmin && account?.banned_until && (
              <button className="btn btn-sm" disabled={busy} onClick={() => run("unban")}>
                Lift ban
              </button>
            )}
            {isAdmin && (
              <button
                className="btn btn-sm btn-danger"
                disabled={busy}
                onClick={() =>
                  run(
                    "delete_account",
                    `Delete ${who} for good? This removes their account, quizzes and assignments and can't be undone.`,
                  )
                }
              >
                Delete account
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function AccountFacts({ account }: { account: AccountInfo }) {
  return (
    <div className="account-facts">
      <span className="chip">{account.role}</span>
      <span className="chip">{account.quiz_count} quizzes</span>
      {account.warnings > 0 && (
        <span className="chip chip-warn">
          {account.warnings} warning{account.warnings === 1 ? "" : "s"}
        </span>
      )}
      {account.banned_until && (
        <span className="chip chip-bad" title={account.ban_reason ?? ""}>
          banned until {new Date(account.banned_until * 1000).toLocaleDateString()}
        </span>
      )}
      {!!account.times_reported && account.times_reported > 1 && (
        <span className="chip">reported {account.times_reported}× total</span>
      )}
    </div>
  );
}
