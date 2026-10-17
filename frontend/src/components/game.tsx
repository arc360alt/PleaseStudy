import { useEffect, useRef, useState } from "react";
import type { QuestionKind, Submission } from "../api";
import { Shape } from "./Shapes";

/** Counts down from `ms` (as of the moment `ms` changes). Returns ms remaining. */
export function useCountdown(ms: number | null | undefined, key: unknown) {
  const end = useRef(0);
  const [left, setLeft] = useState(ms ?? 0);
  useEffect(() => {
    if (ms == null) return;
    end.current = performance.now() + ms;
    setLeft(ms);
    let raf = 0;
    const tick = () => {
      const l = Math.max(0, end.current - performance.now());
      setLeft(l);
      if (l > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, key]);
  return left;
}

export function TimerRing({ left, total, size = 96 }: { left: number; total: number; size?: number }) {
  const frac = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
  const r = 42;
  const c = 2 * Math.PI * r;
  const urgent = left < 5000 && left > 0;
  return (
    <div className={`timer-ring ${urgent ? "urgent" : ""}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} className="timer-track" />
        <circle
          cx="50"
          cy="50"
          r={r}
          className="timer-fill"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <span>{Math.ceil(left / 1000)}</span>
    </div>
  );
}

export function TimerBar({ left, total }: { left: number; total: number }) {
  const frac = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
  return (
    <div className="timer-bar">
      <div style={{ width: `${frac * 100}%` }} />
    </div>
  );
}

/** Big pre-question countdown: number + draining stripe. */
export function ReadCountdown({ left, total, label }: { left: number; total: number; label: string }) {
  return (
    <div className="read-countdown">
      <div className="read-label">{label}</div>
      <div className="read-number" key={Math.ceil(left / 1000)}>
        {Math.max(1, Math.ceil(left / 1000))}
      </div>
      <TimerBar left={left} total={total} />
    </div>
  );
}

type TileState = "idle" | "picked" | "selected" | "correct" | "wrong" | "dim";

export function AnswerTile({
  index,
  text,
  state = "idle",
  onClick,
  disabled,
  big,
  extra,
  image,
}: {
  image?: string | null;
  index: number;
  text?: string | null;
  state?: TileState;
  onClick?: () => void;
  disabled?: boolean;
  big?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`tile slot-bg-${index} tile-${state} ${big ? "tile-big" : ""} ${text || image ? "" : "tile-shape-only"} ${image ? "tile-has-image" : ""}`}
      onClick={onClick}
      disabled={disabled || !onClick}
    >
      <span className="tile-shape">
        <Shape index={index} size={text || image ? 34 : 72} />
      </span>
      {image && <TileImage url={image} />}
      {text && <span className="tile-text">{text}</span>}
      {(state === "correct" || state === "selected") && <span className="tile-mark">✓</span>}
      {state === "wrong" && <span className="tile-mark">✕</span>}
      {extra}
    </button>
  );
}

function TileImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <span className="tile-image">
      <img src={url} alt="" referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(true)} />
    </span>
  );
}

/** Hot-linked question media; hides itself if the remote file fails. */
export function QuestionMedia({ url }: { url?: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed) return null;
  return (
    <div className="q-media">
      <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    </div>
  );
}

export function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Answer input for any question kind:
 * single = tap a box; multi = toggle boxes then submit; text = type and submit.
 * Number keys pick/toggle boxes, Enter submits.
 */
export function AnswerPad({
  kind,
  count,
  texts,
  images,
  onSubmit,
  big,
}: {
  kind: QuestionKind;
  count: number;
  texts?: (string | null | undefined)[] | null;
  images?: (string | null)[] | null;
  onSubmit: (s: Submission) => void;
  big?: boolean;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const [typed, setTyped] = useState("");
  const submitRef = useRef<() => void>(() => {});
  const toggle = (i: number) => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]));

  submitRef.current = () => {
    if (kind === "multi" && picked.length) onSubmit({ choices: [...picked].sort((a, b) => a - b) });
    if (kind === "text" && typed.trim()) onSubmit({ text: typed.trim() });
  };

  useEffect(() => {
    if (kind === "text") return;
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= count) {
        if (kind === "single") onSubmit({ choice: n - 1 });
        else toggle(n - 1);
      } else if (e.key === "Enter") submitRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kind, count, onSubmit]);

  if (kind === "text") {
    return (
      <form
        className="type-answer"
        onSubmit={(e) => {
          e.preventDefault();
          submitRef.current();
        }}
      >
        <input
          className="type-answer-input"
          autoFocus
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={200}
          placeholder="Type your answer…"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <button className="btn btn-xl btn-primary" disabled={!typed.trim()}>
          Submit
        </button>
      </form>
    );
  }

  const shapesOnly = !texts;
  return (
    <>
      {kind === "multi" && <div className="multi-hint">Pick all that apply, then submit</div>}
      <div className={`tile-grid tiles-${count} ${shapesOnly ? "shapes-only" : ""}`}>
        {Array.from({ length: count }, (_, i) => (
          <AnswerTile
            key={i}
            index={i}
            text={texts?.[i]}
            image={images?.[i]}
            big={big}
            state={kind === "multi" && picked.includes(i) ? "selected" : "idle"}
            onClick={() => (kind === "single" ? onSubmit({ choice: i }) : toggle(i))}
          />
        ))}
      </div>
      {kind === "multi" && (
        <div className="stage-actions">
          <button className="btn btn-xl btn-primary" disabled={!picked.length} onClick={() => submitRef.current()}>
            Submit {picked.length > 0 && `(${picked.length})`}
          </button>
        </div>
      )}
    </>
  );
}

/** After answering: which boxes were right, which you picked, or what you typed vs. what was accepted. */
export function AnswerResultView({
  kind,
  texts,
  images,
  count,
  correct,
  picked,
  typed,
  accepted,
  wasCorrect,
}: {
  kind: QuestionKind;
  texts?: (string | null | undefined)[] | null;
  images?: (string | null)[] | null;
  count: number;
  correct: number[];
  picked: number[];
  typed?: string | null;
  accepted?: string[] | null;
  wasCorrect: boolean;
}) {
  if (kind === "text") {
    return (
      <div className="typed-result">
        {typed && (
          <div className={`typed-yours ${wasCorrect ? "good" : "bad"}`}>
            <small>You typed</small>
            <strong>{typed}</strong>
          </div>
        )}
        <div className="typed-accepted">
          <small>{(accepted?.length ?? 0) > 1 ? "Accepted answers" : "Answer"}</small>
          <div>
            {accepted?.map((a) => (
              <span key={a} className="accepted-chip">
                {a}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={`tile-grid tiles-${count} ${texts ? "" : "shapes-only"}`}>
      {Array.from({ length: count }, (_, i) => {
        const state = correct.includes(i) ? "correct" : picked.includes(i) ? "wrong" : "dim";
        return (
          <AnswerTile
            key={i}
            index={i}
            text={texts?.[i]}
            image={images?.[i]}
            state={state}
            extra={kind === "multi" && picked.includes(i) ? <span className="you-tag">you</span> : undefined}
          />
        );
      })}
    </div>
  );
}
