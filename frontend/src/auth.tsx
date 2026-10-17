import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, setToken, type User } from "./api";

type AuthCtx = {
  user: User | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Replace the cached user after a profile change. */
  setUser: (u: User) => void;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      setReady(true);
      return;
    }
    api<{ user: User | null }>("/api/auth/me")
      .then((r) => {
        setUser(r.user);
        if (!r.user) setToken(null);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const finish = (r: { token: string; user: User }) => {
    setToken(r.token);
    setUser(r.user);
  };

  const login = useCallback(async (username: string, password: string) => {
    finish(await api("/api/auth/login", { body: { username, password } }));
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    finish(await api("/api/auth/register", { body: { username, password } }));
  }, []);

  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    setToken(null);
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, ready, login, register, logout, setUser }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

export const isMod = (u: User | null) => u?.role === "moderator" || u?.role === "admin";
