import { useEffect, useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { api, apiUpload, errorText, type User } from "../api";
import { useAuth } from "../auth";
import Avatar from "../components/Avatar";

const MAX_BYTES = 1024 * 1024;
const MAX_NAME = 32;
const MAX_BIO = 300;
const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function encode(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((res) => canvas.toBlob(res, type, quality));
}

/**
 * Get a picture under 1 MB. GIFs and WebPs that already fit are kept as-is so animations survive;
 * everything else is center-cropped to a square, shrunk to 512px and re-encoded.
 */
async function prepareAvatar(file: File): Promise<Blob> {
  if (!TYPES.includes(file.type)) throw new Error("Pick a PNG, JPEG, GIF or WebP image.");
  if ((file.type === "image/gif" || file.type === "image/webp") && file.size <= MAX_BYTES) return file;
  if (file.type === "image/gif") throw new Error("Animated GIFs must be 1 MB or smaller.");
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const out = Math.min(512, side);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = out;
  canvas.getContext("2d")!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
  for (const [type, q] of [
    ["image/webp", 0.9],
    ["image/jpeg", 0.9],
    ["image/jpeg", 0.75],
  ] as const) {
    const blob = await encode(canvas, type, q);
    // Some browsers silently fall back to PNG when they can't encode a type.
    if (blob && TYPES.includes(blob.type) && blob.size <= MAX_BYTES) return blob;
  }
  throw new Error("Couldn't get that picture under 1 MB. Try a smaller one.");
}

export default function Settings() {
  const { user, ready, setUser } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [picError, setPicError] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user) return;
    api<{ user: User & { bio: string } }>("/api/me").then((r) => {
      setDisplayName(r.user.display_name ?? "");
      setBio(r.user.bio ?? "");
      setLoaded(true);
    });
    // Only on first load for this account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  if (ready && !user) return <Navigate to="/login?next=/settings" replace />;
  if (!user || !loaded) return <div className="loading">Loading…</div>;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const r = await api<{ user: User & { bio: string } }>("/api/me", {
        method: "PATCH",
        body: { display_name: displayName, bio },
      });
      setUser(r.user);
      setDisplayName(r.user.display_name ?? "");
      setBio(r.user.bio);
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setPicError("");
    setUploading(true);
    try {
      const blob = await prepareAvatar(file);
      const r = await apiUpload<{ user: User }>("/api/me/avatar", blob);
      setUser(r.user);
    } catch (err) {
      setPicError(errorText(err));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function removePicture() {
    setPicError("");
    try {
      const r = await api<{ user: User }>("/api/me/avatar", { method: "DELETE" });
      setUser(r.user);
    } catch (err) {
      setPicError(errorText(err));
    }
  }

  const preview = displayName.trim() || user.username;

  return (
    <div className="settings">
      <div className="page-head row-between">
        <h1 className="display">Profile settings</h1>
        <Link className="link-arrow" to={`/u/${user.username}`}>
          View my profile →
        </Link>
      </div>

      <section className="panel settings-section">
        <h2 className="options-head">Profile picture</h2>
        <div className="pfp-row">
          <Avatar url={user.avatar_url} name={preview} seed={user.id} size={112} className="pfp-big" />
          <div className="pfp-actions">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
            <div className="row-wrap">
              <button className="btn btn-primary" disabled={uploading} onClick={() => fileInput.current?.click()}>
                {uploading ? "Uploading…" : user.avatar_url ? "Change picture" : "Upload picture"}
              </button>
              {user.avatar_url && (
                <button className="btn" onClick={removePicture}>
                  Remove
                </button>
              )}
            </div>
            <small className="muted">
              PNG, JPEG, GIF or WebP, up to 1 MB. Photos are cropped square for you. Keep it school-friendly.
            </small>
            {picError && <div className="alert">{picError}</div>}
          </div>
        </div>
      </section>

      <UsernameSection />

      <form className="panel settings-section" onSubmit={save}>
        <label className="field">
          <span>Display name</span>
          <input
            className="input input-lg"
            maxLength={MAX_NAME}
            value={displayName}
            placeholder={user.username}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setSaved(false);
            }}
          />
          <small className="muted">
            What people see on your quizzes and in games. Leave it empty to use your username. {displayName.length}/
            {MAX_NAME}
          </small>
        </label>
        <label className="field">
          <span>About you</span>
          <textarea
            className="input"
            rows={4}
            maxLength={MAX_BIO}
            value={bio}
            placeholder="A line or two about you, your class, or what you make quizzes about."
            onChange={(e) => {
              setBio(e.target.value);
              setSaved(false);
            }}
          />
          <small className="muted">
            {bio.length}/{MAX_BIO}
          </small>
        </label>
        <div className="profile-preview">
          <Avatar url={user.avatar_url} name={preview} seed={user.id} size={40} />
          <span>
            <strong>{preview}</strong>
            <small className="muted"> is how you'll appear</small>
          </span>
        </div>
        {error && <div className="alert">{error}</div>}
        <div className="row-wrap">
          <button className="btn btn-primary btn-lg" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && <span className="saved-note">✓ Saved</span>}
        </div>
      </form>
    </div>
  );
}

