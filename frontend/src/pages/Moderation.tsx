import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { api, errorText, type AccountInfo, type Quiz, type ReportCase, type User } from "../api";
import { isMod, useAuth } from "../auth";
import Modal from "../components/Modal";
import { StatusBadge } from "../components/QuizCard";
import { reasonLabel } from "../components/Report";
import { Shape } from "../components/Shapes";
import StaffActions, { AccountFacts, type StaffAction } from "../components/StaffActions";
import Avatar from "../components/Avatar";
import { formatDate } from "./Library";

type AdminUser = AccountInfo;

export default function Moderation() {
  const { user, ready } = useAuth();
  const [tab, setTab] = useState<"queue" | "reports" | "users">("queue");
  if (ready && !isMod(user)) return <Navigate to="/" replace />;
  return (
    <>
      <div className="page-head">
        <h1 className="display">Moderation</h1>
        <p>Nothing goes public until someone here says yes.</p>
      </div>
      <div className="tabs">
        <button className={tab === "queue" ? "on" : ""} onClick={() => setTab("queue")}>
          Review queue
        </button>
        <button className={tab === "reports" ? "on" : ""} onClick={() => setTab("reports")}>
          Reports
        </button>
        {user?.role === "admin" && (
          <button className={tab === "users" ? "on" : ""} onClick={() => setTab("users")}>
            Users
          </button>
        )}
      </div>
      {tab === "queue" ? <Queue /> : tab === "reports" ? <Reports /> : <Users />}
    </>
  );
}

function Queue() {
  const [quizzes, setQuizzes] = useState<Quiz[] | null>(null);
  const [error, setError] = useState("");

  const load = () =>
    api<{ quizzes: Quiz[] }>("/api/mod/queue")
      .then((r) => setQuizzes(r.quizzes))
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    load();
  }, []);

  if (error) return <div className="alert">{error}</div>;
  if (!quizzes) return <div className="loading">Loading…</div>;
  if (!quizzes.length)
    return (
      <div className="empty-state small">
        <p>The queue is empty. Nice.</p>
      </div>
    );
  return (
    <div className="mod-list">
      {quizzes.map((q) => (
        <ReviewCard key={q.id} quiz={q} onDone={() => setQuizzes((l) => l?.filter((x) => x.id !== q.id) ?? null)} />
      ))}
    </div>
  );
}

