import { useCallback, useEffect, useRef, useState } from "react";
import { wsUrl } from "../api";

export type LiveQuestion = {
  kind?: "single" | "multi" | "text";
  accepted?: string[] | null;
  text?: string | null;
  image_url?: string | null;
  answers?: string[] | null;
  answer_images?: (string | null)[] | null;
  answer_count?: number;
  correct?: number[] | null;
};

export type Phase = "lobby" | "intro" | "question" | "reveal" | "leaderboard" | "finished";

export type Standing = {
  id: string;
  name: string;
  score: number;
  rank: number;
  prev_rank: number | null;
  streak: number;
  last_points: number;
};

export type HostState = {
  type: "host_state";
  pin: string;
  title: string;
  phase: Phase;
  settings: {
    show_question_on_devices: boolean;
    time_limit: number | null;
    read_seconds: number;
    shuffle_questions: boolean;
    shuffle_answers?: boolean;
    allow_late_join: boolean;
    no_timer: boolean;
    multi_partial?: "none" | "at_least_half" | "more_than_half";
  };
  q_index: number;
  q_total: number;
  question: (LiveQuestion & { text: string; answers: string[] }) | null;
  time_left_ms: number | null;
  phase_total_ms: number;
  answered: number;
  waiting: { id: string; name: string; connected: boolean }[];
  counts: number[] | null;
  typed: { text: string; count: number; correct: boolean }[] | null;
  correct_count: number | null;
  partial_count?: number | null;
  players: { id: string; name: string; score: number; connected: boolean }[];
  leaderboard: Standing[] | null;
};

export type PlayerState = {
  type: "player_state";
  pin: string;
  title: string;
  phase: Phase;
  me: { id: string; name: string; score: number; streak: number; rank: number | null };
  player_count: number;
  q_index: number;
  q_total: number;
  question: (LiveQuestion & { answer_count: number }) | null;
  time_left_ms: number | null;
  phase_total_ms: number;
  answered: boolean;
  result: {
    choice: number | null;
    choices: number[] | null;
    typed: string | null;
    correct: boolean;
    partial?: boolean;
    points: number;
    time_ms: number;
  } | null;
  ahead: { name: string; gap: number } | null;
  podium: Standing[] | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = any;

/**
 * A self-healing WebSocket: sends `hello()` on every (re)connect and retries on drops
 * until `stop()` is called.
 */
export function useLiveSocket(hello: (() => object) | null, onMessage: (m: Msg) => void) {
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const ws = useRef<WebSocket | null>(null);
  const stopped = useRef(false);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const helloRef = useRef(hello);
  helloRef.current = hello;
  const enabled = hello !== null;

  useEffect(() => {
    if (!enabled) return;
    stopped.current = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;
    let ping: ReturnType<typeof setInterval>;

    const connect = () => {
      setStatus("connecting");
      const sock = new WebSocket(wsUrl());
      ws.current = sock;
      sock.onopen = () => {
        retry = 0;
        setStatus("open");
        if (helloRef.current) sock.send(JSON.stringify(helloRef.current()));
        ping = setInterval(() => sock.readyState === 1 && sock.send('{"type":"ping"}'), 20000);
      };
      sock.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.type !== "pong") handler.current(m);
        } catch {
          /* ignore */
        }
      };
      sock.onclose = () => {
        clearInterval(ping);
        if (stopped.current) {
          setStatus("closed");
          return;
        }
        setStatus("connecting");
        timer = setTimeout(connect, Math.min(8000, 600 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      stopped.current = true;
      clearTimeout(timer);
      clearInterval(ping);
      ws.current?.close();
    };
  }, [enabled]);

  const send = useCallback((m: object) => {
    if (ws.current?.readyState === 1) ws.current.send(JSON.stringify(m));
  }, []);

  const stop = useCallback(() => {
    stopped.current = true;
    ws.current?.close();
  }, []);

  return { send, status, stop };
}
