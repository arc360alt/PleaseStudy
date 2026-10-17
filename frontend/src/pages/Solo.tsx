import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  api,
  CLASSIC_SETTINGS,
  errorText,
  store,
  type AnswerResult,
  type Assignment,
  type AttemptSummary,
  type NextQuestion,
  type Quiz,
  type StudySettings,
  type Submission,
  KIND_LABEL,
} from "../api";
import { Logo } from "../App";
import { useAuth } from "../auth";
import {
  AnswerPad,
  AnswerResultView,
  QuestionMedia,
  ReadCountdown,
  TimerRing,
  useCountdown,
} from "../components/game";
import { Shape } from "../components/Shapes";
import StudyOptions, { describeSettings } from "../components/StudyOptions";
import { formatDate } from "./Library";

type Q = Extract<NextQuestion, { done: false }>;
type Stage =
  | { kind: "start" }
  | { kind: "loading" }
  | { kind: "intro"; q: Q }
  | { kind: "answer"; q: Q }
  | { kind: "feedback"; q: Q; result: AnswerResult }
  | { kind: "done"; summary: AttemptSummary };

const AUTO_NEXT_MS = 5000;
const PREFS_KEY = "ps_solo_prefs";

function loadPrefs(): { settings: StudySettings; autoAdvance: boolean } {
  try {
    const p = JSON.parse(store.get(PREFS_KEY) ?? "");
    return { settings: { ...CLASSIC_SETTINGS, ...p.settings }, autoAdvance: p.autoAdvance ?? true };
  } catch {
    return { settings: CLASSIC_SETTINGS, autoAdvance: true };
  }
}

