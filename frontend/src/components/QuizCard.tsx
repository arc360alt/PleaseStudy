import { useState } from "react";
import { Link } from "react-router-dom";
import type { QuizSummary } from "../api";
import { PatternCover } from "./Shapes";
import Avatar from "./Avatar";

export function Cover({ quiz }: { quiz: Pick<QuizSummary, "id" | "title" | "cover_url"> }) {
  const [failed, setFailed] = useState(false);
  if (quiz.cover_url && !failed) {
    return (
      <div className="cover">
        <img src={quiz.cover_url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      </div>
    );
  }
  return (
    <div className="cover">
      <PatternCover seed={quiz.id} title={quiz.title} />
    </div>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  private: "Private",
  pending: "In review",
  approved: "Public",
  rejected: "Changes needed",
};

export function StatusBadge({ status, listed = true }: { status: string; listed?: boolean }) {
  return (
    <span className="badge-row">
      <span className={`badge badge-${status}`}>{STATUS_LABEL[status] ?? status}</span>
      {!listed && <span className="badge badge-unlisted">Unlisted</span>}
    </span>
  );
}

export default function QuizCard({ quiz, showStatus }: { quiz: QuizSummary; showStatus?: boolean }) {
  return (
    <Link to={`/q/${quiz.id}`} className="quiz-card">
      <Cover quiz={quiz} />
      <div className="quiz-card-body">
        {showStatus && <StatusBadge status={quiz.status} listed={quiz.listed} />}
        <h3>{quiz.title}</h3>
        <div className="meta">
          <span className="owner-inline">
            <Avatar url={quiz.owner_avatar} name={quiz.owner_name} seed={quiz.owner_id} size={20} />
            {quiz.owner_name}
          </span>
          <span>{quiz.question_count} Qs</span>
          <span>{quiz.plays} plays</span>
        </div>
      </div>
    </Link>
  );
}
