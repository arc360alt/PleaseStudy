import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, errorText, store, type Question, type QuestionKind, type Quiz } from "../api";
import { useAuth } from "../auth";
import ImageField from "../components/ImageField";
import ImportKahoot, { ImportSummary, type ImportResult } from "../components/ImportKahoot";
import { Shape, SLOT_NAMES } from "../components/Shapes";

const TIMES = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
const DRAFT_KEY = "ps_draft";

type EditQuestion = Question & { key: number };

let nextKey = 1;
const blankQuestion = (): EditQuestion => ({
  key: nextKey++,
  kind: "single",
  text: "",
  image_url: "",
  time_limit: 20,
  answers: [
    { text: "", correct: true },
    { text: "", correct: false },
    { text: "", correct: false },
    { text: "", correct: false },
  ],
});

const KINDS: [QuestionKind, string, string][] = [
  ["single", "Pick one", "Players tap one box"],
  ["multi", "Pick several", "Players select every correct box, then submit"],
  ["text", "Type answer", "Players type it; capitalization doesn't matter"],
];

/** Convert a question's answers when its type changes, keeping whatever text makes sense. */
function changeKind(q: EditQuestion, kind: QuestionKind): Partial<EditQuestion> {
  const was = q.kind ?? "single";
  if (kind === was) return {};
  if (kind === "text") {
    const keep = q.answers.filter((a) => a.correct && a.text.trim()).map((a) => ({ text: a.text, correct: true }));
    return { kind, answers: keep.length ? keep : [{ text: "", correct: true }] };
  }
  if (was === "text") {
    const first = q.answers.find((a) => a.text.trim())?.text ?? "";
    return {
      kind,
      answers: [
        { text: first, correct: true },
        { text: "", correct: false },
        { text: "", correct: false },
        { text: "", correct: false },
      ],
    };
  }
  return { kind };
}

