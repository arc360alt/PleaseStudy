import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, errorText, type QuizSummary } from "../api";
import { useAuth } from "../auth";
import QuizCard from "../components/QuizCard";
import Avatar from "../components/Avatar";
import ReportButton from "../components/Report";

type ProfileData = {
  id: number;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string;
  role: string;
  created_at: number;
  quizzes: QuizSummary[];
};

export default function Profile() {
  const { username } = useParams();
  const { user } = useAuth();
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    setData(null);
    api<ProfileData & { moved_to?: string }>(`/api/users/${encodeURIComponent(username ?? "")}`)
      .then((d) => (d.moved_to ? navigate(`/u/${d.moved_to}`, { replace: true }) : setData(d)))
      .catch((e) => setError(errorText(e)));
  }, [username]);

  if (error) return <div className="empty-state"><h1 className="display">Hmm.</h1><p>{error}</p></div>;
  if (!data) return <div className="loading">Loading…</div>;

  return (
    <>
      <div className="profile-head">
        <Avatar
          url={data.avatar_url}
          name={data.display_name || data.username}
          seed={data.id}
          size={96}
          className="profile-avatar"
        />
        <div className="page-head">
          <h1 className="display">{data.display_name || data.username}</h1>
          <div className="handle">@{data.username}</div>
          {data.bio && <p className="profile-bio">{data.bio}</p>}
          <div className="meta meta-lg">
            {data.role !== "user" && <span>{data.role}</span>}
            <span>joined {new Date(data.created_at * 1000).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
            <span>{data.quizzes.length} public quizzes</span>
          </div>
          {user?.id === data.id ? (
            <Link className="btn btn-sm" to="/settings">
              Edit profile
            </Link>
          ) : (
            <ReportButton
              kind="user"
              target={data.username}
              name={data.display_name || data.username}
              label="Report this account"
            />
          )}
        </div>
      </div>
      {data.quizzes.length === 0 ? (
        <div className="empty-state small">
          <p>No public quizzes yet.</p>
        </div>
      ) : (
        <div className="quiz-grid">
          {data.quizzes.map((q) => (
            <QuizCard key={q.id} quiz={q} />
          ))}
        </div>
      )}
    </>
  );
}
