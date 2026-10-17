import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { useTheme, type Theme } from "./components/theme";
import { isMod, useAuth } from "./auth";
import Home from "./pages/Home";
import Discover from "./pages/Discover";
import QuizPage from "./pages/QuizPage";
import Editor from "./pages/Editor";
import Library from "./pages/Library";
import Results from "./pages/Results";
import Solo from "./pages/Solo";
import Join from "./pages/Join";
import Host from "./pages/Host";
import Login from "./pages/Login";
import Moderation from "./pages/Moderation";
import Profile from "./pages/Profile";
import Settings from "./pages/Settings";
import Avatar from "./components/Avatar";
import { nameOf } from "./api";
import Notices from "./components/Notices";

export function Logo({ light }: { light?: boolean }) {
  return (
    <span className={`logo ${light ? "logo-light" : ""}`}>
      <span className="logo-please">Please</span>
      <span className="logo-study">Study</span>
    </span>
  );
}

const THEME_ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };
const THEME_NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

function ThemeButton() {
  const [theme, setTheme] = useTheme();
  return (
    <button
      className="theme-btn"
      onClick={(e) => {
        e.stopPropagation();
        setTheme(THEME_NEXT[theme]);
      }}
      title={`Theme: ${theme} (click to change)`}
      aria-label={`Theme: ${theme}`}
    >
      {THEME_ICON[theme]}
      <span className="theme-label">{theme === "system" ? "Auto" : theme === "light" ? "Light" : "Dark"}</span>
    </button>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!user) return null;
  return (
    <div className="user-menu" ref={ref}>
      <button
        className="nav-user"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Avatar url={user.avatar_url} name={nameOf(user)} seed={user.id} size={28} />
        <span className="nav-user-name">{nameOf(user)}</span> <span className="caret">▾</span>
      </button>
      {open && (
        <div className="user-dropdown" role="menu" onClick={() => setOpen(false)}>
          <div className="user-dropdown-head">
            Signed in as <strong>{nameOf(user)}</strong>
            {user.role !== "user" && <span className="badge">{user.role}</span>}
          </div>
          <Link to={`/u/${user.username}`} role="menuitem">
            My profile
          </Link>
          <Link to="/settings" role="menuitem">
            Profile settings
          </Link>
          <Link to="/library" role="menuitem">
            My quizzes
          </Link>
          <Link to="/library?tab=assignments" role="menuitem">
            My assignments
          </Link>
          <Link to="/create" role="menuitem">
            New quiz
          </Link>
          {isMod(user) && (
            <Link to="/mod" role="menuitem">
              Moderation
            </Link>
          )}
          <button
            role="menuitem"
            className="danger"
            onClick={async () => {
              await logout();
              navigate("/");
            }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

function Shell() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="topbar-logo" onClick={close}>
          <Logo />
        </Link>
        <button className="menu-btn" onClick={() => setOpen(!open)} aria-label="Menu">
          {open ? "✕" : "☰"}
        </button>
        <nav className={`topnav ${open ? "open" : ""}`} onClick={close}>
          <NavLink to="/discover">Discover</NavLink>
          <NavLink to="/create">Create</NavLink>
          {user && <NavLink to="/library">Library</NavLink>}
          {isMod(user) && <NavLink to="/mod">Moderation</NavLink>}
          <NavLink to="/join" className="nav-join">
            Join game
          </NavLink>
          <ThemeButton />
          {user ? (
            <UserMenu />
          ) : (
            <NavLink to="/login" className="nav-login">
              Log in
            </NavLink>
          )}
        </nav>
      </header>
      <main className="page">
        <Outlet />
      </main>
      <Notices />
      <footer className="footer">
        <Logo /> <span>Make a quiz. Throw it on the big screen. Fastest fingers win.</span>
      </footer>
    </div>
  );
}

function NotFound() {
  return (
    <div className="empty-state">
      <h1 className="display">404</h1>
      <p>Nothing here. Maybe the quiz got deleted?</p>
      <Link className="btn" to="/">
        Go home
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path="discover" element={<Discover />} />
        <Route path="q/:id" element={<QuizPage />} />
        <Route path="create" element={<Editor />} />
        <Route path="edit/:id" element={<Editor />} />
        <Route path="library" element={<Library />} />
        <Route path="assignments/:code/results" element={<Results />} />
        <Route path="login" element={<Login />} />
        <Route path="mod" element={<Moderation />} />
        <Route path="u/:username" element={<Profile />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      {/* Full-screen game views */}
      <Route path="play/:quizId" element={<Solo />} />
      <Route path="a/:code" element={<Solo />} />
      <Route path="join" element={<Join />} />
      <Route path="host/:pin" element={<Host />} />
    </Routes>
  );
}