function ReviewCard({ quiz, onDone }: { quiz: Quiz; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function review(approve: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/mod/quizzes/${quiz.id}/review`, { body: { approve, note } });
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <article className="panel review-card">
      <header>
        <div>
          <h2>{quiz.title}</h2>
          <div className="meta">
            <span>
              {quiz.owner_name} (@{quiz.owner})
            </span>
            <span>{quiz.question_count} questions</span>
            <span>updated {formatDate(quiz.updated_at)}</span>
            {!quiz.listed && <span>unlisted (link only)</span>}
          </div>
          {quiz.description && <p>{quiz.description}</p>}
        </div>
        {quiz.cover_url && <img className="review-cover" src={quiz.cover_url} alt="" referrerPolicy="no-referrer" />}
      </header>
      <ol className="review-questions">
        {quiz.questions?.map((q, i) => (
          <li key={i}>
            <p>
              <strong>{i + 1}.</strong> {q.text} <span className="chip chip-sm">{q.time_limit}s</span>
              {q.kind && q.kind !== "single" && (
                <span className="chip chip-sm">{q.kind === "multi" ? "pick several" : "typed answer"}</span>
              )}
            </p>
            {q.image_url && (
              <a href={q.image_url} target="_blank" rel="noreferrer noopener" className="review-img-link">
                <img src={q.image_url} alt="" referrerPolicy="no-referrer" />
                <small>{q.image_url}</small>
              </a>
            )}
            <div className="q-preview-answers">
              {q.answers.map((a, j) => (
                <div key={j} className={`mini-answer ${a.correct ? "is-correct" : ""}`}>
                  <span className={`slot-fg-${j}`}>
                    <Shape index={j} size={14} />
                  </span>
                  {a.image_url && <img className="mini-thumb" src={a.image_url} alt="" referrerPolicy="no-referrer" />}
                  {a.text}
                  {a.correct && <b>✓</b>}
                </div>
              ))}
            </div>
          </li>
        ))}
      </ol>
      <footer>
        <input
          className="input"
          placeholder="Note to the creator (required to send back)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {error && <div className="alert">{error}</div>}
        <div className="row-wrap">
          <button className="btn btn-danger" disabled={busy} onClick={() => review(false)}>
            Send back
          </button>
          <button className="btn btn-good" disabled={busy} onClick={() => review(true)}>
            Approve &amp; publish
          </button>
        </div>
      </footer>
    </article>
  );
}

function Users() {
  const { user: me } = useAuth();
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(q)}`)
        .then((r) => setUsers(r.users))
        .catch((e) => setError(errorText(e)));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const [acting, setActing] = useState<AdminUser | null>(null);

  async function act(target: AdminUser, action: StaffAction, message: string, days?: number) {
    const r = await api<{ user: AdminUser | null }>(`/api/admin/users/${target.id}/action`, {
      body: { action, message, days },
    });
    if (action === "delete_account" || !r.user) {
      setUsers((l) => l?.filter((u) => u.id !== target.id) ?? null);
      setActing(null);
    } else {
      setUsers((l) => l?.map((u) => (u.id === target.id ? { ...u, ...r.user! } : u)) ?? null);
      setActing({ ...target, ...r.user });
    }
  }

  async function setRole(id: number, role: string) {
    try {
      await api(`/api/admin/users/${id}/role`, { body: { role } });
      setUsers((l) => l?.map((u) => (u.id === id ? { ...u, role: role as User["role"] } : u)) ?? null);
    } catch (e) {
      alert(errorText(e));
    }
  }

  return (
    <>
      <input className="input" placeholder="Search users…" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <div className="alert">{error}</div>}
      <div className="table-wrap panel">
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Quizzes</th>
              <th>Joined</th>
              <th>Status</th>
              <th>Role</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users?.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link to={`/u/${u.username}`} className="owner-inline">
                    <Avatar url={u.avatar_url} name={u.display_name || u.username} seed={u.id} size={22} />
                    {u.display_name || u.username}
                  </Link>{" "}
                  <small className="muted">@{u.username}</small>
                </td>
                <td className="mono">{u.quiz_count}</td>
                <td>{formatDate(u.created_at)}</td>
                <td>
                  {u.banned_until ? (
                    <span className="chip chip-bad">banned</span>
                  ) : u.warnings > 0 ? (
                    <span className="chip chip-warn">{u.warnings} warning{u.warnings === 1 ? "" : "s"}</span>
                  ) : (
                    <span className="muted">ok</span>
                  )}
                  {!!u.open_reports && <span className="chip chip-sm chip-bad">{u.open_reports} reports</span>}
                </td>
                <td>
                  <select
                    className="input input-sm"
                    value={u.role}
                    disabled={u.id === me?.id}
                    onChange={(e) => setRole(u.id, e.target.value)}
                  >
                    <option value="user">User</option>
                    <option value="moderator">Moderator</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td>
                  {u.id !== me?.id && u.role !== "admin" && (
                    <button className="btn btn-sm" onClick={() => setActing(u)}>
                      Actions
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {acting && (
        <Modal title={`@${acting.username}`} onClose={() => setActing(null)}>
          <AccountFacts account={acting} />
          {acting.banned_until && acting.ban_reason && (
            <p className="muted">Ban reason: {acting.ban_reason}</p>
          )}
          <StaffActions account={acting} onAction={(a, m, d) => act(acting, a, m, d)} />
        </Modal>
      )}
    </>
  );
}

function Reports() {
  const [status, setStatus] = useState<"open" | "closed">("open");
  const [cases, setCases] = useState<ReportCase[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setCases(null);
    api<{ cases: ReportCase[] }>(`/api/mod/reports?status=${status}`)
      .then((r) => setCases(r.cases))
      .catch((e) => setError(errorText(e)));
  }, [status]);

  async function resolve(c: ReportCase, action: StaffAction, message: string, days?: number) {
    await api("/api/mod/reports/resolve", { body: { kind: c.kind, target_id: c.target_id, action, message, days } });
    setCases((l) => l?.filter((x) => !(x.kind === c.kind && x.target_id === c.target_id)) ?? null);
  }

  return (
    <>
      <div className="seg">
        <button className={status === "open" ? "on" : ""} onClick={() => setStatus("open")}>
          Open
        </button>
        <button className={status === "closed" ? "on" : ""} onClick={() => setStatus("closed")}>
          Handled
        </button>
      </div>
      {error && <div className="alert">{error}</div>}
      {!cases ? (
        <div className="loading">Loading…</div>
      ) : cases.length === 0 ? (
        <div className="empty-state small">
          <p>{status === "open" ? "No open reports. All quiet." : "Nothing handled yet."}</p>
        </div>
      ) : (
        <div className="case-list">
          {cases.map((c) => (
            <ReportCaseCard
              key={`${c.kind}-${c.target_id}`}
              c={c}
              open={status === "open"}
              onAction={(a, m, d) => resolve(c, a, m, d)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ReportCaseCard({
  c,
  open,
  onAction,
}: {
  c: ReportCase;
  open: boolean;
  onAction: (a: StaffAction, m: string, d?: number) => Promise<void>;
}) {
  return (
    <article className="panel case-card">
      <div className="case-head">
        <div>
          <span className="kicker">{c.kind === "quiz" ? "Quiz" : "Account"}</span>
          {c.kind === "quiz" ? (
            c.quiz ? (
              <h2>
                <Link to={`/q/${c.quiz.id}`}>{c.quiz.title}</Link> <StatusBadge status={c.quiz.status} />
              </h2>
            ) : (
              <h2 className="muted">Quiz no longer exists</h2>
            )
          ) : c.user ? (
            <>
            <h2>
              <Link to={`/u/${c.user.username}`} className="owner-inline">
                <Avatar url={c.user.avatar_url} name={c.user.display_name || c.user.username} seed={c.user.id} size={30} />
                {c.user.display_name || c.user.username}
              </Link>{" "}
              <small className="muted">@{c.user.username}</small>
            </h2>
            {c.user.bio && <p className="muted case-bio">“{c.user.bio}”</p>}
            </>
          ) : (
            <h2 className="muted">Account no longer exists</h2>
          )}
          {c.kind === "quiz" && c.user && (
            <p className="muted">
              by <Link to={`/u/${c.user.username}`}>{c.user.display_name || c.user.username}</Link> (@{c.user.username})
            </p>
          )}
        </div>
        <span className="case-count">
          {c.reports.length} report{c.reports.length === 1 ? "" : "s"}
        </span>
      </div>

      {c.user && <AccountFacts account={c.user} />}

      <ul className="report-entries">
        {c.reports.map((r) => (
          <li key={r.id} className="report-entry">
            <strong>{reasonLabel(c.kind, r.reason)}</strong>{" "}
            <small className="muted">
              from @{r.reporter ?? "deleted user"} · {formatDate(r.created_at)}
            </small>
            {r.details && <p>{r.details}</p>}
            {!open && r.resolution && (
              <p className="muted">
                → {r.resolution} {r.resolved_by && `(by @${r.resolved_by})`}
              </p>
            )}
          </li>
        ))}
      </ul>

      {c.quiz?.questions && (
        <details className="case-questions">
          <summary>Show the quiz's {c.quiz.questions.length} questions</summary>
          <ol>
            {c.quiz.questions.map((q, i) => (
              <li key={i}>
                {q.text}{" "}
                <span className="muted">
                  ({q.answers.map((a) => (a.correct ? `✓ ${a.text}` : a.text)).join(" · ")})
                </span>
                {q.image_url && (
                  <>
                    {" "}
                    <a href={q.image_url} target="_blank" rel="noreferrer noopener">
                      [image]
                    </a>
                  </>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}

      {open && (c.quiz || c.user) && (
        <StaffActions
          account={c.user}
          quiz={c.quiz ? { id: c.quiz.id, title: c.quiz.title, status: c.quiz.status } : null}
          showDismiss
          onAction={onAction}
        />
      )}
      {open && !c.quiz && !c.user && (
        <div className="action-buttons">
          <button className="btn btn-sm" onClick={() => onAction("dismiss", "Target no longer exists")}>
            Close
          </button>
        </div>
      )}
    </article>
  );
}