export default function Solo() {
  const { quizId, code } = useParams();
  const { user, ready } = useAuth();
  const isAssignment = !!code;
  const storageKey = isAssignment ? `ps_attempt_a_${code}` : `ps_attempt_q_${quizId}`;

  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [settings, setSettings] = useState<StudySettings>(() => loadPrefs().settings);
  const [autoAdvance, setAutoAdvance] = useState(() => loadPrefs().autoAdvance);
  const attemptId = useRef<string | null>(null);

  useEffect(() => {
    if (!isAssignment) store.set(PREFS_KEY, JSON.stringify({ settings, autoAdvance }));
  }, [settings, autoAdvance, isAssignment]);

  const advance = useCallback(async () => {
    if (!attemptId.current) return;
    setStage({ kind: "loading" });
    try {
      const r = await api<NextQuestion>(`/api/attempts/${attemptId.current}/next`, { method: "POST" });
      if (r.done) setStage({ kind: "done", summary: r.summary });
      else setStage(r.read_ms > 0 ? { kind: "intro", q: r } : { kind: "answer", q: r });
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  // Load what we're playing; resume an unfinished run from this tab if there is one.
  useEffect(() => {
    (async () => {
      try {
        if (isAssignment) setAssignment(await api<Assignment>(`/api/assignments/${code}`));
        else setQuiz(await api<Quiz>(`/api/quizzes/${quizId}`));
        const saved = store.get(storageKey, true);
        if (saved) {
          const s = await api<AttemptSummary>(`/api/attempts/${saved}`).catch(() => null);
          if (s && !s.finished) {
            attemptId.current = saved;
            await advance();
            return;
          }
        }
        setStage({ kind: "start" });
      } catch (e) {
        setError(errorText(e));
      }
    })();
  }, [code, quizId, isAssignment, storageKey, advance]);

  async function begin() {
    setError("");
    try {
      const s = await api<AttemptSummary>("/api/attempts", {
        body: isAssignment ? { assignment: code, name } : { quiz_id: quizId, name, settings },
      });
      attemptId.current = s.id;
      store.set(storageKey, s.id, true);
      await advance();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function submit(sub: Submission) {
    if (stage.kind !== "answer") return;
    const q = stage.q;
    setStage({ kind: "loading" });
    try {
      const result = await api<AnswerResult>(`/api/attempts/${attemptId.current}/answer`, { body: sub });
      setStage({ kind: "feedback", q, result });
    } catch (e) {
      setError(errorText(e));
    }
  }

  function playAgain() {
    store.set(storageKey, null, true);
    attemptId.current = null;
    setStage({ kind: "start" });
  }

  const title = assignment?.title ?? quiz?.title ?? "";
  const score =
    stage.kind === "feedback" ? stage.result.score : stage.kind === "intro" || stage.kind === "answer" ? stage.q.score : 0;
  const q = "q" in stage ? stage.q : null;

  return (
    <div className="stage-screen">
      <header className="stage-bar">
        <Link to="/" className="stage-logo">
          <Logo light />
        </Link>
        <span className="stage-title">{title}</span>
        {q &&
          (q.is_retry ? (
            <span className="stage-pill warn">Retry</span>
          ) : (
            <span className="stage-pill mono">
              {q.position}/{q.total}
            </span>
          ))}
        {(stage.kind === "intro" || stage.kind === "answer" || stage.kind === "feedback") && (
          <span className="stage-pill stage-score mono">{score.toLocaleString()}</span>
        )}
      </header>

      {error && (
        <div className="stage-center">
          <div className="panel stage-card">
            <h2 className="display">Uh oh</h2>
            <p>{error}</p>
            <Link className="btn btn-ink" to="/">
              Back home
            </Link>
          </div>
        </div>
      )}

      {!error && stage.kind === "loading" && <div className="stage-center stage-loading">…</div>}

      {!error && stage.kind === "start" && (
        <StartCard
          title={title}
          quiz={quiz}
          assignment={assignment}
          loggedIn={!!user}
          ready={ready}
          name={name}
          setName={setName}
          settings={settings}
          setSettings={setSettings}
          autoAdvance={autoAdvance}
          setAutoAdvance={setAutoAdvance}
          onStart={begin}
        />
      )}

      {!error && stage.kind === "intro" && <IntroStage q={stage.q} onDone={() => setStage({ kind: "answer", q: stage.q })} />}

      {!error && stage.kind === "answer" && <AnswerStage q={stage.q} onPick={submit} />}

      {!error && stage.kind === "feedback" && (
        <FeedbackStage q={stage.q} result={stage.result} onNext={advance} auto={autoAdvance} />
      )}

      {!error && stage.kind === "done" && (
        <DoneStage summary={stage.summary} isAssignment={isAssignment} onAgain={playAgain} quizId={quizId} />
      )}
    </div>
  );
}

function StartCard(props: {
  title: string;
  quiz: Quiz | null;
  assignment: Assignment | null;
  loggedIn: boolean;
  ready: boolean;
  name: string;
  setName: (n: string) => void;
  settings: StudySettings;
  setSettings: (s: StudySettings) => void;
  autoAdvance: boolean;
  setAutoAdvance: (v: boolean) => void;
  onStart: () => void;
}) {
  const { quiz, assignment: a, loggedIn, name, setName, onStart } = props;
  const [showOptions, setShowOptions] = useState(false);
  const count = quiz?.question_count ?? a?.question_count ?? 0;
  const needsLogin = !!a?.require_account && !loggedIn;
  const needsName = !!a && !loggedIn && !a.require_account;
  const closed = !!a && !a.accepting;
  const active = a ? a.settings : props.settings;

  return (
    <div className="stage-center">
      <form
        className="panel stage-card start-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!closed && !needsLogin && (!needsName || name.trim())) onStart();
        }}
      >
        <span className="kicker">{a ? `Assignment from ${a.owner_name}` : "Solo run"}</span>
        <h1 className="display">{props.title}</h1>
        <div className="meta meta-lg">
          <span>{count} questions</span>
          {a?.due_at && <span>due {formatDate(a.due_at)}</span>}
        </div>
        <div className="setting-chips">
          {describeSettings(active).map((d) => (
            <span key={d} className="chip">
              {d}
            </span>
          ))}
        </div>
        {!a && (
          <>
            <button type="button" className="link-btn" onClick={() => setShowOptions(!showOptions)}>
              {showOptions ? "Hide options" : "Study options ▾"}
            </button>
            {showOptions && (
              <StudyOptions
                value={props.settings}
                onChange={props.setSettings}
                autoAdvance={props.autoAdvance}
                onAutoAdvance={props.setAutoAdvance}
              />
            )}
          </>
        )}
        {a && (
          <label className="toggle-row">
            <span>
              <strong>Auto-advance</strong>
              <small className="muted">Move on by itself after showing the answer</small>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={props.autoAdvance}
              onChange={(e) => props.setAutoAdvance(e.target.checked)}
            />
          </label>
        )}
        {closed ? (
          <div className="alert">This assignment is closed.</div>
        ) : needsLogin ? (
          <>
            <div className="alert alert-info">Your teacher wants you to log in for this one.</div>
            <Link className="btn btn-primary btn-lg btn-block" to={`/login?next=/a/${a!.code}`}>
              Log in
            </Link>
          </>
        ) : (
          <>
            {needsName && (
              <label className="field">
                <span>Your name</span>
                <input
                  className="input input-lg"
                  autoFocus
                  maxLength={30}
                  value={name}
                  placeholder="So your teacher knows it's you"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            )}
            <button className="btn btn-primary btn-lg btn-block" disabled={needsName && !name.trim()}>
              Start →
            </button>
            <p className="muted small-print">Tip: press 1–6 on your keyboard to pick an answer.</p>
          </>
        )}
      </form>
    </div>
  );
}

function QuestionHeader({ q }: { q: Q }) {
  return (
    <div className="question-head">
      {q.is_retry && <span className="retry-tag">Try this one again</span>}
      {q.question.kind !== "single" && <span className="kind-tag">{KIND_LABEL[q.question.kind]}</span>}
      <h2 className="question-text">{q.question.text}</h2>
      <QuestionMedia url={q.question.image_url} />
    </div>
  );
}

function IntroStage({ q, onDone }: { q: Q; onDone: () => void }) {
  const left = useCountdown(q.read_ms, q.serial);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const t = setTimeout(() => done.current(), q.read_ms);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="stage-body">
      <QuestionHeader q={q} />
      <ReadCountdown left={left} total={q.read_total_ms} label={q.is_retry ? "Retry" : `Question ${q.position}`} />
    </div>
  );
}

function AnswerStage({ q, onPick }: { q: Q; onPick: (s: Submission) => void }) {
  const left = useCountdown(q.time_ms, q.serial);
  const sent = useRef(false);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const pick = useCallback((s: Submission) => {
    if (sent.current) return;
    sent.current = true;
    pickRef.current(s);
  }, []);

  useEffect(() => {
    if (q.time_ms === null) return;
    const t = setTimeout(() => pick({}), q.time_ms);
    return () => clearTimeout(t);
  }, [q, pick]);

  return (
    <div className="stage-body">
      <div className="question-row">
        <QuestionHeader q={q} />
        {q.time_ms !== null && <TimerRing left={left} total={q.question.time_limit * 1000} />}
      </div>
      <AnswerPad
        kind={q.question.kind}
        count={q.question.answers.length}
        texts={q.question.answers}
        images={q.question.answer_images}
        onSubmit={pick}
        big
      />
      {q.time_ms === null && (
        <div className="stage-actions">
          <button className="btn btn-light" onClick={() => pick({})}>
            I don't know, show me
          </button>
        </div>
      )}
    </div>
  );
}

function FeedbackStage({
  q,
  result,
  onNext,
  auto,
}: {
  q: Q;
  result: AnswerResult;
  onNext: () => void;
  auto: boolean;
}) {
  const left = useCountdown(auto ? AUTO_NEXT_MS : null, q.serial);
  useEffect(() => {
    if (!auto) return;
    const t = setTimeout(onNext, AUTO_NEXT_MS);
    return () => clearTimeout(t);
  }, [onNext, auto]);
  const skipped = !result.answered;
  const word = result.correct ? "Correct!" : result.partial ? "Partly right" : skipped ? (q.time_ms === null ? "Here's the answer" : "Time's up") : "Not quite";

  return (
    <div className="stage-body">
      <div className={`verdict ${result.correct ? "verdict-good" : result.partial ? "verdict-partial" : "verdict-bad"}`}>
        <span className="verdict-word display">{word}</span>
        {!result.is_retry && <span className="verdict-points mono">+{result.points}</span>}
        {result.partial && !result.is_retry && <span className="streak">Half points for getting most of it</span>}
        {result.is_retry && result.correct && <span className="streak">Got it this time</span>}
        {result.streak > 1 && !result.is_retry && <span className="streak">🔥 {result.streak} in a row</span>}
        {result.requeued && <span className="streak">↻ This one will come back later</span>}
      </div>
      <h2 className="question-text small">{q.question.text}</h2>
      <AnswerResultView
        kind={result.kind}
        texts={q.question.answers}
        images={q.question.answer_images}
        count={q.question.answers.length}
        correct={result.correct_indices}
        picked={result.choices ?? (result.choice != null ? [result.choice] : [])}
        typed={result.typed}
        accepted={result.accepted}
        wasCorrect={result.correct}
      />
      <div className="stage-actions">
        <button className="btn btn-lg btn-light next-btn" onClick={onNext} autoFocus>
          {result.is_last ? "See results" : result.remaining > 0 ? "Next question" : "Next"} →
          {auto && <span className="next-progress" style={{ width: `${(1 - left / AUTO_NEXT_MS) * 100}%` }} />}
        </button>
      </div>
    </div>
  );
}

function DoneStage({
  summary,
  isAssignment,
  onAgain,
  quizId,
}: {
  summary: AttemptSummary;
  isAssignment: boolean;
  onAgain: () => void;
  quizId?: string;
}) {
  const pct = summary.total ? Math.round((summary.correct / summary.total) * 100) : 0;
  const retried = summary.review?.filter((r) => r.tries > 1).length ?? 0;
  return (
    <div className="stage-body done">
      <div className="panel stage-card done-card">
        <span className="kicker">{isAssignment ? "Submitted ✓" : "Finished"}</span>
        <h1 className="display done-score mono">{summary.score.toLocaleString()}</h1>
        <p className="done-sub">
          {summary.correct} of {summary.total} right on the first try · {pct}%
        </p>
        {summary.settings.repeat_wrong && retried > 0 && (
          <p className="muted">
            You went back over {retried} question{retried === 1 ? "" : "s"} until you got {retried === 1 ? "it" : "them"} right.
          </p>
        )}
        <div className="row-wrap center">
          {!isAssignment && (
            <button className="btn btn-primary" onClick={onAgain}>
              Play again
            </button>
          )}
          {quizId && (
            <Link className="btn" to={`/q/${quizId}`}>
              Quiz page
            </Link>
          )}
          <Link className="btn btn-ink" to="/">
            Home
          </Link>
        </div>
      </div>
      {summary.review && (
        <ol className="review-list">
          {summary.review.map((r, i) => (
            <li key={i} className={`panel review-item ${r.correct ? "good" : r.partial ? "partial" : "bad"}`}>
              <div className="review-item-head">
                <span className="q-num">{i + 1}</span>
                <p>{r.text}</p>
                <span className="mono">{r.points > 0 ? `+${r.points}` : "0"}</span>
              </div>
              {r.kind === "text" ? (
                <div className="q-preview-answers">
                  {r.typed && (
                    <div className={`mini-answer ${r.correct ? "is-correct" : "is-wrong"}`}>
                      You typed: <strong>{r.typed}</strong>
                    </div>
                  )}
                  {r.answers.map((a) => (
                    <div key={a.text} className="mini-answer is-correct">
                      ✓ {a.text}
                    </div>
                  ))}
                  {!r.typed && <div className="muted">No answer on the first try</div>}
                </div>
              ) : (
                <div className="q-preview-answers">
                  {r.answers.map((a, j) => {
                    const mine = r.choices ? r.choices.includes(j) : r.choice === j;
                    return (
                      <div
                        key={j}
                        className={`mini-answer ${a.correct ? "is-correct" : ""} ${mine && !a.correct ? "is-wrong" : ""}`}
                      >
                        <span className={`slot-fg-${j}`}>
                          <Shape index={j} size={14} />
                        </span>
                        {a.image_url && <img className="mini-thumb" src={a.image_url} alt="" referrerPolicy="no-referrer" />}
                        {a.text}
                        {mine && <em> (you)</em>}
                      </div>
                    );
                  })}
                  {r.choice == null && !r.choices?.length && <div className="muted">No answer on the first try</div>}
                </div>
              )}
              {r.tries > 1 && (
                <small className="muted">
                  {r.mastered ? `Got it after ${r.tries} tries` : `${r.tries} tries`}
                </small>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
