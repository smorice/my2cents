import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Logo } from "../components/Logo";
import { ErrorNote, Field, Notice } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { User } from "../lib/types";

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden border-r border-line bg-surface lg:flex lg:flex-col lg:justify-between lg:p-12">
        <Logo />
        <HeroArt />
        <div className="relative max-w-md">
          <p className="text-2xl font-semibold leading-snug tracking-tight">
            Regarder le passé avec rigueur<br /><span className="text-muted">pour décider l'avenir avec lucidité.</span>
          </p>
          <p className="mt-4 text-sm leading-relaxed text-ink2">
            Explorez, backtestez et comparez des stratégies d'investissement sur des données historiques réelles,
            avec des hypothèses transparentes et chaque décision expliquée.
          </p>
          <p className="mt-6 text-xs text-muted">Outil de recherche et de simulation. Les performances passées ne préjugent pas des performances futures.</p>
        </div>
      </div>
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-10 lg:hidden"><Logo /></div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-ink2">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 text-sm text-ink2">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

function HeroArt() {
  // Decorative: a past (dotted) trajectory turning into projected paths.
  return (
    <svg className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 opacity-90" viewBox="0 0 600 300" aria-hidden="true">
      <defs>
        <linearGradient id="fade" x1="0" x2="1"><stop offset="0" stopColor="rgb(var(--accent))" stopOpacity="0" /><stop offset=".5" stopColor="rgb(var(--accent))" stopOpacity=".9" /><stop offset="1" stopColor="rgb(var(--accent))" stopOpacity=".2" /></linearGradient>
      </defs>
      {[0, 1, 2, 3, 4].map((i) => <line key={i} x1="0" x2="600" y1={60 + i * 50} y2={60 + i * 50} stroke="rgb(var(--line))" strokeWidth="1" />)}
      <path d="M0 230 C60 225 90 240 130 210 S200 190 240 200 S290 150 320 150" fill="none" stroke="rgb(var(--muted))" strokeWidth="2" strokeDasharray="1 6" strokeLinecap="round" />
      <path d="M320 150 C370 140 410 120 460 100 S540 60 600 50" fill="none" stroke="url(#fade)" strokeWidth="2.5" />
      <path d="M320 150 C380 150 420 150 470 135 S550 120 600 115" fill="none" stroke="rgb(var(--accent))" strokeOpacity=".35" strokeWidth="1.5" />
      <path d="M320 150 C380 165 430 185 480 180 S560 170 600 185" fill="none" stroke="rgb(var(--accent))" strokeOpacity=".2" strokeWidth="1.5" />
      <circle cx="320" cy="150" r="5" fill="rgb(var(--surface))" stroke="rgb(var(--accent))" strokeWidth="2" />
    </svg>
  );
}

export function LoginPage() {
  const { user, refresh } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfa, setMfa] = useState(false);
  const [code, setCode] = useState("");
  const cfg = useQuery({ queryKey: ["auth-config"], queryFn: () => api<{ allow_registration: boolean }>("/auth/config") });

  const login = useMutation({
    mutationFn: () => api<{ mfa_required: boolean; user: User | null }>("/auth/login", { method: "POST", body: { email, password } }),
    onSuccess: (r) => {
      if (r.mfa_required) setMfa(true);
      else { qc.setQueryData(["me"], r.user); nav(from, { replace: true }); }
    },
  });
  const verify = useMutation({
    mutationFn: () => api<User>("/auth/mfa/verify", { method: "POST", body: { code } }),
    onSuccess: (u) => { qc.setQueryData(["me"], u); refresh(); nav(from, { replace: true }); },
  });

  if (user) return <Navigate to={from} replace />;

  if (mfa)
    return (
      <AuthLayout title="Double authentification" subtitle="Saisissez le code à 6 chiffres affiché par votre application d'authentification.">
        <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); verify.mutate(); }}>
          <Field label="Code de vérification">
            <input className="input num text-center text-lg tracking-[0.4em]" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6}
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <ErrorNote error={verify.error} />
          <button className="btn-primary h-10 w-full" disabled={code.length !== 6 || verify.isPending}><ShieldCheck size={16} /> Vérifier</button>
        </form>
      </AuthLayout>
    );

  return (
    <AuthLayout title="Connexion" subtitle="Accédez à votre laboratoire de stratégies."
      footer={cfg.data?.allow_registration && <>Pas encore de compte ? <Link to="/register" className="font-medium text-accent hover:underline">Créer un compte</Link></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); login.mutate(); }}>
        <Field label="Email"><input className="input h-10" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={<span className="flex justify-between"><span>Mot de passe</span><Link to="/forgot-password" className="font-normal text-muted hover:text-ink">Oublié ?</Link></span>}>
          <input className="input h-10" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorNote error={login.error} />
        <button className="btn-primary h-10 w-full" disabled={login.isPending}>Se connecter <ArrowRight size={16} /></button>
      </form>
    </AuthLayout>
  );
}

