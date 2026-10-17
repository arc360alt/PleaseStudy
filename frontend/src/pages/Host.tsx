import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { store } from "../api";
import { Logo } from "../App";
import { AnswerTile, QuestionMedia, ReadCountdown, TimerRing, useCountdown } from "../components/game";
import { useLiveSocket, type HostState, type Standing } from "../components/live";
import { Shape } from "../components/Shapes";

export default function Host() {
  const { pin = "" } = useParams();
  const hostKey = store.get(`ps_host_${pin}`, true);
  const [state, setState] = useState<HostState | null>(null);
  const [error, setError] = useState("");

  const hello = useMemo(() => (hostKey ? () => ({ type: "host", pin, host_key: hostKey }) : null), [pin, hostKey]);
  const { send, status } = useLiveSocket(hello, (m) => {
    if (m.type === "host_state") {
      setState(m);
      setError("");
    } else if (m.type === "error") setError(m.message);
  });

  if (!hostKey) {
    return (
      <div className="stage-screen">
        <div className="stage-center">
          <div className="panel stage-card">
            <h2 className="display">Not your game</h2>
            <p>Only the browser tab that opened this game can host it. Start a new game from any quiz page.</p>
            <Link to="/discover" className="btn btn-ink">
              Find a quiz
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const next = () => send({ type: "next" });
  const skipQuestion = () =>
    confirm("Skip this question? Nobody gets points for it and the game moves to the next one.") &&
    send({ type: "skip_question" });

  return (
    <div className={`stage-screen host phase-${state?.phase ?? "lobby"}`}>
      <header className="stage-bar">
        <span className="stage-logo">
          <Logo light />
        </span>
        <span className="stage-title">{state?.title}</span>
        {state && state.phase !== "lobby" && state.phase !== "finished" && (
          <span className="stage-pill mono">
            Q {state.q_index + 1}/{state.q_total}
          </span>
        )}
        {state && state.phase !== "lobby" && (
          <span className="stage-pill mono">PIN {pin}</span>
        )}
        {status !== "open" && <span className="stage-pill warn">reconnecting…</span>}
        {state && state.phase !== "finished" && state.phase !== "lobby" && (
          <button
            className="stage-pill stage-btn"
            onClick={() => confirm("End the game now and show final results?") && send({ type: "end" })}
          >
            End game
          </button>
        )}
      </header>

      {error && !state && (
        <div className="stage-center">
          <div className="panel stage-card">
            <h2 className="display">Game over</h2>
            <p>{error}</p>
            <Link to="/" className="btn btn-ink">
              Home
            </Link>
          </div>
        </div>
      )}
      {!state && !error && <div className="stage-center stage-loading">…</div>}

      {state?.phase === "lobby" && <Lobby s={state} onStart={next} onKick={(id) => send({ type: "kick", player_id: id })} />}
      {state?.phase === "intro" && <HostIntro s={state} onSkip={next} onSkipQuestion={skipQuestion} />}
      {state?.phase === "question" && <HostQuestion s={state} onReveal={next} onSkipQuestion={skipQuestion} />}
      {state?.phase === "reveal" && <HostReveal s={state} onNext={next} />}
      {state?.phase === "leaderboard" && <HostLeaderboard s={state} onNext={next} />}
      {state?.phase === "finished" && <Podium standings={state.leaderboard ?? []} />}
    </div>
  );
}

function Lobby({ s, onStart, onKick }: { s: HostState; onStart: () => void; onKick: (id: string) => void }) {
  const joinHost = location.host;
  return (
    <div className="lobby">
      <div className="lobby-join">
        <div className="lobby-url">
          Go to <strong>{joinHost}/join</strong>
        </div>
        <div className="ticket ticket-pin">
          <div className="ticket-head">
            <span>GAME PIN</span>
            <span>{s.settings.show_question_on_devices ? "Questions on devices" : "Big screen mode"}</span>
          </div>
          <div className="big-pin mono">
            {s.pin.slice(0, 3)} {s.pin.slice(3)}
          </div>
        </div>
      </div>
      <div className="lobby-players">
        <div className="lobby-count">
          <span className="mono">{s.players.length}</span> {s.players.length === 1 ? "player" : "players"}
        </div>
        {s.players.length === 0 ? (
          <div className="lobby-waiting">
            Waiting for players
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
          </div>
        ) : (
          <div className="name-stickers">
            {s.players.map((p, i) => (
              <button
                key={p.id}
                className={`sticker slot-bg-${i % 6} ${p.connected ? "" : "away"}`}
                style={{ rotate: `${((i * 37) % 9) - 4}deg` }}
                title="Click to remove"
                onClick={() => confirm(`Remove ${p.name}?`) && onKick(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="lobby-actions">
        <button className="btn btn-xl btn-primary" disabled={s.players.length === 0} onClick={onStart}>
          Start game →
        </button>
      </div>
    </div>
  );
}

function HostIntro({ s, onSkip, onSkipQuestion }: { s: HostState; onSkip: () => void; onSkipQuestion: () => void }) {
  const left = useCountdown(s.time_left_ms, `${s.q_index}-intro`);
  return (
    <div className="stage-body host-intro">
      <h1 className="question-text huge">{s.question!.text}</h1>
      <QuestionMedia url={s.question!.image_url} />
      <ReadCountdown left={left} total={s.phase_total_ms} label={`Question ${s.q_index + 1} of ${s.q_total}`} />
      <div className="host-controls">
        <button className="btn btn-light" onClick={onSkip}>
          Skip countdown
        </button>
        <button className="btn btn-light" onClick={onSkipQuestion}>
          Skip question
        </button>
      </div>
    </div>
  );
}

function HostQuestion({
  s,
  onReveal,
  onSkipQuestion,
}: {
  s: HostState;
  onReveal: () => void;
  onSkipQuestion: () => void;
}) {
  const left = useCountdown(s.time_left_ms, `${s.q_index}-q`);
  const q = s.question!;
  const timed = s.time_left_ms != null;
  const waiting = s.waiting ?? [];
  return (
    <div className="stage-body host-question">
      {q.kind && q.kind !== "single" && (
        <span className="kind-tag center-self">{q.kind === "multi" ? "Pick all that apply" : "Type the answer"}</span>
      )}
      <h1 className="question-text big">{q.text}</h1>
      <div className="host-mid">
        {timed ? (
          <TimerRing left={left} total={s.phase_total_ms} size={130} />
        ) : (
          <div className="no-timer-badge">
            No timer
            <small>waiting for everyone</small>
          </div>
        )}
        <div className="host-media">
          <QuestionMedia url={q.image_url} />
        </div>
        <div className="answered-count">
          <strong className="mono">{s.answered}</strong>
          <span>of {s.players.length} answered</span>
        </div>
      </div>
      {waiting.length > 0 && waiting.length <= 12 && (
        <div className="waiting-on">
          <span>Waiting on</span>
          {waiting.map((p) => (
            <span key={p.id} className={`waiting-chip ${p.connected ? "" : "away"}`} title={p.connected ? "" : "Disconnected"}>
              {p.name}
              {!p.connected && " ⚠"}
            </span>
          ))}
        </div>
      )}
      {q.kind === "text" ? (
        <div className="type-on-device">⌨ Type your answer on your device</div>
      ) : (
        <div className={`tile-grid tiles-${q.answers.length}`}>
          {q.answers.map((t, i) => (
            <AnswerTile key={i} index={i} text={t} image={q.answer_images?.[i]} />
          ))}
        </div>
      )}
      <div className="host-controls">
        <button className="btn btn-light" onClick={onReveal}>
          Reveal answer now
        </button>
        <button className="btn btn-light" onClick={onSkipQuestion}>
          Skip question
        </button>
      </div>
    </div>
  );
}

function HostReveal({ s, onNext }: { s: HostState; onNext: () => void }) {
  const q = s.question!;
  const counts = s.counts ?? q.answers.map(() => 0);
  // Multi-select answers count once per box picked, so percentages are out of people who answered.
  const answeredTotal = s.answered;
  const max = Math.max(1, ...counts);
  const correct = q.correct ?? [];
  const totalPlayers = s.players.length;
  const pct = totalPlayers ? Math.round(((s.correct_count ?? 0) / totalPlayers) * 100) : 0;
  const last = s.q_index + 1 >= s.q_total;

  return (
    <div className="stage-body host-reveal">
      <h1 className="question-text big">{q.text}</h1>
      <div className="reveal-main">
        <div className="pct-badge">
          <span className="mono">{pct}%</span>
          <small>
            got it right
            <br />
            {s.correct_count ?? 0} of {totalPlayers} players
            {!!s.partial_count && (
              <>
                <br />+{s.partial_count} partly right
              </>
            )}
          </small>
        </div>
        {q.kind === "text" ? (
          <div className="typed-board">
            <div className="typed-accepted">
              <small>{(q.accepted?.length ?? 0) > 1 ? "Accepted answers" : "Answer"}</small>
              <div>
                {q.accepted?.map((a) => (
                  <span key={a} className="accepted-chip">
                    {a}
                  </span>
                ))}
              </div>
            </div>
            {(s.typed?.length ?? 0) > 0 && (
              <ul className="typed-list">
                {s.typed!.map((t) => (
                  <li key={t.text} className={t.correct ? "good" : "bad"}>
                    <span>{t.text}</span>
                    <span className="mono">×{t.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
        <div className="bars">
          {q.answers.map((_, i) => (
            <div key={i} className={`bar-col ${correct.includes(i) ? "is-correct" : "is-wrong"}`}>
              <span className="bar-count mono">{counts[i]}</span>
              <div className={`bar slot-bg-${i}`} style={{ height: `${(counts[i] / max) * 100}%` }} />
              <span className={`bar-shape slot-bg-${i}`}>
                <Shape index={i} size={22} />
                {correct.includes(i) && <b>✓</b>}
              </span>
              <span className="bar-pct mono">
                {answeredTotal ? Math.round((counts[i] / answeredTotal) * 100) : 0}%
              </span>
            </div>
          ))}
        </div>
        )}
      </div>
      {q.kind !== "text" && (
        <div className={`tile-grid tiles-${q.answers.length} compact`}>
          {q.answers.map((t, i) => (
            <AnswerTile
              key={i}
              index={i}
              text={t}
              image={q.answer_images?.[i]}
              state={correct.includes(i) ? "correct" : "dim"}
            />
          ))}
        </div>
      )}
      <div className="host-controls">
        <button className="btn btn-xl btn-primary" onClick={onNext}>
          {last ? "Final results →" : "Leaderboard →"}
        </button>
      </div>
    </div>
  );
}

function HostLeaderboard({ s, onNext }: { s: HostState; onNext: () => void }) {
  const list = s.leaderboard ?? [];
  return (
    <div className="stage-body host-leaderboard">
      <h1 className="display board-title">Leaderboard</h1>
      <ol className="board">
        {list.map((p, i) => (
          <BoardRow key={p.id} p={p} i={i} />
        ))}
      </ol>
      <div className="host-controls">
        <button className="btn btn-xl btn-primary" onClick={onNext}>
          Next question →
        </button>
      </div>
    </div>
  );
}

function BoardRow({ p, i }: { p: Standing; i: number }) {
  const moved = p.prev_rank ? p.prev_rank - p.rank : 0;
  return (
    <li className="board-row" style={{ animationDelay: `${i * 70}ms` }}>
      <span className="board-rank mono">{p.rank}</span>
      <span className="board-name">
        {p.name}
        {p.streak > 1 && <small className="streak"> 🔥{p.streak}</small>}
      </span>
      {moved !== 0 && <span className={`board-move ${moved > 0 ? "up" : "down"}`}>{moved > 0 ? `▲${moved}` : `▼${-moved}`}</span>}
      {p.last_points > 0 && <span className="board-gain mono">+{p.last_points}</span>}
      <span className="board-score mono">{p.score.toLocaleString()}</span>
    </li>
  );
}

export function Podium({ standings, highlight }: { standings: Standing[]; highlight?: string }) {
  const [first, second, third] = standings;
  const order = [second, first, third];
  const rest = standings.slice(3);
  return (
    <div className="stage-body podium-wrap">
      <h1 className="display board-title">Final results</h1>
      <div className="podium">
        {order.map((p, i) =>
          p ? (
            <div key={p.id} className={`podium-spot place-${p.rank} ${p.id === highlight ? "me" : ""}`}>
              <div className="podium-name">{p.name}</div>
              <div className="podium-score mono">{p.score.toLocaleString()}</div>
              <div className="podium-block">
                <span className="display">{p.rank}</span>
              </div>
            </div>
          ) : (
            <div key={i} className="podium-spot empty" />
          ),
        )}
      </div>
      {rest.length > 0 && (
        <ol className="board board-rest">
          {rest.map((p, i) => (
            <BoardRow key={p.id} p={p} i={i} />
          ))}
        </ol>
      )}
      {!highlight && (
        <div className="host-controls">
          <Link to="/" className="btn btn-light">
            Done
          </Link>
        </div>
      )}
    </div>
  );
}
