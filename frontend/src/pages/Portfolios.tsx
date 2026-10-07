import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Briefcase, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BacktestForm, defaultLaunch, type LaunchConfig } from "../components/BacktestForm";
import { Badge, Card, Empty, ErrorNote, Field, Loading, Modal, Notice, PageHeader, SourceBadge, Spinner, Stat, toast } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { date, dateTime, eur, pct, spct, tone } from "../lib/format";
import { FREQ, STATUS } from "../lib/labels";
import { useBenchmarks, useStrategies } from "../lib/queries";
import type { BacktestFull, Portfolio } from "../lib/types";
import { BacktestView, Verdict } from "./Backtest";

interface FormState { name: string; description: string; strategy_id: string; strategy_version: number | null; benchmark: string | null; launch: LaunchConfig }

function toBody(f: FormState) {
  const l = f.launch;
  return {
    name: f.name, description: f.description, strategy_id: f.strategy_id, strategy_version: f.strategy_version, benchmark: f.benchmark, currency: "EUR",
    settings: { start: l.start, end: null, initial_capital: l.initial_capital, contributions: l.contributions, tax_mode: l.tax_mode, fractional: l.fractional },
  };
}

function PortfolioForm({ initial, onSubmit, pending, error, submitLabel }: { initial: FormState; onSubmit: (f: FormState) => void; pending: boolean; error: unknown; submitLabel: string }) {
  const [f, setF] = useState(initial);
  const strategies = useStrategies();
  const benchmarks = useBenchmarks();
  const sel = strategies.data?.find((s) => s.id === f.strategy_id);
  const stratBench = benchmarks.data?.find((b) => b.symbol === sel?.definition?.benchmark)?.label ?? sel?.definition?.benchmark;
  return (
    <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); onSubmit(f); }}>
      <Field label="Nom du portefeuille"><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="ex. PEA enfants — DCA 200 €/mois" /></Field>
      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <Field label="Stratégie appliquée">
          <select className="input" required value={f.strategy_id} onChange={(e) => setF({ ...f, strategy_id: e.target.value, strategy_version: null })}>
            <option value="" disabled>Choisir…</option>
            {strategies.data?.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_template ? " (modèle)" : ""}</option>)}
          </select>
        </Field>
        <Field label="Version" hint="Vide = toujours la dernière">
          <select className="input" value={f.strategy_version ?? ""} onChange={(e) => setF({ ...f, strategy_version: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Dernière</option>
            {sel && Array.from({ length: sel.current_version }, (_, i) => sel.current_version - i).map((v) => <option key={v} value={v}>v{v}</option>)}
          </select>
        </Field>
      </div>
      <p className="-mt-2 text-xs text-muted">La simulation court de la date de début jusqu'à aujourd'hui : c'est « ce que serait devenu ce portefeuille ».</p>
      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <Field label="Indice de référence" hint="Reçoit exactement les mêmes versements que le portefeuille.">
          <select className="input" value={f.benchmark ?? ""} onChange={(e) => setF({ ...f, benchmark: e.target.value || null })}>
            <option value="">Celui de la stratégie{stratBench ? ` (${stratBench})` : ""}</option>
            {benchmarks.data?.filter((b) => b.available).map((b) => <option key={b.symbol} value={b.symbol}>{b.label}</option>)}
          </select>
        </Field>
        <Field label="Devise" hint="Pas de conversion de change simulée."><select className="input" value="EUR" disabled><option>EUR</option></select></Field>
      </div>
      <BacktestForm value={f.launch} onChange={(launch) => setF({ ...f, launch })} />
      <Field label="Notes"><textarea className="input min-h-[64px] py-2" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <ErrorNote error={error} />
      <div className="flex justify-end"><button className="btn-primary" disabled={pending || !f.strategy_id}>{submitLabel}</button></div>
    </form>
  );
}

export function PortfoliosPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["portfolios"], queryFn: () => api<Portfolio[]>("/portfolios"),
    refetchInterval: (q) => (q.state.data?.some((p) => ["queued", "running"].includes(p.latest_simulation?.status ?? "")) ? 2500 : false),
  });
  const create = useMutation({
    mutationFn: (f: FormState) => api<Portfolio>("/portfolios", { method: "POST", body: toBody(f) }),
    onSuccess: (p) => { qc.invalidateQueries({ queryKey: ["portfolios"] }); setOpen(false); nav(`/portfolios/${p.id}`); },
  });
  const launch = defaultLaunch();
  launch.initial_capital = 1000;
  launch.contributions = { amount: 200, frequency: "monthly", start: null, end: null };
  launch.fractional = false;
  if (q.isLoading) return <Loading />;
  return (
    <>
      <PageHeader eyebrow="Portefeuilles" title="Portefeuilles simulés"
        description="Associez une stratégie à un plan d'investissement — capital de départ, versements automatiques, fiscalité — et suivez ce qu'il serait devenu jusqu'à aujourd'hui."
        actions={can("portfolio:write") && <button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} /> Nouveau portefeuille</button>} />
      {q.data!.length === 0 ? (
        <div className="card"><Empty icon={<Briefcase size={28} />} title="Aucun portefeuille" action={can("portfolio:write") && <button className="btn-outline" onClick={() => setOpen(true)}><Plus size={15} /> Créer un portefeuille</button>}>
          Par exemple : 200 € par mois sur la stratégie « Surperformance CAC 40 » depuis 2015.
        </Empty></div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {q.data!.map((p) => {
            const s = p.latest_simulation?.summary;
            return (
              <Link key={p.id} to={`/portfolios/${p.id}`} className="card group p-5 transition-colors hover:border-accent/40">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold group-hover:text-accent">{p.name}</h3>
                    <div className="mt-0.5 truncate text-xs text-muted">{p.strategy_name} · {p.strategy_version ? `v${p.strategy_version}` : "dernière version"}</div>
                  </div>
                  {p.latest_simulation && p.latest_simulation.status !== "done" && <Badge className={STATUS[p.latest_simulation.status].cls}>{STATUS[p.latest_simulation.status].label}</Badge>}
                </div>
                <div className="num mt-5 text-2xl font-semibold tracking-tight">{eur(s?.final_value)}</div>
                <div className="num mt-1 text-xs text-muted">versé {eur(s?.total_invested)} · <span className={tone(s?.net_profit)}>{s ? `${eur(s.net_profit)} (${spct((s.final_value ?? 0) / (s.total_invested || 1) - 1)})` : "—"}</span></div>
                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-ink2">
                  <span>Depuis {date(p.settings.start)}</span>
                  {p.settings.contributions.frequency !== "none" && <span>{eur(p.settings.contributions.amount)} · {FREQ[p.settings.contributions.frequency].toLowerCase()}</span>}
                  {s && <span>TRI <span className={tone(s.irr)}>{pct(s.irr)}</span></span>}
                </div>
              </Link>
            );
          })}
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Nouveau portefeuille" wide>
        <PortfolioForm initial={{ name: "", description: "", strategy_id: "", strategy_version: null, benchmark: null, launch }} onSubmit={(f) => create.mutate(f)} pending={create.isPending} error={create.error} submitLabel="Créer et simuler" />
      </Modal>
    </>
  );
}