export function PasswordRules() {
  return <p className="hint">12 caractères minimum, avec au moins 3 types parmi : minuscules, majuscules, chiffres, symboles.</p>;
}

export function RegisterPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [f, setF] = useState({ email: "", display_name: "", password: "", confirm: "" });
  const reg = useMutation({
    mutationFn: () => {
      if (f.password !== f.confirm) throw new Error("Les deux mots de passe ne correspondent pas.");
      return api<User>("/auth/register", { method: "POST", body: { email: f.email, display_name: f.display_name, password: f.password } });
    },
    onSuccess: (u) => { qc.setQueryData(["me"], u); nav("/onboarding", { replace: true }); },
  });
  return (
    <AuthLayout title="Créer un compte" subtitle="Gratuit, personnel, sans engagement."
      footer={<>Déjà inscrit ? <Link to="/login" className="font-medium text-accent hover:underline">Se connecter</Link></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); reg.mutate(); }}>
        <Field label="Nom affiché"><input className="input h-10" required value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
        <Field label="Email"><input className="input h-10" type="email" autoComplete="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Mot de passe"><input className="input h-10" type="password" autoComplete="new-password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /><PasswordRules /></Field>
        <Field label="Confirmation"><input className="input h-10" type="password" autoComplete="new-password" required value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
        <ErrorNote error={reg.error} />
        <button className="btn-primary h-10 w-full" disabled={reg.isPending}>Créer mon compte</button>
      </form>
    </AuthLayout>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState("");
  const cfg = useQuery({ queryKey: ["auth-config"], queryFn: () => api<{ password_reset_by_mail: boolean }>("/auth/config") });
  const m = useMutation({ mutationFn: () => api<{ detail: string }>("/auth/password/forgot", { method: "POST", body: { email } }) });
  return (
    <AuthLayout title="Mot de passe oublié" subtitle="Recevez un lien de réinitialisation valable une heure."
      footer={<Link to="/login" className="font-medium text-accent hover:underline">Retour à la connexion</Link>}>
      {m.isSuccess ? <Notice>{m.data.detail}</Notice> : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          {cfg.data && !cfg.data.password_reset_by_mail && (
            <Notice tone="warn">L'envoi d'emails n'est pas configuré sur ce serveur : demandez à un administrateur de générer un lien de réinitialisation.</Notice>
          )}
          <Field label="Email"><input className="input h-10" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <ErrorNote error={m.error} />
          <button className="btn-primary h-10 w-full" disabled={m.isPending}><KeyRound size={16} /> Envoyer le lien</button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [pw, setPw] = useState("");
  const m = useMutation({
    mutationFn: () => api("/auth/password/reset", { method: "POST", body: { token: params.get("token") ?? "", password: pw } }),
    onSuccess: () => setTimeout(() => nav("/login"), 1500),
  });
  return (
    <AuthLayout title="Nouveau mot de passe" footer={<Link to="/login" className="font-medium text-accent hover:underline">Retour à la connexion</Link>}>
      {m.isSuccess ? <Notice>Mot de passe modifié. Toutes vos sessions ont été fermées ; redirection…</Notice> : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <Field label="Nouveau mot de passe"><input className="input h-10" type="password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} /><PasswordRules /></Field>
          <ErrorNote error={m.error} />
          <button className="btn-primary h-10 w-full" disabled={m.isPending}>Valider</button>
        </form>
      )}
    </AuthLayout>
  );
}