function problems(title: string, questions: EditQuestion[]): string[] {
  const out: string[] = [];
  if (!title.trim()) out.push("Give your quiz a title.");
  questions.forEach((q, i) => {
    const n = i + 1;
    if (!q.text.trim()) out.push(`Question ${n} has no text.`);
    if (q.kind === "text") {
      if (!q.answers.some((a) => a.text.trim())) out.push(`Question ${n} needs at least one accepted answer.`);
      return;
    }
    if (q.answers.some((a) => !a.text.trim() && !a.image_url?.trim()))
      out.push(`Question ${n} has an answer with no text or image.`);
    q.answers.forEach((a, j) => {
      if (a.image_url?.trim() && !/^https?:\/\//.test(a.image_url.trim()))
        out.push(`Question ${n}, answer ${j + 1}: image link should start with https://`);
    });
    if (!q.answers.some((a) => a.correct)) out.push(`Question ${n} needs a correct answer.`);
    if (q.image_url && !/^https?:\/\//.test(q.image_url.trim())) out.push(`Question ${n}'s image link should start with https://`);
  });
  return out;
}

export default function Editor() {
  const { id } = useParams();
  const { user, ready } = useAuth();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [cover, setCover] = useState("");
  const [questions, setQuestions] = useState<EditQuestion[]>(() => [blankQuestion()]);
  const [loaded, setLoaded] = useState(!id);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  // Which optional image slots are expanded ("q:<key>" for questions, "a:<key>:<index>" for answers).
  const [openImages, setOpenImages] = useState<Set<string>>(new Set());
  const openImage = (k: string) => setOpenImages((s) => new Set(s).add(k));
  const closeImage = (k: string) =>
    setOpenImages((s) => {
      const n = new Set(s);
      n.delete(k);
      return n;
    });

  const location = useLocation();
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<ImportResult | null>(null);

  function applyImport(r: ImportResult) {
    setTitle(r.quiz.title);
    setDescription(r.quiz.description);
    setCover(r.quiz.cover_url ?? "");
    setQuestions(
      r.quiz.questions.map((q) => ({ ...q, kind: q.kind ?? "single", image_url: q.image_url ?? "", key: nextKey++ })),
    );
    setImported(r);
    setImporting(false);
    setShowProblems(false);
    setLoaded(true);
  }

  // Load existing quiz, or restore an unsaved draft for a new one.
  useEffect(() => {
    const fromLibrary = (location.state as { imported?: ImportResult } | null)?.imported;
    if (!id && fromLibrary) {
      applyImport(fromLibrary);
      // Don't re-import on refresh/back; the autosaved draft takes over from here.
      navigate(location.pathname, { replace: true, state: null });
      return;
    }
    if (id) {
      api<Quiz>(`/api/quizzes/${id}`)
        .then((q) => {
          if (!q.can_edit || !q.questions) throw new Error("You can only edit your own quizzes.");
          setTitle(q.title);
          setDescription(q.description);
          setCover(q.cover_url ?? "");
          setQuestions(
            q.questions.map((qq) => ({ ...qq, kind: qq.kind ?? "single", image_url: qq.image_url ?? "", key: nextKey++ })),
          );
          setStatus(q.status);
          setLoaded(true);
        })
        .catch((e) => setError(errorText(e)));
    } else {
      const raw = store.get(DRAFT_KEY);
      if (raw) {
        try {
          const d = JSON.parse(raw);
          setTitle(d.title ?? "");
          setDescription(d.description ?? "");
          setCover(d.cover ?? "");
          if (Array.isArray(d.questions) && d.questions.length)
            setQuestions(d.questions.map((q: Question) => ({ ...q, key: nextKey++ })));
        } catch {
          /* ignore broken draft */
        }
      }
    }
  }, [id]);

  useEffect(() => {
    if (id || !loaded) return;
    const t = setTimeout(
      () => store.set(DRAFT_KEY, JSON.stringify({ title, description, cover, questions })),
      400,
    );
    return () => clearTimeout(t);
  }, [id, loaded, title, description, cover, questions]);

  if (ready && !user) {
    return (
      <div className="empty-state">
        <h1 className="display">Make a quiz</h1>
        <p>You'll need an account to save quizzes. It takes ten seconds.</p>
        <div className="row-wrap center">
          <Link className="btn btn-primary btn-lg" to={`/login?mode=register&next=${id ? `/edit/${id}` : "/create"}`}>
            Sign up
          </Link>
          <Link className="btn btn-lg" to={`/login?next=${id ? `/edit/${id}` : "/create"}`}>
            Log in
          </Link>
        </div>
      </div>
    );
  }
  if (!loaded) return error ? <div className="alert">{error}</div> : <div className="loading">Loading…</div>;

  const update = (i: number, patch: Partial<EditQuestion>) =>
    setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const move = (i: number, d: number) =>
    setQuestions((qs) => {
      const j = i + d;
      if (j < 0 || j >= qs.length) return qs;
      const c = [...qs];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });

  const issues = problems(title, questions);

  async function save() {
    if (issues.length) {
      setShowProblems(true);
      return;
    }
    setSaving(true);
    setError("");
    const body = {
      title,
      description,
      cover_url: cover || null,
      questions: questions.map(({ key: _key, ...q }) => ({
        ...q,
        image_url: q.image_url || null,
        answers:
          q.kind === "text"
            ? q.answers.filter((a) => a.text.trim()).map((a) => ({ text: a.text, correct: true }))
            : q.answers.map((a) => ({ ...a, image_url: a.image_url?.trim() || null })),
      })),
    };
    try {
      const q = await api<Quiz>(id ? `/api/quizzes/${id}` : "/api/quizzes", { method: id ? "PUT" : "POST", body });
      if (!id) store.set(DRAFT_KEY, null);
      navigate(`/q/${q.id}`);
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  }

  return (
    <div className="editor">
      <div className="page-head">
        <div className="row-between">
          <h1 className="display">{id ? "Edit quiz" : "New quiz"}</h1>
          {!id && (
            <button className="btn" onClick={() => setImporting(true)}>
              ⇪ Import from Kahoot
            </button>
          )}
        </div>
        {imported && <ImportSummary result={imported} onDismiss={() => setImported(null)} />}
        {importing && (
          <ImportKahoot
            onClose={() => setImporting(false)}
            onImported={(r) => {
              const hasWork = title.trim() || questions.some((q) => q.text.trim());
              if (hasWork && !confirm("Replace the quiz you're working on with the imported one?")) return;
              applyImport(r);
            }}
          />
        )}
        {status === "approved" && (
          <p className="alert alert-info">This quiz is public. Saving changes sends it back to the moderators.</p>
        )}
      </div>

      <section className="panel editor-meta">
        <label className="field">
          <span>Title</span>
          <input
            className="input input-lg"
            value={title}
            maxLength={120}
            placeholder="e.g. Capitals of the World"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            className="input"
            rows={2}
            maxLength={1000}
            value={description}
            placeholder="What's it about?"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Cover image link (optional)</span>
          <ImageField value={cover} onChange={setCover} placeholder="https://… (an image or GIF hosted elsewhere)" />
        </label>
      </section>

      <ol className="editor-questions">
        {questions.map((q, i) => (
          <li key={q.key} className="panel q-editor">
            <div className="q-editor-head">
              <span className="q-num">{i + 1}</span>
              <div className="q-editor-tools">
                <select
                  className="input input-sm"
                  value={q.time_limit}
                  onChange={(e) => update(i, { time_limit: +e.target.value })}
                  title="Time limit"
                >
                  {TIMES.map((t) => (
                    <option key={t} value={t}>
                      ⏱ {t}s
                    </option>
                  ))}
                </select>
                <button className="icon-btn" title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                  ↑
                </button>
                <button
                  className="icon-btn"
                  title="Move down"
                  onClick={() => move(i, 1)}
                  disabled={i === questions.length - 1}
                >
                  ↓
                </button>
                <button
                  className="icon-btn"
                  title="Duplicate"
                  onClick={() =>
                    setQuestions((qs) => [
                      ...qs.slice(0, i + 1),
                      { ...structuredClone(q), key: nextKey++ },
                      ...qs.slice(i + 1),
                    ])
                  }
                >
                  ⧉
                </button>
                <button
                  className="icon-btn danger"
                  title="Delete question"
                  disabled={questions.length === 1}
                  onClick={() => setQuestions((qs) => qs.filter((_, j) => j !== i))}
                >
                  🗑
                </button>
              </div>
            </div>

            <div className="kind-picker" role="radiogroup" aria-label="Question type">
              {KINDS.map(([k, label, hint]) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={(q.kind ?? "single") === k}
                  className={(q.kind ?? "single") === k ? "on" : ""}
                  title={hint}
                  onClick={() => update(i, changeKind(q, k))}
                >
                  {label}
                </button>
              ))}
            </div>

            <textarea
              className="input q-text-input"
              rows={2}
              maxLength={300}
              placeholder="Type your question…"
              value={q.text}
              onChange={(e) => update(i, { text: e.target.value })}
            />

            {q.image_url || openImages.has(`q:${q.key}`) ? (
              <div className="image-slot">
                <ImageField value={q.image_url ?? ""} onChange={(image_url) => update(i, { image_url })} />
                <button
                  className="link-btn"
                  onClick={() => {
                    update(i, { image_url: "" });
                    closeImage(`q:${q.key}`);
                  }}
                >
                  Remove image
                </button>
              </div>
            ) : (
              <button className="add-image-btn" onClick={() => openImage(`q:${q.key}`)}>
                🖼 Add an image or GIF to the question
              </button>
            )}

            {q.kind === "text" ? (
              <div className="accepted-editor">
                <p className="muted">
                  Accepted answers. Capitalization, extra spaces and punctuation at the ends don't matter, so add
                  other wordings or spellings you'd accept.
                </p>
                {q.answers.map((a, j) => (
                  <div key={j} className="accepted-row">
                    <span className="accepted-check">✓</span>
                    <input
                      className="input"
                      maxLength={120}
                      placeholder={j === 0 ? "The answer" : "Another way to say it"}
                      value={a.text}
                      onChange={(e) =>
                        update(i, { answers: q.answers.map((x, k) => (k === j ? { ...x, text: e.target.value } : x)) })
                      }
                    />
                    {q.answers.length > 1 && (
                      <button
                        className="icon-btn"
                        title="Remove"
                        onClick={() => update(i, { answers: q.answers.filter((_, k) => k !== j) })}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                {q.answers.length < 10 && (
                  <button
                    className="answer-add"
                    onClick={() => update(i, { answers: [...q.answers, { text: "", correct: true }] })}
                  >
                    + Add another accepted answer ({q.answers.length}/10)
                  </button>
                )}
              </div>
            ) : (
            <div className="answer-editor-grid">
              {q.kind === "multi" && (
                <p className="muted grid-note">Mark every correct answer. Players must pick exactly these to get it right.</p>
              )}
              {q.answers.map((a, j) => {
                const imgKey = `a:${q.key}:${j}`;
                const showImg = !!a.image_url || openImages.has(imgKey);
                const setAnswer = (patch: Partial<typeof a>) =>
                  update(i, { answers: q.answers.map((x, k) => (k === j ? { ...x, ...patch } : x)) });
                return (
                <div key={j} className="answer-editor-wrap">
                <div className={`answer-editor slot-edge-${j} ${a.correct ? "is-correct" : ""}`}>
                  <span className={`answer-editor-shape slot-bg-${j}`} title={SLOT_NAMES[j]}>
                    <Shape index={j} size={20} />
                  </span>
                  <input
                    className="answer-editor-input"
                    placeholder={a.image_url ? "Caption (optional)" : `Answer ${j + 1}`}
                    maxLength={120}
                    value={a.text}
                    onChange={(e) =>
                      update(i, { answers: q.answers.map((x, k) => (k === j ? { ...x, text: e.target.value } : x)) })
                    }
                  />
                  <button
                    className={`answer-image-toggle ${showImg ? "on" : ""}`}
                    title={showImg ? "Remove image" : "Add an image"}
                    onClick={() => {
                      if (showImg) {
                        setAnswer({ image_url: null });
                        closeImage(imgKey);
                      } else openImage(imgKey);
                    }}
                  >
                    🖼
                  </button>
                  <button
                    className={`correct-toggle ${a.correct ? "on" : ""}`}
                    title={a.correct ? "Correct answer" : "Mark as correct"}
                    onClick={() =>
                      update(i, { answers: q.answers.map((x, k) => (k === j ? { ...x, correct: !x.correct } : x)) })
                    }
                  >
                    ✓
                  </button>
                  {q.answers.length > 2 && (
                    <button
                      className="answer-remove"
                      title="Remove answer"
                      onClick={() => update(i, { answers: q.answers.filter((_, k) => k !== j) })}
                    >
                      ✕
                    </button>
                  )}
                </div>
                {showImg && (
                  <ImageField compact value={a.image_url ?? ""} onChange={(image_url) => setAnswer({ image_url })} />
                )}
                </div>
                );
              })}
              {q.answers.length < 6 && (
                <button
                  className="answer-add"
                  onClick={() => update(i, { answers: [...q.answers, { text: "", correct: false }] })}
                >
                  + Add answer ({q.answers.length}/6)
                </button>
              )}
            </div>
            )}
          </li>
        ))}
      </ol>

      <button className="add-question" onClick={() => setQuestions((qs) => [...qs, blankQuestion()])}>
        + Add question
      </button>

      <div className="save-bar">
        <span className="muted">
          {questions.length} question{questions.length === 1 ? "" : "s"}
          {!id && " · draft saved on this device"}
        </span>
        {showProblems && issues.length > 0 && (
          <ul className="problems">
            {issues.slice(0, 4).map((p) => (
              <li key={p}>{p}</li>
            ))}
            {issues.length > 4 && <li>…and {issues.length - 4} more</li>}
          </ul>
        )}
        {error && <div className="alert">{error}</div>}
        <button className="btn btn-primary btn-lg" onClick={save} disabled={saving}>
          {saving ? "Saving…" : id ? "Save changes" : "Save quiz"}
        </button>
      </div>
    </div>
  );
}