/** §18 « Vue générale » of a simulated portfolio, as of the last simulated day. */
function Overview({ bt }: { bt: BacktestFull }) {
  const r = bt.results!;
  const s = r.summary.strategy, b = r.summary.benchmark;
  const ser = r.series;
  const last = ser.dates.length - 1;
  const benchValue = ser.benchmark_equity[last];
  const dd = ser.drawdown[last];
  const bench = r.names[bt.config.benchmark] ?? bt.config.benchmark;
  return (
    <section className="card mb-6 p-5 sm:p-6" aria-label="Vue générale">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold tracking-tight">Vue générale</h2>
        <span className="text-xs text-muted">Valeurs simulées au {date(r.effective_period.end)}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Valeur actuelle simulée" value={eur(s.final_value)} />
        <Stat label="Capital investi" value={eur(s.total_invested)} />
        <Stat label="Gains / pertes" value={eur(s.net_profit)} valueClass={tone(s.net_profit)} sub={spct((s.final_value ?? 0) / (s.total_invested || 1) - 1)} />
        <Stat label="Performance annuelle" value={pct(s.irr)} valueClass={tone(s.irr)} sub={`TRI · CAGR ${pct(s.cagr)}`} />
        <Stat label={bench.length > 22 ? "Indice (mêmes versements)" : bench} value={eur(benchValue)} sub={`CAGR ${pct(b.cagr)}`} />
        <Stat label="Drawdown actuel" value={pct(dd)} valueClass={dd < -0.1 ? "text-neg" : undefined} sub={`pire : ${pct(s.max_drawdown)}`} />
      </div>
      <div className="mt-5 border-t border-line pt-5"><Verdict s={s} b={b} bench={bench} /></div>
    </section>
  );
}

