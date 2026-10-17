import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { api, errorText, type Assignment, type QuizSummary } from "../api";
import { useAuth } from "../auth";
import QuizCard from "../components/QuizCard";
import ImportKahoot from "../components/ImportKahoot";

export function formatDate(secs: number) {
  return new Date(secs * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function Library() {
  const { user, ready } = useAuth();
  const navigate = useNavigate();
  const [importing, setImporting] = useState(false);
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "assignments" ? "assignments" : "quizzes";
  const [quizzes, setQuizzes] = useState<QuizSummary[] | null>(null);
  const [assignments, setAssignments] = useState<Assignment[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    api<{ quizzes: QuizSummary[] }>("/api/quizzes/mine")
      .then((r) => setQuizzes(r.quizzes))
      .catch((e) => setError(errorText(e)));
    api<{ assignments: Assignment[] }>("/api/assignments/mine")
      .then((r) => setAssignments(r.assignments))
      .catch((e) => setError(errorText(e)));
  }, [user]);

  if (ready && !user) return <Navigate to="/login?next=/library" replace />;

  async function toggle(code: string) {
    try {
      const a = await api<Assignment>(`/api/assignments/${code}/toggle`, { method: "POST" });
      setAssignments((list) => list?.map((x) => (x.code === code ? { ...x, ...a } : x)) ?? null);
    } catch (e) {
      alert(errorText(e));
    }
  }

  async function remove(code: string) {
    if (!confirm("Delete this assignment and all of its results?")) return;
    try {
      await api(`/api/assignments/${code}`, { method: "DELETE" });
      setAssignments((list) => list?.filter((x) => x.code !== code) ?? null);
    } catch (e) {
      alert(errorText(e));
    }
  }

  return (
    <>
      <div className="page-head row-between">
        <h1 className="display">Library</h1>
        <div className="row-wrap">
          <button className="btn" onClick={() => setImporting(true)}>
            ⇪ Import from Kahoot
          </button>
          <Link to="/create" className="btn btn-primary">
            + New quiz
          </Link>
        </div>
        {importing && (
          <ImportKahoot
            onClose={() => setImporting(false)}
            onImported={(r) => navigate("/create", { state: { imported: r } })}
          />
        )}
      </div>
      <div className="tabs">
        <button className={tab === "quizzes" ? "on" : ""} onClick={() => setParams({})}>
          My quizzes {quizzes && <span className="count">{quizzes.length}</span>}
        </button>
        <button className={tab === "assignments" ? "on" : ""} onClick={() => setParams({ tab: "assignments" })}>
          Assignments {assignments && <span className="count">{assignments.length}</span>}
        </button>
      </div>
      {error && <div className="alert">{error}</div>}

      {tab === "quizzes" &&
        (quizzes === null ? (
          <div className="loading">Loading…</div>
        ) : quizzes.length === 0 ? (
          <div className="empty-state small">
            <p>You haven't made any quizzes yet.</p>
            <Link className="btn btn-primary" to="/create">
              Make your first
            </Link>
          </div>
        ) : (
          <div className="quiz-grid">
            {quizzes.map((q) => (
              <QuizCard key={q.id} quiz={q} showStatus />
            ))}
          </div>
        ))}

      {tab === "assignments" &&
        (assignments === null ? (
          <div className="loading">Loading…</div>
        ) : assignments.length === 0 ? (
          <div className="empty-state small">
            <p>No assignments yet. Open any quiz and press “Assign” to make a link.</p>
          </div>
        ) : (
          <div className="assignment-list">
            {assignments.map((a) => (
              <div key={a.code} className="panel assignment-row">
                <div className="assignment-main">
                  <span className={`badge ${a.accepting ? "badge-approved" : "badge-private"}`}>
                    {a.accepting ? "Open" : "Closed"}
                  </span>
                  <h3>{a.title}</h3>
                  <div className="meta">
                    <span>{a.quiz_title}</span>
                    <span>{a.question_count} Qs</span>
                    {a.due_at && <span>due {formatDate(a.due_at)}</span>}
                    {a.require_account && <span>accounts only</span>}
                  </div>
                </div>
                <div className="assignment-stat">
                  <strong>{a.submissions ?? 0}</strong>
                  <small>done</small>
                </div>
                <div className="row-wrap">
                  <button
                    className="btn btn-sm"
                    onClick={(e) => {
                      navigator.clipboard?.writeText(`${location.origin}/a/${a.code}`);
                      e.currentTarget.textContent = "Copied!";
                    }}
                  >
                    Copy link
                  </button>
                  <Link className="btn btn-sm btn-ink" to={`/assignments/${a.code}/results`}>
                    Results
                  </Link>
                  <button className="btn btn-sm" onClick={() => toggle(a.code)}>
                    {a.open ? "Close" : "Reopen"}
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => remove(a.code)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
    </>
  );
}
