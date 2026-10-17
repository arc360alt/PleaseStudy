import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type QuizSummary } from "../api";
import QuizCard from "../components/QuizCard";
import { Shape } from "../components/Shapes";

export default function Home() {
  const navigate = useNavigate();
  const [pin, setPin] = useState("");
  const [popular, setPopular] = useState<QuizSummary[] | null>(null);

  useEffect(() => {
    api<{ quizzes: QuizSummary[] }>("/api/quizzes?sort=popular")
      .then((r) => setPopular(r.quizzes.slice(0, 8)))
      .catch(() => setPopular([]));
  }, []);

  const digits = pin.replace(/\D/g, "").slice(0, 6);

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="kicker">Live quiz games · solo runs · assignments</p>
          <h1 className="display hero-title">
            Fastest <em>right</em> answer wins.
          </h1>
          <p className="hero-sub">
            Build a quiz, put it on the big screen, and let the room race to the right colored box. Or play it
            solo, or send it out as an assignment link.
          </p>
          <div className="hero-actions">
            <Link to="/create" className="btn btn-lg btn-primary">
              Make a quiz
            </Link>
            <Link to="/discover" className="btn btn-lg">
              Browse quizzes
            </Link>
          </div>
        </div>

        <form
          className="ticket"
          onSubmit={(e) => {
            e.preventDefault();
            if (digits.length === 6) navigate(`/join?pin=${digits}`);
          }}
        >
          <div className="ticket-head">
            <span>ADMIT ONE</span>
            <span>Nº {digits.padEnd(6, "·")}</span>
          </div>
          <label htmlFor="pin" className="ticket-label">
            Got a game PIN?
          </label>
          <input
            id="pin"
            className="pin-input"
            inputMode="numeric"
            autoComplete="off"
            placeholder="000000"
            value={digits}
            onChange={(e) => setPin(e.target.value)}
          />
          <button className="btn btn-lg btn-ink btn-block" disabled={digits.length !== 6}>
            Enter →
          </button>
          <div className="ticket-shapes">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <span key={i} className={`slot-fg-${i}`}>
                <Shape index={i} size={22} />
              </span>
            ))}
          </div>
        </form>
      </section>

      <section className="howto">
        {[
          ["Host it", "Pick a quiz, hit Host live. Players join from their phones with the PIN. No account needed."],
          ["Assign it", "Make a link. Anyone who opens it plays solo, and you see every score."],
          ["Play it", "Open any public quiz and play it alone against the clock."],
        ].map(([t, d], i) => (
          <div key={t} className={`howto-card slot-edge-${i}`}>
            <span className={`howto-num slot-bg-${i}`}>{i + 1}</span>
            <h3>{t}</h3>
            <p>{d}</p>
          </div>
        ))}
      </section>

      <section>
        <div className="section-head">
          <h2 className="display">Most played</h2>
          <Link to="/discover" className="link-arrow">
            See all →
          </Link>
        </div>
        {popular === null ? (
          <div className="loading">Loading…</div>
        ) : popular.length === 0 ? (
          <div className="empty-state small">
            <p>No public quizzes yet. Be the first. Make one and send it to the mods.</p>
            <Link to="/create" className="btn btn-primary">
              Create a quiz
            </Link>
          </div>
        ) : (
          <div className="quiz-grid">
            {popular.map((q) => (
              <QuizCard key={q.id} quiz={q} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