export function PortfolioPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [edit, setEdit] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const p = useQuery({
    queryKey: ["portfolio", id], queryFn: () => api<Portfolio>(`/portfolios/${id}`),
    refetchInterval: (q) => (["queued", "running"].includes(q.state.data?.latest_simulation?.status ?? "") ? 1500 : false),
  });
  const simId = p.data?.latest_simulation?.status === "done" ? p.data.latest_simulation.id : null;
  const bt = useQuery({ queryKey: ["backtest", simId], queryFn: () => api<BacktestFull>(`/backtests/${simId}`), enabled: !!simId });
  const patch = useMutation({
    mutationFn: (f: FormState) => api<Portfolio>(`/portfolios/${id}`, { method: "PATCH", body: toBody(f) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["portfolio", id] }); qc.invalidateQueries({ queryKey: ["portfolios"] }); setEdit(false); toast("Portefeuille mis à jour — nouvelle simulation lancée"); },
  });
  const resim = useMutation({
    mutationFn: () => api(`/portfolios/${id}/simulate`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["portfolio", id] }),
  });
  const del = useMutation({
    mutationFn: () => api(`/portfolios/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["portfolios"] }); nav("/portfolios"); toast("Portefeuille supprimé"); },
  });
  if (p.isLoading) return <Loading />;
  if (p.error) return <ErrorNote error={p.error} />;
  const pf = p.data!;
  const sim = pf.latest_simulation;
  const st = pf.settings;
  const initial: FormState = {
    name: pf.name, description: pf.description, strategy_id: pf.strategy_id ?? "", strategy_version: pf.strategy_version, benchmark: pf.benchmark,
    launch: { ...defaultLaunch(), start: st.start, initial_capital: st.initial_capital, contributions: st.contributions, tax_mode: st.tax_mode as "none" | "pfu", fractional: st.fractional },
  };
  return (
    <>
      <PageHeader eyebrow={<span className="flex items-center gap-2"><Link to="/portfolios" className="hover:text-ink">Portefeuilles</Link><SourceBadge kind="simulated" title="Portefeuille simulé sur données historiques réelles : aucun ordre réel" /></span>} title={pf.name}
        description={<>Stratégie <Link to={`/strategies/${pf.strategy_id}`} className="text-accent hover:underline">{pf.strategy_name}</Link> ({pf.strategy_version ? `v${pf.strategy_version} figée` : `dernière version, v${pf.strategy_current_version}`}) · depuis le {date(st.start)} · {eur(st.initial_capital)} au départ{st.contributions.frequency !== "none" && ` puis ${eur(st.contributions.amount)} ${FREQ[st.contributions.frequency].toLowerCase()}`}{st.tax_mode === "pfu" ? " · compte-titres (flat tax)" : " · sans fiscalité (PEA)"}.</>}
        actions={can("portfolio:write") && (
          <>
            <button className="btn-outline" onClick={() => setEdit(true)}><Pencil size={15} /> Modifier l'allocation</button>
            <button className="btn-ghost" onClick={() => resim.mutate()} disabled={resim.isPending} title="Resimuler jusqu'à aujourd'hui"><RefreshCw size={15} /></button>
            <button className="btn-ghost" onClick={() => setConfirmDel(true)} title="Supprimer"><Trash2 size={15} /></button>
          </>
        )} />
      {pf.description && <p className="-mt-3 mb-6 text-sm text-ink2">{pf.description}</p>}
      {sim && ["queued", "running"].includes(sim.status) && <div className="card flex items-center justify-center gap-3 py-20 text-sm text-muted"><Spinner /> Simulation en cours…</div>}
      {sim?.status === "failed" && <ErrorNote error={sim.error} />}
      {simId && (bt.isLoading ? <Loading /> : bt.data && <><Overview bt={bt.data} /><BacktestView bt={bt.data} hideSummary /></>)}
      {pf.history && pf.history.length > 1 && (
        <Card title="Simulations précédentes" className="mt-6" pad={false}>
          <div className="overflow-x-auto px-3 pb-3">
            <table className="table-base">
              <thead><tr><th>Date</th><th>Version</th><th className="text-right">Valeur finale</th><th className="text-right">TRI</th><th /></tr></thead>
              <tbody>{pf.history.map((h) => (
                <tr key={h.id}><td>{dateTime(h.created_at)}</td><td>v{h.strategy_version}</td><td className="num text-right">{eur(h.summary?.final_value)}</td><td className="num text-right">{pct(h.summary?.irr)}</td>
                  <td className="text-right"><Link to={`/backtests/${h.id}`} className="text-xs text-accent hover:underline">Détail</Link></td></tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
      )}
      <Modal open={edit} onClose={() => setEdit(false)} title="Modifier le portefeuille" wide>
        <Notice>Toute modification est tracée dans le journal d'audit et déclenche une nouvelle simulation. Les simulations précédentes restent consultables.</Notice>
        <div className="mt-5"><PortfolioForm initial={initial} onSubmit={(f) => patch.mutate(f)} pending={patch.isPending} error={patch.error} submitLabel="Enregistrer et resimuler" /></div>
      </Modal>
      <Modal open={confirmDel} onClose={() => setConfirmDel(false)} title="Supprimer ce portefeuille ?">
        <p className="text-sm text-ink2">Le portefeuille et ses simulations seront supprimés. La suppression est enregistrée dans le journal d'audit.</p>
        <ErrorNote error={del.error} />
        <div className="mt-5 flex justify-end gap-2"><button className="btn-ghost" onClick={() => setConfirmDel(false)}>Annuler</button><button className="btn-danger" onClick={() => del.mutate()}>Supprimer</button></div>
      </Modal>
    </>
  );
}
