import { useEffect, useRef, useState } from "react";
import { api, errorText, isImageLink } from "../api";
import Modal from "./Modal";

type Gif = { id: number | string; title: string; preview: string; url: string; width: number; height: number };

const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_PHOTO_BYTES = 1024 * 1024;

let gifStatus: Promise<boolean> | null = null;
/** Whether the server has a KLIPY key configured (asked once per page load). */
function gifsEnabled() {
  gifStatus ??= api<{ enabled: boolean }>("/api/gifs/status")
    .then((r) => r.enabled)
    .catch(() => false);
  return gifStatus;
}

/** URL box for a hot-linked image, with a GIF search button and a live preview. */
export default function ImageField({
  value,
  onChange,
  placeholder = "Image or GIF link, e.g. https://…",
  compact,
  onUpload,
}: {
  value: string;
  onChange: (url: string) => void;
  placeholder?: string;
  compact?: boolean;
  /** Store a photo from the user's device and return its URL. Omit to hide the upload button. */
  onUpload?: (file: File) => Promise<string>;
}) {
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  async function upload(file: File | undefined) {
    if (!file || !onUpload) return;
    setUploadError("");
    if (!PHOTO_TYPES.includes(file.type)) {
      setUploadError("Only photos can be uploaded: PNG, JPEG or WebP.");
    } else if (file.size > MAX_PHOTO_BYTES) {
      setUploadError(`That photo is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 1 MB.`);
    } else {
      setUploading(true);
      try {
        onChange(await onUpload(file));
      } catch (e) {
        setUploadError(errorText(e));
      } finally {
        setUploading(false);
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  }
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    gifsEnabled().then(setEnabled);
  }, []);
  const valid = isImageLink(value);

  return (
    <div className={`image-field-wrap ${compact ? "compact" : ""}`}>
    <div className={`image-field ${compact ? "compact" : ""}`}>
      <input className="input" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      {enabled && (
        <button type="button" className="btn btn-sm gif-btn" onClick={() => setPicking(true)} title="Search GIFs">
          GIF
        </button>
      )}
      {onUpload && (
        <>
          <input
            ref={fileInput}
            type="file"
            accept={PHOTO_TYPES.join(",")}
            hidden
            onChange={(e) => upload(e.target.files?.[0])}
          />
          <button
            type="button"
            className="btn btn-sm upload-btn"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
            title="Upload a photo (PNG, JPEG or WebP, max 1 MB)"
          >
            {uploading ? "…" : "📷 Upload"}
          </button>
        </>
      )}
      {valid && <img className="image-thumb" src={value} alt="" referrerPolicy="no-referrer" />}
      {picking && (
        <GifPicker
          onClose={() => setPicking(false)}
          onPick={(url) => {
            onChange(url);
            setPicking(false);
          }}
        />
      )}
    </div>
    {uploadError && <small className="upload-error">{uploadError}</small>}
    </div>
  );
}

function GifPicker({ onPick, onClose }: { onPick: (url: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Gif[]>([]);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);

  // Debounced search; an empty box shows trending GIFs.
  useEffect(() => {
    const t = setTimeout(() => load(1), q ? 400 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function load(p: number) {
    const mine = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const r = await api<{ items: Gif[]; has_next: boolean }>(
        `/api/gifs/search?q=${encodeURIComponent(q.trim())}&page=${p}`,
      );
      if (mine !== seq.current) return;
      setItems((prev) => (p === 1 ? r.items : [...prev, ...r.items]));
      setHasNext(r.has_next);
      setPage(p);
    } catch (e) {
      if (mine === seq.current) setError(errorText(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }

  return (
    <Modal title="Pick a GIF" onClose={onClose}>
      <input
        className="input input-lg"
        autoFocus
        placeholder="Search GIFs…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {error && <div className="alert">{error}</div>}
      <div className="gif-grid">
        {items.map((g) => (
          <button key={g.id} type="button" className="gif-cell" title={g.title} onClick={() => onPick(g.url)}>
            <img src={g.preview} alt={g.title} loading="lazy" referrerPolicy="no-referrer" />
          </button>
        ))}
      </div>
      {!loading && !error && items.length === 0 && <p className="muted center">No GIFs found.</p>}
      <div className="gif-foot">
        <span className="powered-by">
          Powered by <strong>KLIPY</strong>
        </span>
        {hasNext && (
          <button type="button" className="btn btn-sm" disabled={loading} onClick={() => load(page + 1)}>
            {loading ? "Loading…" : "More"}
          </button>
        )}
      </div>
    </Modal>
  );
}