type Availability = { available: boolean; reason?: string; same?: boolean };
type MeExtra = {
  username_change_at: number | null;
  old_username: { username: string; held_until: number } | null;
};

/** Change your @username: once a month, must be free, confirmed with your password. */
function UsernameSection() {
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user!.username);
  const [password, setPassword] = useState("");
  const [check, setCheck] = useState<Availability | null>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [oldName, setOldName] = useState<{ username: string; held_until: number } | null>(null);
  const [reverting, setReverting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    api<{ user: MeExtra }>("/api/me").then((r) => {
      setNextAt(r.user.username_change_at);
      setOldName(r.user.old_username);
    });
  }, []);

  // Debounced availability check as you type.
  useEffect(() => {
    const wanted = name.trim();
    if (!wanted || wanted === user!.username) {
      setCheck(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api<Availability>(`/api/usernames/check?u=${encodeURIComponent(wanted)}`)
        .then((r) => live && setCheck(r))
        .catch(() => {});
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [name, user]);

  const locked = nextAt !== null;
  const changed = name.trim() !== user!.username;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ user: User & MeExtra }>("/api/me/username", {
        body: { username: name.trim(), password },
      });
      setUser(r.user);
      setNextAt(r.user.username_change_at);
      setOldName(r.user.old_username);
      setPassword("");
      setCheck(null);
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel settings-section" onSubmit={submit}>
      <h2 className="options-head">Username</h2>
      <p className="muted">
        Your @username is what you log in with. It's shown on your profile page. You can change it once a month.
      </p>
      <label className="field">
        <span>Username</span>
        <div className="username-input">
          <span className="at">@</span>
          <input
            className="input input-lg"
            value={name}
            maxLength={24}
            disabled={locked}
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => {
              setName(e.target.value.replace(/\s/g, ""));
              setDone(false);
            }}
          />
        </div>
        {locked ? (
          <small className="muted">
            You changed it recently. You can change it again on {new Date(nextAt! * 1000).toLocaleDateString()}.
          </small>
        ) : check ? (
          <small className={check.available ? "avail-ok" : "avail-bad"}>
            {check.available ? "✓ Available" : `✕ ${check.reason}`}
          </small>
        ) : (
          <small className="muted">3–24 characters: letters, numbers, _ and -</small>
        )}
      </label>
      {!locked && changed && (
        <label className="field">
          <span>Confirm with your password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      )}
      {oldName && (
        <div className="old-name-box">
          <span>
            Your old username <strong>@{oldName.username}</strong> is reserved for you until{" "}
            {new Date(oldName.held_until * 1000).toLocaleDateString()}. Nobody else can take it, and links to it
            point here.
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={reverting}
            onClick={async () => {
              if (!confirm(`Switch back to @${oldName.username}? You'll log in with it again.`)) return;
              setReverting(true);
              setError("");
              try {
                const r = await api<{ user: User & MeExtra }>("/api/me/username/revert", { method: "POST" });
                setUser(r.user);
                setName(r.user.username);
                setOldName(r.user.old_username);
                setNextAt(r.user.username_change_at);
                setDone(false);
              } catch (err) {
                setError(errorText(err));
              } finally {
                setReverting(false);
              }
            }}
          >
            Switch back to @{oldName.username}
          </button>
        </div>
      )}
      {error && <div className="alert">{error}</div>}
      {done && <div className="saved-note">✓ Username changed. Use @{user!.username} to log in from now on.</div>}
      {!locked && changed && (
        <div className="row-wrap">
          <button className="btn btn-primary" disabled={busy || !password || check?.available === false}>
            {busy ? "Changing…" : "Change username"}
          </button>
          <small className="muted">Your current name stays reserved for you for 30 days in case you change your mind.</small>
        </div>
      )}
    </form>
  );
}
