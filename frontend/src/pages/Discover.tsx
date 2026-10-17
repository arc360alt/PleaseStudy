import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errorText, type QuizSummary } from "../api";
import QuizCard from "../components/QuizCard";

export default function Discover() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const sort = params.get("sort") ?? "new";
  const [draft, setDraft] = useState(q);
  const [quizzes, setQuizzes] = useState<QuizSummary[] | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setQuizzes(null);
    setPage(0);
    load(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, sort]);

  async function load(p: number, reset = false) {
    try {
      const r = await api<{ quizzes: QuizSummary[]; has_more: boolean }>(
        `/api/quizzes?q=${encodeURIComponent(q)}&sort=${sort}&page=${p}`,
      );
      setQuizzes((prev) => (reset || !prev ? r.quizzes : [...prev, ...r.quizzes]));
      setHasMore(r.has_more);
      setPage(p);
    } catch (e) {
      setError(errorText(e));
      setQuizzes([]);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1 className="display">Discover</h1>
        <p>Every quiz here was checked by a human moderator.</p>
      </div>
      <form
        className="search-row"
        onSubmit={(e) => {
          e.preventDefault();
          setParams({ q: draft, sort });
        }}
      >
        <input
          className="input input-lg"
          placeholder="Search quizzes, topics, creators…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn btn-ink btn-lg">Search</button>
        <div className="seg">
          {[
            ["new", "Newest"],
            ["popular", "Most played"],
          ].map(([k, label]) => (
            <button
              type="button"
              key={k}
              className={sort === k ? "on" : ""}
              onClick={() => setParams({ q, sort: k })}
            >
              {label}
            </button>
          ))}
        </div>
      </form>
      {error && <div className="alert">{error}</div>}
      {quizzes === null ? (
        <div className="loading">Loading…</div>
      ) : quizzes.length === 0 ? (
        <div className="empty-state small">
          <p>{q ? `Nothing matches “${q}”.` : "No public quizzes yet."}</p>
        </div>
      ) : (
        <>
          <div className="quiz-grid">
            {quizzes.map((quiz) => (
              <QuizCard key={quiz.id} quiz={quiz} />
            ))}
          </div>
          {hasMore && (
            <div className="center">
              <button className="btn" onClick={() => load(page + 1)}>
                Load more
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
