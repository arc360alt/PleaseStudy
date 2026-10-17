import { useEffect, useState } from "react";
import { api, type Notice } from "../api";
import { useAuth } from "../auth";
import Modal from "./Modal";

const TITLES: Record<string, string> = {
  warning: "A warning from the moderators",
  ban: "Your account was suspended",
  quiz_removed: "One of your quizzes was removed",
};

/** Shows unread staff messages (warnings, takedowns, ban notices) one at a time until acknowledged. */
export default function Notices() {
  const { user } = useAuth();
  const [queue, setQueue] = useState<Notice[]>([]);

  useEffect(() => {
    if (!user) {
      setQueue([]);
      return;
    }
    const load = () =>
      api<{ notices: Notice[] }>("/api/notices")
        .then((r) => setQueue(r.notices))
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [user]);

  const notice = queue[0];
  if (!notice) return null;

  async function ack() {
    await api(`/api/notices/${notice.id}/ack`, { method: "POST" }).catch(() => {});
    setQueue((q) => q.slice(1));
  }

  return (
    <Modal title={TITLES[notice.kind] ?? "Message from the moderators"} onClose={ack}>
      <div className="notice-modal">
        <span className={`badge ${notice.kind === "warning" || notice.kind === "ban" ? "badge-rejected" : "badge-pending"} notice-kind`}>
          {new Date(notice.created_at * 1000).toLocaleString()}
        </span>
        <p>{notice.message}</p>
      </div>
      <p className="muted">
        Please keep everything on PleaseStudy friendly and school-appropriate. Repeated problems can lead to a suspension.
      </p>
      <button className="btn btn-ink btn-lg btn-block" onClick={ack}>
        I understand
      </button>
    </Modal>
  );
}
