import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowRight, FlaskConical, GitCompareArrows, Play, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BacktestForm, defaultLaunch, type LaunchConfig } from "../components/BacktestForm";
import { DrawdownChart, EquityChart } from "../components/charts";
import { KindIcon } from "../components/KindIcon";
import { Badge, Card, Empty, ErrorNote, Field, Loading, Notice, PageHeader, Spinner, Stat } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { date, eur, pct, ratio, spct, tone } from "../lib/format";
import { ACTION, FREQ, METRIC_HELP } from "../lib/labels";
import { useBenchmarks, useInstruments, useStrategies, useUniverses } from "../lib/queries";
import type { BacktestFull, BacktestRow, Definition, Page, Trade } from "../lib/types";
import { Verdict } from "./Backtest";

interface Overrides {
  universe: Definition["universe"];
  benchmark: string;
  rebalance_frequency: string;
  transaction_cost_model: Definition["transaction_cost_model"];
}

const fromDefinition = (d: Definition): Overrides => ({
  universe: { preset: d.universe.preset, symbols: [...d.universe.symbols] },
  benchmark: d.benchmark,
  rebalance_frequency: d.rebalance_frequency,
  transaction_cost_model: { ...d.transaction_cost_model },
});

function UniverseEditor({ value, onChange, locked }: { value: Overrides["universe"]; onChange: (u: Overrides["universe"]) => void; locked: boolean }) {
  const universes = useUniverses();
  const instruments = useInstruments();
  const [add, setAdd] = useState("");
  const tradable = (instruments.data ?? []).filter((i) => i.kind !== "index");
  const preset = universes.data?.find((u) => u.key === value.preset);
  const count = (preset?.symbols.length ?? 0) + value.symbols.filter((s) => !preset?.symbols.includes(s)).length;
  if (locked) return <p className="text-xs text-muted">Défini par l'allocation de la stratégie : {value.symbols.join(", ")}.</p>;
  const push = () => {
    const s = add.trim().toUpperCase();
    if (s && !value.symbols.includes(s)) onChange({ ...value, symbols: [...value.symbols, s] });
    setAdd("");
  };
  return (
    <div className="space-y-2">
      <select className="input" value={value.preset ?? ""} onChange={(e) => onChange({ ...value, preset: e.target.value || null })} aria-label="Univers prédéfini">
        <option value="">Aucun univers prédéfini</option>
        {universes.data?.map((u) => <option key={u.key} value={u.key}>{u.label} · {u.symbols.length}</option>)}
      </select>
      <div className="flex gap-2">
        <input className="input" list="lab-instruments" value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Ajouter un symbole (ex. MC.PA)"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); push(); } }} aria-label="Ajouter un symbole" />
        <button type="button" className="btn-outline px-2.5" onClick={push} aria-label="Ajouter"><Plus size={15} /></button>
        <datalist id="lab-instruments">{tradable.map((i) => <option key={i.symbol} value={i.symbol}>{i.name}</option>)}</datalist>
      </div>
      {value.symbols.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.symbols.map((s) => (
            <span key={s} className="chip">{s}<button type="button" onClick={() => onChange({ ...value, symbols: value.symbols.filter((x) => x !== s) })} aria-label={`Retirer ${s}`}><X size={11} /></button></span>
          ))}
        </div>
      )}
      <p className="hint">{count} actif{count > 1 ? "s" : ""} dans l'univers.</p>
    </div>
  );
}

