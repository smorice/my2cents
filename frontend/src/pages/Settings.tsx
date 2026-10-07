import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, ShieldCheck, ShieldOff } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Badge, Card, ErrorNote, Field, Notice, PageHeader, Segmented, toast } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dateTime } from "../lib/format";
import { setTheme, useTheme } from "../lib/theme";
import type { User } from "../lib/types";
import { PasswordRules } from "./Auth";

interface Sess { id: string; created_at: string; last_seen_at: string; ip: string | null; user_agent: string | null; current: boolean }

function MfaCard() {
  const { user, refresh } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  useEffect(() => { if (setup) QRCode.toDataURL(setup.uri, { margin: 1, width: 180 }).then(setQr); }, [setup]);
  const start = useMutation({ mutationFn: () => api<{ secret: string; uri: string }>("/auth/mfa/setup", { method: "POST" }), onSuccess: setSetup });
  const enable = useMutation({ mutationFn: () => api<User>("/auth/mfa/enable", { method: "POST", body: { code } }), onSuccess: () => { setSetup(null); setCode(""); refresh(); toast("Double authentification activée"); } });
  const disable = useMutation({ mutationFn: () => api<User>("/auth/mfa/disable", { method: "POST", body: { code, password: pw } }), onSuccess: () => { setCode(""); setPw(""); refresh(); toast("Double authentification désactivée"); } });
  return (
    <Card title="Double authentification (TOTP)" subtitle="Google Authenticator, 1Password, Authy…" actions={user?.totp_enabled ? <Badge className="border-pos/30 text-pos"><ShieldCheck size={12} /> Active</Badge> : <Badge>Inactive</Badge>}>
      {user?.totp_enabled ? (
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
          <Field label="Mot de passe"><input type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <Field label="Code actuel"><input className="input num" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></Field>
          <button className="btn-danger"><ShieldOff size={15} /> Désactiver</button>
          <div className="sm:col-span-3"><ErrorNote error={disable.error} /></div>
        </form>
      ) : setup ? (
        <form className="flex flex-col gap-5 sm:flex-row" onSubmit={(e) => { e.preventDefault(); enable.mutate(); }}>
          {qr && <img src={qr} alt="QR code à scanner" className="h-[180px] w-[180px] rounded-lg bg-white p-1" />}
          <div className="flex-1 space-y-3">
            <p className="text-sm text-ink2">Scannez le QR code, ou saisissez la clé : <code className="num break-all rounded bg-raised px-1.5 py-0.5 text-xs">{setup.secret}</code></p>
            <Field label="Code à 6 chiffres"><input className="input num w-40" inputMode="numeric" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></Field>
            <ErrorNote error={enable.error} />
            <button className="btn-primary" disabled={code.length !== 6}>Activer</button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-ink2">Protégez votre compte avec un code à usage unique demandé à chaque connexion.</p><button className="btn-outline" onClick={() => start.mutate()}>Configurer</button></div>
      )}
    </Card>
  );
}

export function SettingsPage() {
  const { user, refresh } = useAuth();
  const qc = useQueryClient();
  const theme = useTheme();
  const [name, setName] = useState(user?.display_name ?? "");
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => api<Sess[]>("/auth/sessions") });
  const profile = useMutation({ mutationFn: () => api<User>("/auth/me", { method: "PATCH", body: { display_name: name } }), onSuccess: () => { refresh(); toast("Profil enregistré"); } });
  const changePw = useMutation({
    mutationFn: () => {
      if (pw.next !== pw.confirm) throw new Error("Les deux mots de passe ne correspondent pas.");
      return api("/auth/password/change", { method: "POST", body: { current_password: pw.current, new_password: pw.next } });
    },
    onSuccess: () => { setPw({ current: "", next: "", confirm: "" }); qc.invalidateQueries({ queryKey: ["sessions"] }); toast("Mot de passe modifié — vos autres sessions ont été fermées"); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }) });
  return (
    <>
      <PageHeader eyebrow="Paramètres" title="Compte et sécurité" />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Profil">
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); profile.mutate(); }}>
            <Field label="Email"><input className="input" value={user?.email} disabled /></Field>
            <Field label="Nom affiché"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted">Rôles : {user?.role_names.join(", ")}</div>
              <button className="btn-primary" disabled={profile.isPending}>Enregistrer</button>
            </div>
          </form>
        </Card>
        <Card title="Apparence">
          <div className="flex items-center justify-between"><span className="text-sm text-ink2">Thème</span>
            <Segmented value={theme} onChange={setTheme} options={[{ value: "dark", label: "Sombre" }, { value: "light", label: "Clair" }]} /></div>
        </Card>
        <Card title="Mot de passe">
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); changePw.mutate(); }}>
            <Field label="Mot de passe actuel"><input type="password" autoComplete="current-password" className="input" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nouveau"><input type="password" autoComplete="new-password" className="input" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
              <Field label="Confirmation"><input type="password" autoComplete="new-password" className="input" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
            </div>
            <PasswordRules />
            <ErrorNote error={changePw.error} />
            <div className="flex justify-end"><button className="btn-primary" disabled={changePw.isPending || !pw.current}>Changer le mot de passe</button></div>
          </form>
        </Card>
        <MfaCard />
        <Card title="Sessions actives" subtitle="Appareils actuellement connectés à votre compte" className="xl:col-span-2" pad={false}>
          <ul className="divide-y divide-line px-6 pb-4">
            {sessions.data?.map((s) => (
              <li key={s.id} className="flex items-center gap-4 py-3">
                <Monitor size={18} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{s.user_agent ?? "Navigateur inconnu"}</div>
                  <div className="text-xs text-muted">{s.ip} · ouverte le {dateTime(s.created_at)} · vue {dateTime(s.last_seen_at)}</div>
                </div>
                {s.current ? <Badge className="border-accent/40 text-accent">Cette session</Badge> : <button className="btn-ghost h-8 text-xs" onClick={() => revoke.mutate(s.id)}>Révoquer</button>}
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <div className="mt-6"><Notice>Les sessions expirent après 12 h d'inactivité et au plus tard 14 jours après la connexion.</Notice></div>
    </>
  );
}
