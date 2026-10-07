import clsx from "clsx";
import {
  Activity, AlertTriangle, ArrowLeftRight, BarChart3, BookOpen, Briefcase, Cpu, Database, FlaskConical, GitCompareArrows, Gauge,
  LayoutDashboard, LineChart, Library, LogOut, Menu, Moon, ScrollText, Settings, ShieldCheck, Sun, Users, X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { setTheme, useTheme } from "../lib/theme";
import { Logo } from "./Logo";

interface Item { to: string; label: string; icon: ReactNode; perm?: string; end?: boolean }

const MAIN: Item[] = [
  { to: "/", label: "Tableau de bord", icon: <LayoutDashboard size={17} />, end: true },
  { to: "/research", label: "Research", icon: <BookOpen size={17} />, perm: "strategy:read" },
  { to: "/strategies", label: "Stratégies", icon: <Library size={17} />, perm: "strategy:read" },
  { to: "/backtests/new", label: "Laboratoire", icon: <FlaskConical size={17} />, perm: "backtest:run" },
  { to: "/backtests", label: "Backtests", icon: <BarChart3 size={17} />, perm: "backtest:read", end: true },
  { to: "/compare", label: "Strategy Lab", icon: <GitCompareArrows size={17} />, perm: "backtest:read" },
  { to: "/portfolios", label: "Portefeuilles", icon: <Briefcase size={17} />, perm: "portfolio:read" },
  { to: "/transactions", label: "Transactions", icon: <ArrowLeftRight size={17} />, perm: "backtest:read" },
  { to: "/markets", label: "Marchés", icon: <LineChart size={17} />, perm: "market:read" },
];
const ADMIN: Item[] = [
  { to: "/admin", label: "Vue d'ensemble", icon: <Gauge size={17} />, perm: "system:read", end: true },
  { to: "/admin/jobs", label: "Tâches", icon: <Cpu size={17} />, perm: "job:admin" },
  { to: "/admin/errors", label: "Erreurs", icon: <AlertTriangle size={17} />, perm: "system:read" },
  { to: "/admin/providers", label: "Données de marché", icon: <Database size={17} />, perm: "system:read" },
  { to: "/admin/strategies", label: "Toutes les stratégies", icon: <FlaskConical size={17} />, perm: "system:read" },
  { to: "/admin/users", label: "Utilisateurs", icon: <Users size={17} />, perm: "user:admin" },
  { to: "/admin/roles", label: "Rôles & permissions", icon: <ShieldCheck size={17} />, perm: "role:admin" },
  { to: "/admin/audit", label: "Journal d'audit", icon: <ScrollText size={17} />, perm: "audit:read" },
];

function NavItem({ item }: { item: Item }) {
  return (
    <NavLink to={item.to} end={item.end}
      className={({ isActive }) => clsx("group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        isActive ? "bg-raised text-ink" : "text-ink2 hover:bg-raised/60 hover:text-ink")}>
      {({ isActive }) => (
        <>
          <span className={clsx(isActive ? "text-accent" : "text-muted group-hover:text-ink2")}>{item.icon}</span>
          {item.label}
        </>
      )}
    </NavLink>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user, can, logout } = useAuth();
  const theme = useTheme();
  const admin = ADMIN.filter((i) => !i.perm || can(i.perm));
  return (
    <div className="flex h-full flex-col" onClick={(e) => (e.target as HTMLElement).closest("a") && onNavigate?.()}>
      <div className="px-5 pb-6 pt-5"><Logo /></div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {MAIN.filter((i) => !i.perm || can(i.perm)).map((i) => <NavItem key={i.to} item={i} />)}
        {admin.length > 0 && (
          <>
            <div className="eyebrow px-3 pb-2 pt-6">Administration</div>
            {admin.map((i) => <NavItem key={i.to} item={i} />)}
          </>
        )}
      </nav>
      <div className="space-y-0.5 border-t border-line px-3 py-3">
        <NavItem item={{ to: "/audit", label: "Mon activité", icon: <Activity size={17} /> }} />
        <NavItem item={{ to: "/settings", label: "Paramètres", icon: <Settings size={17} /> }} />
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-ink2 hover:bg-raised/60 hover:text-ink">
          <span className="text-muted">{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</span>
          {theme === "dark" ? "Thème clair" : "Thème sombre"}
        </button>
        <div className="mt-2 flex items-center gap-3 rounded-lg px-3 py-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">
            {user?.display_name.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{user?.display_name}</div>
            <div className="truncate text-[11px] text-muted">{user?.role_names.join(" · ")}</div>
          </div>
          <button onClick={logout} className="btn-ghost h-8 px-2" title="Se déconnecter" aria-label="Se déconnecter"><LogOut size={16} /></button>
        </div>
      </div>
    </div>
  );
}

export function Shell() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => { setOpen(false); window.scrollTo(0, 0); }, [loc.pathname]);
  return (
    <div className="min-h-full lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-surface lg:block"><Sidebar /></aside>
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-line bg-surface/90 px-4 backdrop-blur lg:hidden">
        <Logo />
        <button className="btn-ghost px-2" onClick={() => setOpen(true)} aria-label="Ouvrir le menu"><Menu size={20} /></button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-line bg-surface">
            <button className="btn-ghost absolute right-2 top-4 px-2" onClick={() => setOpen(false)} aria-label="Fermer"><X size={18} /></button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
        <Outlet />
      </main>
    </div>
  );
}
