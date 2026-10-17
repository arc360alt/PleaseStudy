import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, CLASSIC_SETTINGS, errorText, KIND_LABEL, store, type Assignment, type Quiz, type StudySettings } from "../api";
import { useAuth } from "../auth";
import Modal, { CopyField, Toggle } from "../components/Modal";
import { Cover, StatusBadge } from "../components/QuizCard";
import ReportButton from "../components/Report";
import Avatar from "../components/Avatar";
import { Shape } from "../components/Shapes";
import StudyOptions, { PartialCreditField } from "../components/StudyOptions";
import type { PartialCredit } from "../api";

// -1 = no timer (wait for everyone), 0 = each question's own timer.
const TIME_OPTIONS = [0, -1, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];

export default function QuizPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<"host" | "assign" | null>(null);

  useEffect(() => {
    setQuiz(null);
    api<Quiz>(`/api/quizzes/${id}`)
      .then(setQuiz)
      .catch((e) => setError(errorText(e)));
  }, [id, user]);

  if (error) return <div className="empty-state"><h1 className="display">Hmm.</h1><p>{error}</p></div>;
  if (!quiz) return <div className="loading">Loading…</div>;

  async function action(path: string, method = "POST", body?: unknown) {
    try {
      const r = await api<Quiz>(`/api/quizzes/${quiz!.id}/${path}`, { method, body });
      setQuiz(r);
    } catch (e) {
      alert(errorText(e));
    }
  }

  async function remove() {
    if (!confirm(`Delete “${quiz!.title}” for good?`)) return;
    try {
      await api(`/api/quizzes/${quiz!.id}`, { method: "DELETE" });
      navigate("/library");
    } catch (e) {
      alert(errorText(e));
    }
  }

  return (
    <>
      <section className="quiz-hero">
        <Cover quiz={quiz} />
        <div className="quiz-hero-body">
          {quiz.can_edit && <StatusBadge status={quiz.status} listed={quiz.listed} />}
          <h1 className="display">{quiz.title}</h1>
          {quiz.description && <p className="quiz-desc">{quiz.description}</p>}
          <div className="meta meta-lg">
            <span>
              <Link className="owner-chip" to={`/u/${quiz.owner}`}>
                <Avatar url={quiz.owner_avatar} name={quiz.owner_name} seed={quiz.owner_id} size={26} />
                {quiz.owner_name}
              </Link>
            </span>
            <span>{quiz.question_count} questions</span>
            <span>{quiz.plays} plays</span>
          </div>
          {!quiz.can_edit && (
            <div className="row-wrap">
              <ReportButton kind="quiz" target={quiz.id} label="Report quiz" />
              <ReportButton kind="user" target={quiz.owner} name={quiz.owner_name} label={`Report ${quiz.owner_name}`} />
            </div>
          )}
          <div className="mode-buttons">
            <Link to={`/play/${quiz.id}`} className="mode-btn slot-bg-3">
              <Shape index={3} size={26} />
              <span>
                <strong>Play solo</strong>
                <small>Just you vs. the clock</small>
              </span>
            </Link>
            <button className="mode-btn slot-bg-1" onClick={() => setModal("host")}>
              <Shape index={1} size={26} />
              <span>
                <strong>Host live</strong>
                <small>Big screen + phones</small>
              </span>
            </button>
            <button
              className="mode-btn slot-bg-4"
              onClick={() => (user ? setModal("assign") : navigate(`/login?next=/q/${quiz.id}`))}
            >
              <Shape index={4} size={26} />
              <span>
                <strong>Assign</strong>
                <small>{user ? "Share a solo link" : "Log in to assign"}</small>
              </span>
            </button>
          </div>
        </div>
      </section>

      {quiz.can_edit && (
        <section className="panel owner-panel">
          <div>
            <h3>Your quiz</h3>
            {quiz.status === "private" && (
              <p className="muted">Only you can see it. You can still host it and assign it.</p>
            )}
            {quiz.status === "pending" && <p className="muted">A moderator will look at it soon.</p>}
            {quiz.status === "approved" &&
              (quiz.listed ? (
                <p className="muted">It's public. Editing it sends it back for review.</p>
              ) : (
                <p className="muted">
                  It's approved but unlisted: it doesn't show on Discover, but anyone with the link can play it.
                </p>
              ))}
            {quiz.status === "rejected" && (
              <p>
                <strong>Moderator note:</strong> {quiz.mod_note ?? "No note given."}
              </p>
            )}
          </div>
          <div className="row-wrap">
            <Link className="btn" to={`/edit/${quiz.id}`}>
              Edit
            </Link>
            {(quiz.status === "private" || quiz.status === "rejected") && (
              <button className="btn btn-primary" onClick={() => action("submit")}>
                Submit to go public
              </button>
            )}
            {(quiz.status === "approved" || quiz.status === "pending") && (
              <button className="btn" onClick={() => action("unpublish")}>
                Make private
              </button>
            )}
            <button className="btn btn-danger" onClick={remove}>
              Delete
            </button>
          </div>
          <label className="toggle-row listing-toggle">
            <span>
              <strong>Listed on Discover</strong>
              <small className="muted">
                {quiz.listed
                  ? "Once approved it shows on Discover, search and your profile."
                  : "Hidden from Discover. Share the link to let people play it (it still needs approval first)."}
              </small>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={quiz.listed}
              onChange={(e) => action("listing", "POST", { listed: e.target.checked })}
            />
          </label>
        </section>
      )}

      {quiz.questions && (
        <section>
          <div className="section-head">
            <h2 className="display">Questions</h2>
            <span className="muted">Only you and moderators can see answers</span>
          </div>
          <ol className="q-preview-list">
            {quiz.questions.map((q, i) => (
              <li key={i} className="panel q-preview">
                <div className="q-preview-head">
                  <span className="q-num">{i + 1}</span>
                  <p>{q.text}</p>
                  {q.kind && q.kind !== "single" && <span className="chip">{KIND_LABEL[q.kind]}</span>}
                  <span className="chip">{q.time_limit}s</span>
                </div>
                {q.image_url && <img className="q-preview-img" src={q.image_url} alt="" referrerPolicy="no-referrer" />}
                <div className="q-preview-answers">
                  {q.answers.map((a, j) => (
                    <div key={j} className={`mini-answer ${a.correct ? "is-correct" : ""}`}>
                      {q.kind !== "text" && (
                        <span className={`slot-fg-${j}`}>
                          <Shape index={j} size={16} />
                        </span>
                      )}
                      {a.image_url && <img className="mini-thumb" src={a.image_url} alt="" referrerPolicy="no-referrer" />}
                      {a.text}
                      {a.correct && <b>✓</b>}
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {modal === "host" && <HostSetup quiz={quiz} onClose={() => setModal(null)} />}
      {modal === "assign" && <AssignSetup quiz={quiz} onClose={() => setModal(null)} />}
    </>
  );
}

function HostSetup({ quiz, onClose }: { quiz: Quiz; onClose: () => void }) {
  const navigate = useNavigate();
  const [showOnDevices, setShowOnDevices] = useState(false);
  const [timeLimit, setTimeLimit] = useState(0);
  const [readSeconds, setReadSeconds] = useState(5);
  const [shuffle, setShuffle] = useState(false);
  const [lateJoin, setLateJoin] = useState(true);
  const [partial, setPartial] = useState<PartialCredit>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    setBusy(true);
    try {
      const r = await api<{ pin: string; host_key: string }>("/api/games", {
        body: {
          quiz_id: quiz.id,
          settings: {
            show_question_on_devices: showOnDevices,
            time_limit: timeLimit > 0 ? timeLimit : null,
            no_timer: timeLimit === -1,
            read_seconds: readSeconds,
            shuffle_questions: shuffle,
            allow_late_join: lateJoin,
            multi_partial: partial,
          },
        },
      });
      store.set(`ps_host_${r.pin}`, r.host_key, true);
      navigate(`/host/${r.pin}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="Host a live game" onClose={onClose}>
      <p className="muted">
        Open this on the screen everyone can see. Players join on their own devices with the PIN. They don't need an
        account.
      </p>
      <div className="seg seg-full seg-tall">
        <button className={!showOnDevices ? "on" : ""} onClick={() => setShowOnDevices(false)}>
          <strong>Big screen only</strong>
          <small>Phones just show colored shapes</small>
        </button>
        <button className={showOnDevices ? "on" : ""} onClick={() => setShowOnDevices(true)}>
          <strong>Screen + devices</strong>
          <small>Question &amp; answers on phones too</small>
        </button>
      </div>
      <div className="field-row">
        <label className="field">
          <span>Answer timer</span>
          <select className="input" value={timeLimit} onChange={(e) => setTimeLimit(+e.target.value)}>
            {TIME_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t === 0
                  ? "Use each question's timer"
                  : t === -1
                    ? "No timer: wait for everyone"
                    : `${t} seconds, every question`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Read-the-question countdown</span>
          <select className="input" value={readSeconds} onChange={(e) => setReadSeconds(+e.target.value)}>
            {[3, 5, 8, 10, 15].map((t) => (
              <option key={t} value={t}>
                {t} seconds
              </option>
            ))}
          </select>
        </label>
      </div>
      <Toggle checked={shuffle} onChange={setShuffle} label="Shuffle question order" />
      <Toggle
        checked={lateJoin}
        onChange={setLateJoin}
        label="Let people join late"
        hint="Players can hop in after the game starts"
      />
      <h3 className="options-head">Scoring</h3>
      <PartialCreditField value={partial} onChange={setPartial} />
      {error && <div className="alert">{error}</div>}
      <button className="btn btn-primary btn-lg btn-block" disabled={busy} onClick={start}>
        {busy ? "Opening lobby…" : "Open the lobby"}
      </button>
    </Modal>
  );
}

function AssignSetup({ quiz, onClose }: { quiz: Quiz; onClose: () => void }) {
  const [title, setTitle] = useState(quiz.title);
  const [due, setDue] = useState("");
  const [requireAccount, setRequireAccount] = useState(false);
  const [settings, setSettings] = useState<StudySettings>(CLASSIC_SETTINGS);
  const [created, setCreated] = useState<Assignment | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError("");
    try {
      const a = await api<Assignment>("/api/assignments", {
        body: {
          quiz_id: quiz.id,
          title,
          due_at: due ? Math.floor(new Date(due).getTime() / 1000) : null,
          require_account: requireAccount,
          settings,
        },
      });
      setCreated(a);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const link = `${location.origin}/a/${created.code}`;
    return (
      <Modal title="Assignment ready" onClose={onClose}>
        <p>Anyone with this link can take it solo. Their scores show up in your library.</p>
        <CopyField value={link} />
        <div className="row-wrap">
          <Link className="btn btn-ink" to={`/assignments/${created.code}/results`}>
            View results
          </Link>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Assign this quiz" onClose={onClose}>
      <p className="muted">
        This makes a shareable link. Everyone plays solo at their own pace. Questions are locked in as they are now,
        so later edits won't change it.
      </p>
      <label className="field">
        <span>Assignment name</span>
        <input className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        <span>Due (optional)</span>
        <input className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
      </label>
      <Toggle
        checked={requireAccount}
        onChange={setRequireAccount}
        label="Require an account"
        hint="One attempt per person. Otherwise anyone can play by typing a name."
      />
      <h3 className="options-head">Scoring</h3>
      <PartialCreditField
        value={settings.multi_partial}
        onChange={(multi_partial) => setSettings({ ...settings, multi_partial })}
      />
      <h3 className="options-head">How it plays</h3>
      <StudyOptions value={settings} onChange={setSettings} hidePartial />
      <p className="muted small-print">Grades only count each student's first try at every question.</p>
      {error && <div className="alert">{error}</div>}
      <button className="btn btn-primary btn-lg btn-block" onClick={create} disabled={busy}>
        Create link
      </button>
    </Modal>
  );
}
