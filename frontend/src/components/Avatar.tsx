import { useEffect, useState } from "react";

/** A user's profile picture, or a colored initial if they haven't uploaded one. */
export default function Avatar({
  url,
  name,
  seed,
  size = 32,
  className = "",
}: {
  url?: string | null;
  name: string;
  seed: number | string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const n = typeof seed === "number" ? seed : [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
  const style = { width: size, height: size, fontSize: size * 0.45 };
  if (url && !failed) {
    return <img className={`avatar-img ${className}`} src={url} alt="" style={style} onError={() => setFailed(true)} />;
  }
  return (
    <span className={`avatar-img avatar-initial slot-bg-${n % 6} ${className}`} style={style} aria-hidden>
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
