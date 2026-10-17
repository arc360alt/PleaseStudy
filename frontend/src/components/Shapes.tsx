/** Each answer slot has a fixed color + shape so it reads across the room and for colorblind players. */
export const SLOT_NAMES = ["Triangle", "Diamond", "Circle", "Square", "Star", "Hexagon"];

export function Shape({ index, size = 28 }: { index: number; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 40 40", "aria-hidden": true } as const;
  switch (index % 6) {
    case 0:
      return (
        <svg {...common}>
          <path d="M20 4 L37 35 L3 35 Z" fill="currentColor" />
        </svg>
      );
    case 1:
      return (
        <svg {...common}>
          <path d="M20 2 L38 20 L20 38 L2 20 Z" fill="currentColor" />
        </svg>
      );
    case 2:
      return (
        <svg {...common}>
          <circle cx="20" cy="20" r="17" fill="currentColor" />
        </svg>
      );
    case 3:
      return (
        <svg {...common}>
          <rect x="4" y="4" width="32" height="32" rx="3" fill="currentColor" />
        </svg>
      );
    case 4:
      return (
        <svg {...common}>
          <path
            d="M20 2 L25 14.5 L38.5 15.2 L28 23.8 L31.5 37 L20 29.6 L8.5 37 L12 23.8 L1.5 15.2 L15 14.5 Z"
            fill="currentColor"
          />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M11 3 H29 L38 20 L29 37 H11 L2 20 Z" fill="currentColor" />
        </svg>
      );
  }
}

/** Deterministic decorative cover for quizzes without an image. */
export function PatternCover({ seed, title }: { seed: string; title: string }) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = h % 6;
  const b = (a + 1 + ((h >> 4) % 5)) % 6;
  const rot = (h >> 8) % 40;
  return (
    <div className={`pattern-cover slot-bg-${a}`}>
      <span className={`pattern-shape slot-fg-${b}`} style={{ transform: `rotate(${rot - 20}deg)` }}>
        <Shape index={b} size={120} />
      </span>
      <span className="pattern-initial">{title.trim().charAt(0).toUpperCase() || "?"}</span>
    </div>
  );
}
