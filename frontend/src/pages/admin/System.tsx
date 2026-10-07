import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Activity, AlertTriangle, Database, FlaskConical, RefreshCw, RotateCcw, ScrollText, Users, XCircle } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { DataTable, type Column } from "../../components/DataTable";
import { Badge, Card, ErrorNote, Loading, PageHeader, Pagination, Spinner, toast } from "../../components/ui";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { date, dateTime } from "../../lib/format";
import { STATUS } from "../../lib/labels";
import type { Page } from "../../lib/types";

const JOB_STATUS: Record<string, { label: string; cls: string }> = {
  queued: STATUS.queued, running: STATUS.running, completed: { label: "Terminée", cls: "text-pos border-pos/30" }, failed: STATUS.failed,
};
const KIND: Record<string, string> = { backtest: "Backtest", market_sync: "Synchro marché" };
const ago = (s?: string | null) => {
  if (!s) return "—";
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  return m < 1 ? "à l'instant" : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`;
};

// ------------------------------------------------------------------------------------------- overview

interface Overview {
  users: { total: number; active: number; new_7d: number };
  strategies: { total: number; templates: number };
  backtests: { total: number; last_24h: number; per_day: { date: string; count: number }[] };
  portfolios: number;
  jobs: { by_status: Record<string, number>; failed_24h: number; avg_duration_s: Record<string, number>; last_heartbeat: string | null; workers: { name: string; seen_at: string; concurrency: number }[] };
  errors: { last_24h: number; last_7d: number };
  audit: { last_24h: number; denied_24h: number };
  market: { instruments: number; in_error: number; oldest_sync: string | null };
}

function Tile({ icon, label, value, sub, to, alert }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; to?: string; alert?: boolean }) {
  const body = (
    <div className={clsx("card h-full p-5 transition", to && "hover:border-accent/40", alert && "border-neg/40")}>
      <div className="flex items-center gap-2 text-xs text-muted"><span className={alert ? "text-neg" : "text-accent"}>{icon}</span>{label}</div>
      <div className={clsx("num mt-2 text-2xl font-semibold tracking-tight", alert && "text-neg")}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export function AdminHomePage() {
  const q = useQuery({ queryKey: ["admin-overview"], queryFn: () => api<Overview>("/admin/overview"), refetchInterval: 15000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const o = q.data!;
  const max = Math.max(1, ...o.backtests.per_day.map((d) => d.count));
  const live = o.jobs.workers.filter((w) => Date.now() - new Date(w.seen_at).getTime() < 3 * 60_000);
  return (
    <>
      <PageHeader eyebrow="Administration" title="Vue d'ensemble" description="État de la plateforme : utilisateurs, calculs, erreurs, données de marché et activité auditée." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile icon={<Users size={15} />} label="Utilisateurs" value={o.users.total} sub={`${o.users.active} actifs · ${o.users.new_7d} nouveaux (7 j)`} to="/admin/users" />
        <Tile icon={<FlaskConical size={15} />} label="Stratégies" value={o.strategies.total} sub={`dont ${o.strategies.templates} modèles`} to="/admin/strategies" />
        <Tile icon={<Activity size={15} />} label="Backtests" value={o.backtests.total} sub={`${o.backtests.last_24h} sur 24 h · ${o.portfolios} portefeuilles`} />
        <Tile icon={<RefreshCw size={15} />} label="Tâches en cours" value={(o.jobs.by_status.running ?? 0) + (o.jobs.by_status.queued ?? 0)}
          alert={live.length === 0}
          sub={<>{o.jobs.by_status.running ?? 0} en cours · {o.jobs.by_status.queued ?? 0} en file · {live.length ? `${live.length} worker${live.length > 1 ? "s" : ""} actif${live.length > 1 ? "s" : ""} (${live.reduce((a, w) => a + w.concurrency, 0)} slots)` : `aucun worker actif (dernier signe ${ago(o.jobs.last_heartbeat)})`}</>} to="/admin/jobs" />
        <Tile icon={<XCircle size={15} />} label="Tâches en échec (24 h)" value={o.jobs.failed_24h} alert={o.jobs.failed_24h > 0} to="/admin/jobs?status=failed" />
        <Tile icon={<AlertTriangle size={15} />} label="Erreurs applicatives (24 h)" value={o.errors.last_24h} sub={`${o.errors.last_7d} sur 7 jours`} alert={o.errors.last_24h > 0} to="/admin/errors" />
        <Tile icon={<ScrollText size={15} />} label="Événements audités (24 h)" value={o.audit.last_24h} sub={`${o.audit.denied_24h} accès refusés`} alert={o.audit.denied_24h > 20} to="/admin/audit" />
        <Tile icon={<Database size={15} />} label="Données de marché" value={o.market.instruments} sub={<>{o.market.in_error} en erreur · plus ancienne synchro {ago(o.market.oldest_sync)}</>} alert={o.market.in_error > 0} to="/admin/providers" />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Backtests par jour" subtitle="14 derniers jours">
          {o.backtests.per_day.length === 0 ? <p className="text-sm text-muted">Aucun backtest récent.</p> : (
            <div className="flex h-32 items-end gap-1.5" role="img" aria-label="Nombre de backtests lancés par jour">
              {o.backtests.per_day.map((d) => (
                <div key={d.date} className="flex flex-1 flex-col items-center gap-1" title={`${date(d.date)} : ${d.count}`}>
                  <span className="num text-[10px] text-muted">{d.count}</span>
                  <div className="w-full rounded-t bg-accent/70" style={{ height: `${(d.count / max) * 96}px` }} />
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Durée moyenne des tâches" subtitle="Tâches terminées sur 7 jours">
          <dl className="space-y-2 text-sm">
            {Object.entries(o.jobs.avg_duration_s).map(([k, v]) => <div key={k} className="flex justify-between"><dt className="text-ink2">{KIND[k] ?? k}</dt><dd className="num">{v} s</dd></div>)}
            {Object.keys(o.jobs.avg_duration_s).length === 0 && <p className="text-muted">Pas de données.</p>}
          </dl>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4 text-xs">
            {Object.entries(o.jobs.by_status).map(([k, v]) => <Badge key={k} className={JOB_STATUS[k]?.cls}>{JOB_STATUS[k]?.label ?? k} · {v}</Badge>)}
          </div>
        </Card>
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------- jobs

interface AdminJob {
  id: string; kind: string; status: string; progress: number; message: string | null; error: string | null; internal_error: string | null;
  attempts: number; created_at: string; started_at: string | null; finished_at: string | null; heartbeat_at: string | null;
  worker: string | null; owner_email: string | null; payload: Record<string, unknown>;
}

export function AdminJobsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState(new URLSearchParams(location.search).get("status") ?? "");
  const [kind, setKind] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["admin-jobs", status, kind, page],
    queryFn: () => api<Page<AdminJob>>("/admin/jobs", { params: { status, kind, page } }),
    refetchInterval: 4000, placeholderData: (p) => p,
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "retry" | "cancel" }) => api(`/admin/jobs/${id}/${action}`, { method: "POST" }),
    onSuccess: (_, v) => { toast(v.action === "retry" ? "Tâche relancée" : "Tâche annulée"); qc.invalidateQueries({ queryKey: ["admin-jobs"] }); },
    onError: (e) => toast((e as Error).message, "err"),
  });
  return (
    <>
      <PageHeader eyebrow="Administration" title="Tâches de calcul" description="File des backtests et synchronisations exécutés par le worker. Les échecs gardent leur détail technique ici ; l'utilisateur ne voit qu'un message compréhensible." />
      <div className="card">
        <div className="flex flex-wrap gap-2 p-3">
          <select className="input w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Statut">
            <option value="">Tous les statuts</option>{Object.entries(JOB_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select className="input w-auto" value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }} aria-label="Type">
            <option value="">Tous les types</option>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        {q.isLoading ? <Loading /> : (
          <div className="overflow-x-auto px-2 pb-3">
            <table className="table-base">
              <thead><tr><th>Créée</th><th>Type</th><th>Statut</th><th>Utilisateur</th><th className="text-right">Durée</th><th>Message</th><th /></tr></thead>
              <tbody>
                {q.data!.items.map((j) => {
                  const dur = j.started_at && j.finished_at ? (new Date(j.finished_at).getTime() - new Date(j.started_at).getTime()) / 1000 : null;
                  return (
                    <Fragment key={j.id}>
                      <tr className="cursor-pointer hover:bg-raised/50" onClick={() => setOpen(open === j.id ? null : j.id)} aria-expanded={open === j.id}>
                        <td className="num whitespace-nowrap text-ink2">{dateTime(j.created_at)}</td>
                        <td className="whitespace-nowrap">{KIND[j.kind] ?? j.kind}{j.attempts > 1 && <span className="ml-1 text-xs text-muted">×{j.attempts}</span>}</td>
                        <td className="whitespace-nowrap"><Badge className={JOB_STATUS[j.status]?.cls}>{JOB_STATUS[j.status]?.label ?? j.status}{j.status === "running" && ` ${Math.round(j.progress * 100)} %`}</Badge></td>
                        <td className="max-w-[200px] truncate text-ink2">{j.owner_email ?? "système"}</td>
                        <td className="num text-right text-ink2">{dur == null ? "—" : `${dur.toFixed(1)} s`}</td>
                        <td className="max-w-[320px] truncate text-xs text-muted">{j.error ?? j.message}</td>
                        <td className="whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                          {j.status === "failed" && <button className="btn-ghost h-7 px-2 text-xs" onClick={() => act.mutate({ id: j.id, action: "retry" })}><RotateCcw size={13} /> Relancer</button>}
                          {j.status === "queued" && <button className="btn-ghost h-7 px-2 text-xs" onClick={() => act.mutate({ id: j.id, action: "cancel" })}><XCircle size={13} /> Annuler</button>}
                        </td>
                      </tr>
                      {open === j.id && (
                        <tr><td colSpan={7} className="bg-raised/40">
                          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                            <dt className="text-muted">Identifiant</dt><dd className="num">{j.id}</dd>
                            <dt className="text-muted">Worker</dt><dd className="num">{j.worker ?? "—"} · dernier signe de vie {ago(j.heartbeat_at)}</dd>
                            <dt className="text-muted">Paramètres</dt><dd className="num break-all">{JSON.stringify(j.payload)}{typeof j.payload.backtest_id === "string" && <> · <Link className="text-accent hover:underline" to={`/backtests/${j.payload.backtest_id}`}>backtest</Link></>}</dd>
                            {j.error && <><dt className="text-muted">Message utilisateur</dt><dd>{j.error}</dd></>}
                          </dl>
                          {j.internal_error && <pre className="mt-3 max-h-72 overflow-auto rounded-lg border border-line bg-surface p-3 text-[11px] leading-relaxed text-ink2">{j.internal_error}</pre>}
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {q.data!.items.length === 0 && <p className="py-10 text-center text-sm text-muted">Aucune tâche.</p>}
            <Pagination page={q.data!.page} pages={q.data!.pages} total={q.data!.total} onPage={setPage} />
          </div>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------- errors

interface AppErr { id: number; occurred_at: string; request_id: string | null; source: string; method: string | null; path: string | null; user_id: string | null; error_type: string; message: string; traceback: string | null }

export function AdminErrorsPage() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const r = useQuery({ queryKey: ["admin-errors", q, page], queryFn: () => api<Page<AppErr>>("/admin/errors", { params: { q, page } }), placeholderData: (p) => p });
  return (
    <>
      <PageHeader eyebrow="Administration" title="Erreurs applicatives"
        description="Erreurs inattendues de l'API et du worker, avec leur trace complète. L'utilisateur n'en voit que la référence : cherchez-la ici." />
      <div className="card">
        <div className="p-3"><input className="input max-w-sm" placeholder="Référence, message ou chemin…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Rechercher une erreur" /></div>
        {r.isLoading ? <Loading /> : r.data!.items.length === 0 ? <p className="px-6 py-12 text-center text-sm text-muted">Aucune erreur enregistrée. 🎉</p> : (
          <div className="overflow-x-auto px-2 pb-3">
            <table className="table-base">
              <thead><tr><th>Date</th><th>Source</th><th>Référence</th><th>Erreur</th><th>Chemin</th></tr></thead>
              <tbody>
                {r.data!.items.map((e) => (
                  <Fragment key={e.id}>
                    <tr className="cursor-pointer hover:bg-raised/50" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                      <td className="num whitespace-nowrap text-ink2">{dateTime(e.occurred_at)}</td>
                      <td><Badge>{e.source}</Badge></td>
                      <td className="num text-xs">{e.request_id}</td>
                      <td className="max-w-[420px]"><div className="font-medium text-neg">{e.error_type}</div><div className="truncate text-xs text-ink2">{e.message}</div></td>
                      <td className="num max-w-[240px] truncate text-xs text-muted">{e.method} {e.path}</td>
                    </tr>
                    {open === e.id && <tr><td colSpan={5} className="bg-raised/40"><pre className="max-h-96 overflow-auto rounded-lg border border-line bg-surface p-3 text-[11px] leading-relaxed text-ink2">{e.traceback ?? e.message}</pre></td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
            <Pagination page={r.data!.page} pages={r.data!.pages} total={r.data!.total} onPage={setPage} />
          </div>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------- providers

interface ProvInst { symbol: string; name: string; kind: string; provider: string; first_date: string | null; last_date: string | null; last_synced_at: string | null; sync_error: string | null }
interface Providers {
  providers: { name: string; label: string; description: string; instruments: number; in_error: number }[];
  instruments: ProvInst[];
  syncs: { id: number; symbol: string; provider: string; started_at: string; finished_at: string | null; status: string; bars: number; first_date: string | null; last_date: string | null; error: string | null }[];
  sync_job: string | null;
}

export function AdminProvidersPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin-providers"], queryFn: () => api<Providers>("/admin/providers"),
    refetchInterval: (q) => (q.state.data?.sync_job ? 3000 : false),
  });
  const job = useQuery({
    queryKey: ["job", q.data?.sync_job], queryFn: () => api<{ progress: number; message: string | null }>(`/jobs/${q.data!.sync_job}`),
    enabled: !!q.data?.sync_job, refetchInterval: 2000, retry: false,
  });
  const sync = useMutation({
    mutationFn: () => api("/admin/market/sync", { method: "POST" }),
    onSuccess: () => { toast("Synchronisation lancée"); qc.invalidateQueries({ queryKey: ["admin-providers"] }); },
    onError: (e) => toast((e as Error).message, "err"),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data!;
  const cols: Column<ProvInst>[] = [
    { key: "symbol", label: "Symbole", sticky: true, value: (i) => i.symbol, render: (i) => <><div className="num font-medium">{i.symbol}</div><div className="text-xs text-muted">{i.name}</div></> },
    { key: "kind", label: "Type", value: (i) => i.kind, render: (i) => <Badge>{i.kind}</Badge> },
    { key: "provider", label: "Fournisseur", hidden: true, value: (i) => i.provider, render: (i) => i.provider },
    { key: "first", label: "Depuis", value: (i) => i.first_date, render: (i) => <span className="num text-ink2">{date(i.first_date)}</span> },
    { key: "last", label: "Dernière cotation", value: (i) => i.last_date, render: (i) => <span className="num text-ink2">{date(i.last_date)}</span> },
    { key: "synced", label: "Synchronisé", value: (i) => i.last_synced_at, render: (i) => <span className="text-ink2">{ago(i.last_synced_at)}</span> },
    { key: "state", label: "État", value: (i) => (i.sync_error ? 1 : 0), render: (i) => i.sync_error ? <span className="text-xs text-neg" title={i.sync_error}>Erreur : {i.sync_error.slice(0, 60)}</span> : <span className="text-xs text-pos">OK</span> },
  ];
  return (
    <>
      <PageHeader eyebrow="Administration" title="Données de marché"
        description="Fournisseurs configurés, fraîcheur de chaque série et historique des synchronisations. Toutes les cotations sont datées et attribuées à leur source."
        actions={can("market:refresh") && (
          <button className="btn-primary" onClick={() => sync.mutate()} disabled={sync.isPending || !!d.sync_job}>
            {d.sync_job ? <Spinner className="text-accent-ink" /> : <RefreshCw size={15} />} {d.sync_job ? `Synchronisation… ${Math.round((job.data?.progress ?? 0) * 100)} %` : "Tout synchroniser"}
          </button>
        )} />
      <div className="mb-6 grid gap-4 md:grid-cols-2">
        {d.providers.map((p) => (
          <div key={p.name} className="card p-5">
            <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{p.label}</h2><Badge className="border-pos/30 text-pos">Actif</Badge></div>
            <p className="mt-2 text-xs leading-relaxed text-ink2">{p.description}</p>
            <div className="num mt-3 text-xs text-muted">{p.instruments} instruments · {p.in_error} en erreur</div>
          </div>
        ))}
        <div className="card border-dashed p-5 text-xs leading-relaxed text-muted">
          <h2 className="mb-2 text-sm font-semibold text-ink2">Ajouter un fournisseur</h2>
          Le moteur de backtest ne dépend que de la couche normalisée : un nouveau fournisseur (API payante, fichiers EOD…) s'ajoute en
          implémentant l'interface <code className="num">MarketDataProvider</code> côté serveur, sans toucher aux stratégies.
        </div>
      </div>
      <Card title="Instruments" pad={false}>
        <DataTable rows={d.instruments} columns={cols} rowKey={(i) => i.symbol} storageKey="admin-instruments" csvName="my2cents-instruments" search={(i) => `${i.symbol} ${i.name}`} />
      </Card>
      <Card title="Dernières synchronisations" className="mt-6" pad={false}>
        <div className="overflow-x-auto px-3 pb-3">
          <table className="table-base">
            <thead><tr><th>Début</th><th>Symbole</th><th>Statut</th><th className="text-right">Barres</th><th>Période</th><th>Erreur</th></tr></thead>
            <tbody>{d.syncs.map((s) => (
              <tr key={s.id}>
                <td className="num whitespace-nowrap text-ink2">{dateTime(s.started_at)}</td>
                <td className="num">{s.symbol}</td>
                <td><Badge className={s.status === "success" ? "border-pos/30 text-pos" : "border-neg/30 text-neg"}>{s.status === "success" ? "Succès" : "Échec"}</Badge></td>
                <td className="num text-right">{s.bars}</td>
                <td className="num whitespace-nowrap text-xs text-ink2">{s.first_date ? `${date(s.first_date)} → ${date(s.last_date)}` : "—"}</td>
                <td className="max-w-[300px] truncate text-xs text-neg" title={s.error ?? ""}>{s.error}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------------------------------- strategies

interface AdminStrategy { id: string; name: string; kind: string; status: string; is_template: boolean; owner_email: string | null; current_version: number; deleted: boolean; updated_at: string; backtests: number }

export function AdminStrategiesPage() {
  const q = useQuery({ queryKey: ["admin-strategies"], queryFn: () => api<AdminStrategy[]>("/admin/strategies") });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const cols: Column<AdminStrategy>[] = [
    { key: "name", label: "Stratégie", sticky: true, value: (s) => s.name, render: (s) => <><div className="font-medium">{s.is_template ? <Link to={`/strategies/${s.id}`} className="hover:text-accent">{s.name}</Link> : s.name}</div><div className="text-xs text-muted">{s.kind}</div></> },
    { key: "owner", label: "Propriétaire", value: (s) => s.owner_email ?? "Modèle", render: (s) => s.is_template ? <Badge className="border-accent/40 text-accent">Modèle</Badge> : <span className="text-ink2">{s.owner_email}</span> },
    { key: "status", label: "Statut", value: (s) => (s.deleted ? "supprimée" : s.status), render: (s) => s.deleted ? <Badge className="text-muted">Supprimée</Badge> : <Badge className={STATUS[s.status]?.cls}>{STATUS[s.status]?.label}</Badge> },
    { key: "version", label: "Version", align: "right", value: (s) => s.current_version, render: (s) => `v${s.current_version}` },
    { key: "bt", label: "Backtests", align: "right", value: (s) => s.backtests, render: (s) => s.backtests },
    { key: "updated", label: "Modifiée", value: (s) => s.updated_at, render: (s) => <span className="num text-ink2">{dateTime(s.updated_at)}</span> },
  ];
  return (
    <>
      <PageHeader eyebrow="Administration" title="Stratégies" description="Toutes les stratégies de la plateforme. Le contenu des stratégies personnelles reste privé : seules leurs métadonnées sont visibles ici." />
      <div className="card pt-3"><DataTable rows={q.data!} columns={cols} rowKey={(s) => s.id} storageKey="admin-strategies" csvName="my2cents-strategies" search={(s) => `${s.name} ${s.kind} ${s.owner_email ?? ""}`} /></div>
    </>
  );
}
