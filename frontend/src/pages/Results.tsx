import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorText, type Assignment } from "../api";
import { CopyField } from "../components/Modal";
import { formatDate } from "./Library";

type ResultsData = {
  assignment: Assignment;
  attempts: {
    name: string;
    username: string | null;
    score: number;
    correct: number;
    answered: number;
    started_at: number;
    finished_at: number | null;
  }[];
  questions: { text: string; answered: number; correct: number }[];
};

export default function Results() {
  const { code } = useParams();
  const [data, setData] = useState<ResultsData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = () =>
      api<ResultsData>(`/api/assignments/${code}/results`)
        .then(setData)
        .catch((e) => setError(errorText(e)));
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [code]);

  if (error) return <div className="alert">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const { assignment: a, attempts, questions } = data;
  const finished = attempts.filter((t) => t.finished_at);
  const avg = finished.length
    ? Math.round((finished.reduce((s, t) => s + t.correct, 0) / (finished.length * a.question_count)) * 100)
    : null;

  return (
    <>
      <div className="page-head">
        <Link to="/library?tab=assignments" className="link-arrow">
          ← Assignments
        </Link>
        <h1 className="display">{a.title}</h1>
        <div className="meta meta-lg">
          <span>{a.quiz_title}</span>
          <span>{a.accepting ? "Open" : "Closed"}</span>
          {a.due_at && <span>due {formatDate(a.due_at)}</span>}
        </div>
      </div>

      <CopyField value={`${location.origin}/a/${a.code}`} />

      <div className="stat-row">
        <div className="stat panel">
          <strong>{finished.length}</strong>
          <span>finished</span>
        </div>
        <div className="stat panel">
          <strong>{attempts.length - finished.length}</strong>
          <span>in progress</span>
        </div>
        <div className="stat panel">
          <strong>{avg === null ? "–" : `${avg}%`}</strong>
          <span>average correct</span>
        </div>
      </div>

      <section>
        <h2 className="display">Players</h2>
        {attempts.length === 0 ? (
          <div className="empty-state small">
            <p>Nobody has started yet. Share the link above.</p>
          </div>
        ) : (
          <div className="table-wrap panel">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Score</th>
                  <th>Correct</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((t, i) => (
                  <tr key={i}>
                    <td className="mono">{t.finished_at ? i + 1 : "–"}</td>
                    <td>
                      {t.name}
                      {t.username && (
                        <Link to={`/u/${t.username}`} className="chip chip-sm" title="Signed in with an account">
                          account
                        </Link>
                      )}
                    </td>
                    <td className="mono">{t.score.toLocaleString()}</td>
                    <td className="mono">
                      {t.correct}/{a.question_count}
                    </td>
                    <td>
                      {t.finished_at ? (
                        formatDate(t.finished_at)
                      ) : (
                        <span className="muted">
                          playing ({t.answered}/{a.question_count})
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="display">By question</h2>
        <ol className="q-stats">
          {questions.map((q, i) => {
            const pct = q.answered ? Math.round((q.correct / q.answered) * 100) : 0;
            return (
              <li key={i} className="q-stat">
                <span className="q-num">{i + 1}</span>
                <span className="q-stat-text">{q.text}</span>
                <span className="q-stat-bar">
                  <span
                    style={{ width: `${pct}%` }}
                    className={pct >= 70 ? "good" : pct >= 40 ? "ok" : "bad"}
                  />
                </span>
                <span className="mono">{q.answered ? `${pct}%` : "–"}</span>
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}