function LabConfig({ ov, setOv, locked }: { ov: Overrides; setOv: (o: Overrides) => void; locked: boolean }) {
  const benchmarks = useBenchmarks();
  const b = benchmarks.data?.find((x) => x.symbol === ov.benchmark);
  const c = ov.transaction_cost_model;
  return (
    <div className="space-y-5">
      <Field label="Univers d'actifs"><UniverseEditor value={ov.universe} onChange={(u) => setOv({ ...ov, universe: u })} locked={locked} /></Field>
      <Field label="Indice de référence" hint={b?.description}>
        <select className="input" value={ov.benchmark} onChange={(e) => setOv({ ...ov, benchmark: e.target.value })}>
          {!b && <option value={ov.benchmark}>{ov.benchmark}</option>}
          {benchmarks.data?.map((x) => <option key={x.symbol} value={x.symbol} disabled={!x.available}>{x.label}{x.total_return && !x.label.includes("réinvestis") ? " · dividendes réinvestis" : ""}</option>)}
        </select>
      </Field>
      <Field label="Fréquence de rééquilibrage">
        <select className="input" value={ov.rebalance_frequency} onChange={(e) => setOv({ ...ov, rebalance_frequency: e.target.value })}>
          {["daily", "weekly", "monthly", "quarterly", "yearly", "never"].map((f) => <option key={f} value={f}>{FREQ[f]}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Frais (%)"><input type="number" step={0.05} min={0} max={5} className="input num" value={c.fee_pct} onChange={(e) => setOv({ ...ov, transaction_cost_model: { ...c, fee_pct: Number(e.target.value) } })} /></Field>
        <Field label="Frais min (€)"><input type="number" step={0.5} min={0} max={100} className="input num" value={c.fee_min} onChange={(e) => setOv({ ...ov, transaction_cost_model: { ...c, fee_min: Number(e.target.value) } })} /></Field>
        <Field label="Slippage (pb)"><input type="number" step={1} min={0} max={200} className="input num" value={c.slippage_bps} onChange={(e) => setOv({ ...ov, transaction_cost_model: { ...c, slippage_bps: Number(e.target.value) } })} /></Field>
      </div>
    </div>
  );
}

function Progress({ bt }: { bt: BacktestRow }) {
  const p = bt.status === "queued" ? 0 : bt.progress ?? 0;
  const steps = ["Données de marché", "Simulation jour par jour", "Enregistrement"];
  const active = p < 0.15 ? 0 : p < 0.9 ? 1 : 2;
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <div className="relative mb-6 grid h-20 w-20 place-items-center">
        <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden="true">
          <circle cx="18" cy="18" r="16" fill="none" stroke="rgb(var(--line))" strokeWidth="2.5" />
          <circle cx="18" cy="18" r="16" fill="none" stroke="rgb(var(--accent))" strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={`${Math.max(p, 0.02) * 100.5} 100.5`} className="transition-[stroke-dasharray] duration-500" />
        </svg>
        <span className="num text-lg font-semibold">{Math.round(p * 100)}%</span>
      </div>
      <div className="font-medium" aria-live="polite">{bt.status === "queued" ? "En file d'attente…" : bt.progress_message ?? "Calcul en cours…"}</div>
      <ol className="mt-5 flex flex-wrap justify-center gap-2 text-xs">
        {steps.map((s, i) => (
          <li key={s} className={clsx("chip", i < active && "border-pos/30 text-pos", i === active && bt.status === "running" && "border-accent/50 text-ink")}>{i + 1}. {s}</li>
        ))}
      </ol>
      <p className="mt-5 max-w-sm text-xs text-muted">Le calcul tourne côté serveur : vous pouvez continuer à modifier la configuration ou quitter la page.</p>
    </div>
  );
}

function LabResult({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["backtest", id],
    queryFn: () => api<BacktestFull>(`/backtests/${id}`),
    refetchInterval: (q) => (q.state.data && ["queued", "running"].includes(q.state.data.status) ? 800 : false),
  });
  const trades = useQuery({
    queryKey: ["transactions", id, "", 1, "lab"],
    queryFn: () => api<Page<Trade>>(`/backtests/${id}/transactions`, { params: { page_size: 8 } }),
    enabled: q.data?.status === "done",
  });
  if (q.isLoading) return <div className="card"><Loading /></div>;
  if (q.error) return <ErrorNote error={q.error} />;
  const bt = q.data!;
  if (bt.status === "queued" || bt.status === "running") return <div className="card"><Progress bt={bt} /></div>;
  if (bt.status === "failed") return <div className="card card-pad"><ErrorNote error={bt.error ?? "Échec de la simulation"} /></div>;
  const r = bt.results!;
  const s = r.summary.strategy, b = r.summary.benchmark;
  const bench = r.names[bt.config.benchmark] ?? bt.config.benchmark;
  return (
    <div className="space-y-6 [animation:fadein_.35s_ease-out]">
      <div className="card p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="eyebrow">Résultat</div>
            <div className="truncate font-semibold">{bt.name}</div>
          </div>
          <Link to={`/backtests/${bt.id}`} className="btn-outline">Rapport complet <ArrowRight size={15} /></Link>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
          <Stat label="Valeur finale" value={eur(s.final_value)} sub={`versé ${eur(s.total_invested)}`} />
          <Stat label="Performance" value={spct(s.total_return)} valueClass={tone(s.total_return)} sub={`indice ${spct(b.total_return)}`} />
          <Stat label="CAGR" value={pct(s.cagr)} valueClass={tone(s.cagr)} sub={`indice ${pct(b.cagr)}`} help={METRIC_HELP.cagr} />
          <Stat label="Volatilité" value={pct(s.volatility)} sub={`indice ${pct(b.volatility)}`} help={METRIC_HELP.volatility} />
          <Stat label="Perte max." value={pct(s.max_drawdown)} sub={`indice ${pct(b.max_drawdown)}`} help={METRIC_HELP.max_drawdown} />
          <Stat label="Sharpe" value={ratio(s.sharpe)} sub={`indice ${ratio(b.sharpe)}`} help={METRIC_HELP.sharpe} />
        </div>
        <div className="mt-5 border-t border-line pt-5"><Verdict s={s} b={b} bench={bench} /></div>
      </div>
      {r.warnings.length > 0 && <Notice tone="warn"><ul className="space-y-1">{r.warnings.slice(0, 4).map((w, i) => <li key={i}>{w}</li>)}</ul></Notice>}
      <Card title="Portefeuille vs indice"><EquityChart s={r.series} benchName={bench} height={280} /></Card>
      <Card title="Drawdown"><DrawdownChart s={r.series} benchName={bench} height={160} /></Card>
      <Card title="Derniers ordres" subtitle={`${r.counts.trades} transactions au total`} pad={false}
        actions={<Link to={`/backtests/${bt.id}`} className="btn-ghost h-8 text-xs">Tout voir</Link>}>
        <div tabIndex={0} className="overflow-x-auto px-3 pb-3">
          <table className="table-base">
            <thead><tr><th>Date</th><th>Actif</th><th>Sens</th><th className="text-right">Montant</th></tr></thead>
            <tbody>
              {trades.data?.items.map((t) => (
                <tr key={t.seq}>
                  <td className="num whitespace-nowrap text-ink2">{date(t.date)}</td>
                  <td className="whitespace-nowrap">{r.names[t.symbol] ?? t.symbol}</td>
                  <td><Badge className={ACTION[t.side].cls}>{ACTION[t.side].label}</Badge></td>
                  <td className="num text-right">{eur(t.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

export function LabPage() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const strategies = useStrategies();
  const usable = useMemo(() => (strategies.data ?? []).filter((s) => s.status === "active" || s.status === "draft"), [strategies.data]);
  const sid = params.get("strategy") ?? usable[0]?.id;
  const strategy = usable.find((s) => s.id === sid) ?? strategies.data?.find((s) => s.id === sid);
  const [launch, setLaunch] = useState<LaunchConfig>(defaultLaunch);
  const [ov, setOv] = useState<Overrides | null>(null);
  const [runs, setRuns] = useState<{ id: string; label: string }[]>([]);
  const [current, setCurrent] = useState<string | null>(params.get("run"));

  useEffect(() => { if (strategy?.definition) setOv(fromDefinition(strategy.definition)); }, [strategy?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useMutation({
    mutationFn: () => api<BacktestRow>("/backtests", { method: "POST", body: { strategy_id: strategy!.id, ...launch, ...ov } }),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ["backtests"] });
      setRuns((r) => [{ id: b.id, label: `${strategy!.name} · ${launch.start.slice(0, 4)}–${launch.end.slice(0, 4)}` }, ...r].slice(0, 8));
      setCurrent(b.id);
      setParams((p) => { p.set("run", b.id); return p; }, { replace: true });
    },
  });

  if (strategies.isLoading) return <Loading />;
  const locked = strategy?.kind === "fixed_allocation";

  return (
    <>
      <PageHeader eyebrow={<Link to="/backtests" className="hover:text-ink">Backtests</Link>} title="Laboratoire de backtest"
        description="Configurez une simulation à gauche, observez le résultat à droite. Chaque lancement est conservé dans l'historique et reste reproductible." />
      <div className="grid gap-6 xl:grid-cols-[400px_minmax(0,1fr)]">
        <form className="card h-fit space-y-6 p-5 sm:p-6 xl:sticky xl:top-6" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
          <Field label="Stratégie">
            <select className="input" value={sid ?? ""} onChange={(e) => setParams({ strategy: e.target.value })}>
              {usable.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_template ? " (modèle)" : ""}</option>)}
            </select>
          </Field>
          {strategy && (
            <div className="flex items-start gap-3 rounded-xl border border-line bg-raised/60 p-3 text-xs text-ink2">
              <KindIcon kind={strategy.kind} size={16} />
              <div className="min-w-0">
                <div>{strategy.rules[0]}</div>
                <Link to={`/strategies/${strategy.id}`} className="mt-1 inline-block text-accent hover:underline">Voir la stratégie (v{strategy.current_version})</Link>
              </div>
            </div>
          )}
          <BacktestForm value={launch} onChange={setLaunch} compact />
          {ov && <div className="border-t border-line pt-5"><div className="eyebrow mb-4">Univers, indice et coûts</div><LabConfig ov={ov} setOv={setOv} locked={locked} /></div>}
          <ErrorNote error={run.error} />
          {can("backtest:run") ? (
            <button className="btn-primary h-11 w-full text-[15px]" disabled={!strategy || run.isPending}>
              {run.isPending ? <Spinner className="text-accent-ink" /> : <Play size={16} />} Lancer la simulation
            </button>
          ) : <p className="text-sm text-muted">Permission requise pour lancer des backtests.</p>}
          <p className="text-[11px] leading-relaxed text-muted">Les performances passées simulées ne préjugent pas des performances futures. Les hypothèses (frais, dividendes, fiscalité, biais) sont détaillées dans chaque rapport.</p>
        </form>

        <div className="min-w-0 space-y-4">
          {runs.length > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="eyebrow mr-1">Cette session</span>
              {runs.map((r) => (
                <button key={r.id} type="button" onClick={() => setCurrent(r.id)} className={clsx("chip", current === r.id && "border-accent/60 bg-accent/10 text-ink")}>{r.label}</button>
              ))}
              <Link to={`/compare?ids=${runs.map((r) => r.id).join(",")}`} className="btn-ghost h-7 text-xs"><GitCompareArrows size={13} /> Comparer</Link>
            </div>
          )}
          {current ? <LabResult key={current} id={current} /> : (
            <div className="card">
              <Empty icon={<FlaskConical size={28} />} title="Prêt à simuler">
                Choisissez une stratégie, une période et un capital, puis lancez la simulation. Le résultat s'affichera ici, avec la comparaison à l'indice choisi.
              </Empty>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
