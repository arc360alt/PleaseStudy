import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, errorText, getToken, nameOf, store, type Submission } from "../api";
import { Logo } from "../App";
import { useAuth } from "../auth";
import { AnswerPad, ordinal, QuestionMedia, ReadCountdown, TimerBar, useCountdown } from "../components/game";
import { useLiveSocket, type PlayerState } from "../components/live";
import { Shape } from "../components/Shapes";
import { Podium } from "./Host";

type Step = "pin" | "name" | "play";

export default function Join() {
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const [pin, setPin] = useState(params.get("pin") ?? "");
  const [step, setStep] = useState<Step>("pin");
  const [title, setTitle] = useState("");
  const [name, setName] = useState("");
  const [useAccount, setUseAccount] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const rejoinKey = `ps_rejoin_${pin}`;

  async function checkPin(p: string) {
    setBusy(true);
    setError("");
    try {
      const g = await api<{ title: string; joinable: boolean }>(`/api/games/${p}`);
      setTitle(g.title);
      setParams({ pin: p }, { replace: true });
      if (store.get(`ps_rejoin_${p}`, true)) setStep("play");
      else if (!g.joinable) setError("That game has already started.");
      else setStep("name");
    } catch (e) {
      setError(errorText(e).includes("not found") ? "No game with that PIN. Double-check the screen." : errorText(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const p = params.get("pin");
    if (p && /^\d{6}$/.test(p)) checkPin(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (step === "play") {
    return (
      <PlayerGame
        pin={pin}
        name={name}
        token={user && useAccount ? getToken() : null}
        rejoinKey={rejoinKey}
        onLeave={(msg) => {
          store.set(rejoinKey, null, true);
          setError(msg);
          setStep(msg.includes("PIN") || msg.includes("started") || msg.includes("removed") ? "pin" : "name");
        }}
      />
    );
  }

  const digits = pin.replace(/\D/g, "").slice(0, 6);

  return (
    <div className="stage-screen join-screen">
      <header className="stage-bar">
        <Link to="/" className="stage-logo">
          <Logo light />
        </Link>
      </header>
      <div className="stage-center">
        {step === "pin" ? (
          <form
            className="ticket join-ticket"
            onSubmit={(e) => {
              e.preventDefault();
              if (digits.length === 6) checkPin(digits);
            }}
          >
            <div className="ticket-head">
              <span>ADMIT ONE</span>
              <span>LIVE GAME</span>
            </div>
            <label className="ticket-label" htmlFor="join-pin">
              Game PIN
            </label>
            <input
              id="join-pin"
              className="pin-input"
              inputMode="numeric"
              autoFocus
              autoComplete="off"
              placeholder="000000"
              value={digits}
              onChange={(e) => setPin(e.target.value)}
            />
            {error && <div className="alert">{error}</div>}
            <button className="btn btn-lg btn-ink btn-block" disabled={digits.length !== 6 || busy}>
              {busy ? "Checking…" : "Next →"}
            </button>
          </form>
        ) : (
          <form
            className="ticket join-ticket"
            onSubmit={(e) => {
              e.preventDefault();
              if ((user && useAccount) || name.trim()) {
                setError("");
                setStep("play");
              }
            }}
          >
            <div className="ticket-head">
              <span>PIN {pin}</span>
              <span>{title}</span>
            </div>
            {user && useAccount ? (
              <>
                <div className="ticket-label">Joining as</div>
                <div className="join-as">{nameOf(user)}</div>
                <button type="button" className="link-btn" onClick={() => setUseAccount(false)}>
                  Use a nickname instead
                </button>
              </>
            ) : (
              <>
                <label className="ticket-label" htmlFor="nick">
                  Nickname
                </label>
                <input
                  id="nick"
                  className="input input-lg nick-input"
                  autoFocus
                  maxLength={20}
                  value={name}
                  placeholder="Pick something fun"
                  onChange={(e) => setName(e.target.value)}
                />
                {user && (
                  <button type="button" className="link-btn" onClick={() => setUseAccount(true)}>
                    Use {nameOf(user)} instead
                  </button>
                )}
              </>
            )}
            {error && <div className="alert">{error}</div>}
            <button className="btn btn-lg btn-primary btn-block" disabled={!(user && useAccount) && !name.trim()}>
              I'm in!
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function PlayerGame({
  pin,
  name,
  token,
  rejoinKey,
  onLeave,
}: {
  pin: string;
  name: string;
  token: string | null;
  rejoinKey: string;
  onLeave: (msg: string) => void;
}) {
  const [s, setS] = useState<PlayerState | null>(null);
  const [kicked, setKicked] = useState(false);
  const [joined, setJoined] = useState(false);
  const [picked, setPicked] = useState<Submission | null>(null);

  const hello = useMemo(
    () => () => ({ type: "join", pin, name, token, rejoin_key: store.get(rejoinKey, true) }),
    [pin, name, token, rejoinKey],
  );
  const { send, status, stop } = useLiveSocket(kicked ? null : hello, (m) => {
    if (m.type === "joined") {
      store.set(rejoinKey, m.rejoin_key, true);
      setJoined(true);
    } else if (m.type === "player_state") {
      setS(m);
    } else if (m.type === "kicked") {
      store.set(rejoinKey, null, true);
      setKicked(true);
      stop();
    } else if (m.type === "error" && (!joined || /No game|removed|doesn't exist/.test(m.message))) {
      stop();
      onLeave(m.message);
    }
  });

  // Clear the local pick whenever a new question starts.
  useEffect(() => {
    if (s?.phase === "intro") setPicked(null);
  }, [s?.phase, s?.q_index]);

  if (kicked) {
    return (
      <div className="stage-screen">
        <div className="stage-center">
          <div className="panel stage-card">
            <h2 className="display">You've been removed</h2>
            <p>The host removed you from this game.</p>
            <Link to="/" className="btn btn-ink">
              Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`stage-screen player phase-${s?.phase ?? "lobby"} ${s?.result && s.phase === "reveal" ? (s.result.correct ? "res-good" : s.result.partial ? "res-partial" : "res-bad") : s?.phase === "reveal" ? "res-bad" : ""}`}>
      <header className="stage-bar">
        <span className="stage-logo">
          <Logo light />
        </span>
        {s && <span className="stage-title">{s.me.name}</span>}
        {s && s.phase !== "lobby" && s.phase !== "finished" && (
          <span className="stage-pill mono">
            {s.q_index + 1}/{s.q_total}
          </span>
        )}
        {s && <span className="stage-pill stage-score mono">{s.me.score.toLocaleString()}</span>}
        {status !== "open" && <span className="stage-pill warn">reconnecting…</span>}
      </header>
      {!s && <div className="stage-center stage-loading">…</div>}
      {s?.phase === "lobby" && (
        <div className="stage-center">
          <div className="player-wait">
            <div className="wait-shapes">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={`slot-fg-${i}`} style={{ animationDelay: `${i * 120}ms` }}>
                  <Shape index={i} size={44} />
                </span>
              ))}
            </div>
            <h1 className="display">You're in!</h1>
            <p>Look for your name on the big screen.</p>
            <div className="sticker slot-bg-2 big">{s.me.name}</div>
          </div>
        </div>
      )}
      {s?.phase === "intro" && <PlayerIntro s={s} />}
      {s?.phase === "question" && (
        <PlayerQuestion
          s={s}
          picked={picked}
          onPick={(sub) => {
            setPicked(sub);
            send({ type: "answer", ...sub });
          }}
        />
      )}
      {s?.phase === "reveal" && <PlayerReveal s={s} />}
      {s?.phase === "leaderboard" && (
        <div className="stage-center">
          <div className="player-wait">
            <span className="kicker">Look up at the screen</span>
            <h1 className="display rank-big">{s.me.rank ? ordinal(s.me.rank) : "–"}</h1>
            <p>
              {s.me.score.toLocaleString()} points
              {s.ahead && (
                <>
                  <br />
                  <strong>{s.ahead.gap.toLocaleString()}</strong> behind {s.ahead.name}
                </>
              )}
            </p>
          </div>
        </div>
      )}
      {s?.phase === "finished" && (
        <>
          <div className="player-final">
            <span className="kicker">You finished</span>
            <h1 className="display rank-big">{s.me.rank ? ordinal(s.me.rank) : "–"}</h1>
            <p>
              {s.me.score.toLocaleString()} points · {s.player_count} players
            </p>
          </div>
          <Podium standings={s.podium ?? []} highlight={s.me.id} />
          <div className="host-controls">
            <Link
              to="/"
              className="btn btn-light"
              onClick={() => {
                store.set(rejoinKey, null, true);
                stop();
              }}
            >
              Leave
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function PlayerIntro({ s }: { s: PlayerState }) {
  const left = useCountdown(s.time_left_ms, `${s.q_index}-intro`);
  const q = s.question!;
  return (
    <div className="stage-body">
      {q.text ? (
        <>
          <h2 className="question-text">{q.text}</h2>
          <QuestionMedia url={q.image_url} />
        </>
      ) : (
        <p className="player-hint">Read the question on the big screen</p>
      )}
      <ReadCountdown left={left} total={s.phase_total_ms} label={`Question ${s.q_index + 1}`} />
    </div>
  );
}

function PlayerQuestion({
  s,
  picked,
  onPick,
}: {
  s: PlayerState;
  picked: Submission | null;
  onPick: (sub: Submission) => void;
}) {
  const left = useCountdown(s.time_left_ms, `${s.q_index}-q`);
  const q = s.question!;
  const kind = q.kind ?? "single";
  if (s.answered || picked !== null) {
    const boxes = picked?.choices ?? (picked?.choice != null ? [picked.choice] : []);
    return (
      <div className="stage-center">
        <div className="player-wait">
          {boxes.length > 0 && (
            <div className="locked-row">
              {boxes.map((b) => (
                <span key={b} className={`locked-shape slot-bg-${b} ${boxes.length > 1 ? "small" : ""}`}>
                  <Shape index={b} size={boxes.length > 1 ? 36 : 64} />
                </span>
              ))}
            </div>
          )}
          {picked?.text && <div className="locked-text">“{picked.text}”</div>}
          <h1 className="display">Locked in</h1>
          <p>Waiting for everyone else…</p>
          {s.time_left_ms != null && <TimerBar left={left} total={s.phase_total_ms} />}
        </div>
      </div>
    );
  }
  return (
    <div className="stage-body player-question">
      {q.text && <h2 className="question-text small">{q.text}</h2>}
      {q.text && <QuestionMedia url={q.image_url} />}
      {s.time_left_ms != null && <TimerBar left={left} total={s.phase_total_ms} />}
      {kind === "text" && !q.text && <p className="player-hint">Read the question on the big screen, then type your answer</p>}
      <AnswerPad
        kind={kind}
        count={q.answer_count}
        texts={q.answers}
        images={q.answer_images}
        onSubmit={onPick}
        big
      />
    </div>
  );
}

function PlayerReveal({ s }: { s: PlayerState }) {
  const r = s.result;
  const correct = s.question?.correct ?? [];
  return (
    <div className="stage-center">
      <div className="player-result">
        <div className="display verdict-word">
          {r?.correct ? "Correct!" : r?.partial ? "Partly right" : r ? "Wrong" : "Too slow!"}
        </div>
        <div className="verdict-points mono">+{r?.points ?? 0}</div>
        {r?.correct && s.me.streak > 1 && <div className="streak">🔥 Answer streak: {s.me.streak}</div>}
        {!r?.correct && s.question?.kind === "text" && (
          <div className="answer-was">
            {r?.typed && <span className="muted">You typed “{r.typed}”.</span>} Answer:
            {s.question.accepted?.map((a) => (
              <span key={a} className="accepted-chip">
                {a}
              </span>
            ))}
          </div>
        )}
        {!r?.correct && s.question?.kind !== "text" && (
          <div className="answer-was">
            Answer:
            {correct.map((i) => (
              <span key={i} className={`mini-shape slot-bg-${i}`}>
                <Shape index={i} size={20} />
                {s.question?.answers?.[i] && <em>{s.question.answers[i]}</em>}
              </span>
            ))}
          </div>
        )}
        <p className="rank-line">
          You're in <strong>{s.me.rank ? ordinal(s.me.rank) : "–"}</strong> place
          {s.ahead && (
            <>
              , {s.ahead.gap.toLocaleString()} behind {s.ahead.name}
            </>
          )}
        </p>
      </div>
    </div>
  );
}
