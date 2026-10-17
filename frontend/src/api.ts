export type Answer = { text: string; correct: boolean; image_url?: string | null };

export type QuestionKind = "single" | "multi" | "text";

export const KIND_LABEL: Record<QuestionKind, string> = {
  single: "Pick one",
  multi: "Pick all that apply",
  text: "Type the answer",
};

export type Submission = { choice?: number | null; choices?: number[]; text?: string };

export type Question = {
  kind?: QuestionKind;
  text: string;
  image_url?: string | null;
  time_limit: number;
  answers: Answer[];
};

export type QuizStatus = "private" | "pending" | "approved" | "rejected";

export type QuizSummary = {
  id: string;
  title: string;
  description: string;
  cover_url: string | null;
  question_count: number;
  owner: string;
  owner_name: string;
  owner_avatar: string | null;
  owner_id: number;
  status: QuizStatus;
  listed: boolean;
  mod_note: string | null;
  plays: number;
  created_at: number;
  updated_at: number;
};

export type Quiz = QuizSummary & { can_edit: boolean; questions: Question[] | null };

export type User = {
  id: number;
  username: string;
  role: "user" | "moderator" | "admin";
  display_name: string | null;
  avatar_url: string | null;
};

/** What to show for a person: their display name, or their username if they haven't set one. */
export const nameOf = (u: { username: string; display_name?: string | null }) => u.display_name || u.username;

export type PartialCredit = "none" | "at_least_half" | "more_than_half";

export const PARTIAL_OPTIONS: [PartialCredit, string][] = [
  ["none", "Exact answer only"],
  ["at_least_half", "Half points if at least half right"],
  ["more_than_half", "Half points if more than half right"],
];

export const PARTIAL_HINT =
  "For “pick several” questions. Each right box picked counts +1, each wrong box −1, out of the number of correct boxes.";

export type StudySettings = {
  multi_partial: PartialCredit;
  timer: boolean;
  read_countdown: boolean;
  repeat_wrong: boolean;
  shuffle_questions: boolean;
  shuffle_answers: boolean;
};

export const CLASSIC_SETTINGS: StudySettings = {
  multi_partial: "none",
  timer: true,
  read_countdown: true,
  repeat_wrong: false,
  shuffle_questions: false,
  shuffle_answers: false,
};

export const STUDY_SETTINGS: StudySettings = {
  multi_partial: "none",
  timer: false,
  read_countdown: false,
  repeat_wrong: true,
  shuffle_questions: true,
  shuffle_answers: true,
};

export type Assignment = {
  code: string;
  quiz_id: string;
  owner_id: number;
  owner: string;
  owner_name: string;
  title: string;
  quiz_title: string;
  question_count: number;
  due_at: number | null;
  require_account: boolean;
  open: boolean;
  accepting: boolean;
  created_at: number;
  settings: StudySettings;
  submissions?: number;
};

export type PublicQuestion = {
  kind: QuestionKind;
  text: string;
  image_url: string | null;
  time_limit: number;
  answers: string[];
  answer_images: (string | null)[];
};

export type ReviewItem = {
  kind?: QuestionKind;
  text: string;
  image_url: string | null;
  answers: Answer[];
  choice: number | null;
  choices?: number[] | null;
  typed?: string | null;
  correct: boolean;
  partial?: boolean;
  points: number;
  time_ms: number;
  tries: number;
  mastered: boolean;
};

export type AttemptSummary = {
  id: string;
  name: string;
  title: string;
  assignment_code: string | null;
  settings: StudySettings;
  total: number;
  answered: number;
  score: number;
  correct: number;
  finished: boolean;
  review: ReviewItem[] | null;
};

export type NextQuestion =
  | { done: true; summary: AttemptSummary }
  | {
      done: false;
      /** Unique per served question (including repeats). */
      serial: number;
      /** 1-based position among first tries. */
      position: number;
      total: number;
      remaining: number;
      is_retry: boolean;
      score: number;
      streak: number;
      question: PublicQuestion;
      read_ms: number;
      read_total_ms: number;
      /** null when the timer is off. */
      time_ms: number | null;
    };

export type AnswerResult = {
  kind: QuestionKind;
  correct: boolean;
  partial: boolean;
  correct_indices: number[];
  /** Accepted wordings, for typed-answer questions. */
  accepted: string[] | null;
  choice: number | null;
  choices: number[] | null;
  typed: string | null;
  answered: boolean;
  points: number;
  score: number;
  streak: number;
  is_last: boolean;
  is_retry: boolean;
  requeued: boolean;
  remaining: number;
};

export type Notice = { id: number; kind: "warning" | "ban" | "quiz_removed" | string; message: string; created_at: number };

export type AccountInfo = {
  id: number;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  bio?: string;
  role: User["role"];
  created_at: number;
  banned_until: number | null;
  ban_reason: string | null;
  quiz_count: number;
  warnings: number;
  times_reported?: number;
  open_reports?: number;
};

export type ReportEntry = {
  id: number;
  reason: string;
  details: string;
  status: "open" | "resolved" | "dismissed";
  resolution: string | null;
  created_at: number;
  reporter: string | null;
  resolved_by: string | null;
};

export type ReportCase = {
  kind: "quiz" | "user";
  target_id: string;
  quiz: Quiz | null;
  user: AccountInfo | null;
  reports: ReportEntry[];
};

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const TOKEN_KEY = "ps_token";

export const store = {
  get(key: string, session = false): string | null {
    try {
      return (session ? sessionStorage : localStorage).getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null, session = false) {
    try {
      const s = session ? sessionStorage : localStorage;
      if (value === null) s.removeItem(key);
      else s.setItem(key, value);
    } catch {
      /* storage unavailable: features degrade to in-memory */
    }
  },
};

export const getToken = () => store.get(TOKEN_KEY);
export const setToken = (t: string | null) => store.set(TOKEN_KEY, t);

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export function wsUrl() {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** Upload a raw file body (used for profile pictures). */
export async function apiUpload<T>(path: string, file: Blob, method = "PUT"): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": file.type || "application/octet-stream" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: file });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? (res.status === 413 ? "That file is too big (max 1 MB)" : `Upload failed (${res.status})`), res.status);
  return data as T;
}
