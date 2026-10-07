import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, GitCompareArrows, Play, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BacktestForm, defaultLaunch, type LaunchConfig } from "../components/BacktestForm";
import { CompareChart } from "../components/charts";
import { Card, Empty, ErrorNote, Help, Loading, PageHeader, Segmented, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { num, pct, ratio, spct, tone } from "../lib/format";
import { METRIC_HELP } from "../lib/labels";
import { useBenchmarks, useNames, useStrategies } from "../lib/queries";
import type { BacktestRow, Metrics, Page } from "../lib/types";

interface CmpItem {
  id: string; name: string; strategy_id: string; strategy_name: string; strategy_version: number; config: BacktestRow["config"];
  summary: { strategy: Metrics; benchmark: Metrics };
  series: { dates: string[]; twr: number[]; benchmark_twr: number[]; drawdown: number[] };
}

type Col = { key: string; label: string; main?: boolean; get: (s: Metrics, b: Metrics) => number | null | undefined; fmt: (v?: number | null) => string; better: "high" | "low" | null; bench?: boolean; help?: string };

// Rows are strategies (as in a research desk); "better" drives the highlight of the best value per column.
// `main` columns answer "which one would have done best, and how bad did it get"; the rest is one click away.
const COLS: Col[] = [
  { key: "hundred", main: true, label: "100 € deviennent", get: (s) => (s.total_return == null ? null : 100 * (1 + s.total_return)), fmt: (v) => (v == null ? "—" : `${num(v, 0)} €`), better: "high", bench: true },
  { key: "cagr", main: true, label: "Gain par an", get: (s) => s.cagr, fmt: pct, better: "high", bench: true, help: METRIC_HELP.cagr },
  { key: "volatility", label: "Volatilité", get: (s) => s.volatility, fmt: pct, better: "low", bench: true, help: METRIC_HELP.volatility },
  { key: "max_drawdown", main: true, label: "Pire baisse", get: (s) => s.max_drawdown, fmt: pct, better: "high", bench: true, help: METRIC_HELP.max_drawdown },
  { key: "sharpe", label: "Sharpe", get: (s) => s.sharpe, fmt: ratio, better: "high", bench: true, help: METRIC_HELP.sharpe },
  { key: "sortino", label: "Sortino", get: (s) => s.sortino, fmt: ratio, better: "high", bench: true, help: METRIC_HELP.sortino },
  { key: "calmar", label: "Calmar", get: (s) => s.calmar, fmt: ratio, better: "high", bench: true, help: METRIC_HELP.calmar },
  { key: "vs", main: true, label: "vs indice", get: (s, b) => (s.cagr == null || b.cagr == null ? null : s.cagr - b.cagr), fmt: spct, better: "high", help: "Écart de CAGR annuel avec l'indice de référence du backtest." },
  { key: "alpha", label: "Alpha", get: (s) => s.alpha, fmt: spct, better: "high", help: METRIC_HELP.alpha },
  { key: "trades", label: "Ordres", get: (s) => s.trades, fmt: (v) => (v == null ? "—" : String(v)), better: null },
];

export function ComparePage() {
  const [params, setParams] = useSearchParams();
  const ids = (params.get("ids") ?? "").split(",").filter(Boolean);
  const { can } = useAuth();
  const qc = useQueryClient();
  const [metric, setMetric] = useState<"twr" | "drawdown">("twr");
  const [picked, setPicked] = useState<string[]>(() => (params.get("strategies") ?? "").split(",").filter(Boolean));
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "hundred", dir: -1 });
  const [allCols, setAllCols] = useState(false);
  const cols = allCols ? COLS : COLS.filter((c) => c.main);
  const names = useNames();
  const benchmarks = useBenchmarks();
  const [bench, setBench] = useState("");
  const [launch, setLaunch] = useState<LaunchConfig>(defaultLaunch);
  const strategies = useStrategies();
  const list = useQuery({ queryKey: ["backtests", "done-list"], queryFn: () => api<Page<BacktestRow>>("/backtests", { params: { status: "done", page_size: 100 } }) });
  const pending = useQuery({
    queryKey: ["compare-pending", ids],
    queryFn: () => Promise.all(ids.map((i) => api<BacktestRow>(`/backtests/${i}`))),
    enabled: ids.length > 0,
    refetchInterval: (q) => (q.state.data?.some((b) => b.status === "queued" || b.status === "running") ? 2000 : false),
  });
  const running = pending.data?.filter((b) => b.status === "queued" || b.status === "running").length ?? 0;
  const cmp = useQuery({
    queryKey: ["compare", ids, running],
    queryFn: () => api<CmpItem[]>("/backtests/compare", { params: { ids: ids.join(",") } }),
    enabled: ids.length > 0,
  });
  useEffect(() => { if (running === 0) qc.invalidateQueries({ queryKey: ["backtests", "done-list"] }); }, [running, qc]);

  const batch = useMutation({
    mutationFn: () => api<BacktestRow[]>("/backtests/batch", { method: "POST", body: { strategy_ids: picked, base: { strategy_id: picked[0], ...launch, benchmark: bench || null } } }),
    onSuccess: (rows) => setParams({ ids: rows.map((r) => r.id).join(",") }),
  });

  const setIds = (next: string[]) => setParams(next.length ? { ids: next.join(",") } : {});
  const items = cmp.data ?? [];
  const best = (c: Col) => {
    const vals = items.map((i) => c.get(i.summary.strategy, i.summary.benchmark)).filter((v): v is number => v != null);
    if (!vals.length || !c.better || items.length < 2) return null;
    return c.better === "high" ? Math.max(...vals) : Math.min(...vals);
  };
  const sorted = useMemo(() => {
    const c = COLS.find((x) => x.key === sort.key);
    if (!c) return items;
    return [...items].sort((a, b) => ((c.get(a.summary.strategy, a.summary.benchmark) ?? -Infinity) - (c.get(b.summary.strategy, b.summary.benchmark) ?? -Infinity)) * sort.dir);
  }, [items, sort]);
  const sameBench = items.every((i) => i.config.benchmark === items[0]?.config.benchmark);
  const benchName = items[0] ? names[items[0].config.benchmark] ?? items[0].config.benchmark : "";

  return (
    <>
      <PageHeader eyebrow="Comparer" title="Comparer des stratégies"
        description="Choisissez plusieurs stratégies : elles sont simulées sur la même période, avec le même argent et les mêmes frais. Vous voyez ensuite laquelle aurait le mieux réussi, et la pire baisse traversée." />

      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <Card title="Lancer une comparaison équitable" subtitle="Mêmes dates, même capital, mêmes versements, même fiscalité">
          {can("backtest:run") ? (
            <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); batch.mutate(); }}>
              <div>
                <span className="label">Stratégies (jusqu'à 8)</span>
                <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
                  {strategies.data?.filter((s) => s.status === "active").map((s) => (
                    <button type="button" key={s.id} onClick={() => setPicked((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : p.length < 8 ? [...p, s.id] : p))}
                      className={`chip ${picked.includes(s.id) ? "border-accent/60 bg-accent/10 text-ink" : "hover:text-ink"}`}>{s.name}</button>
                  ))}
                </div>
              </div>
              <label className="block">
                <span className="label">Indice de référence commun</span>
                <select className="input" value={bench} onChange={(e) => setBench(e.target.value)}>
                  <option value="">Celui de chaque stratégie</option>
                  {benchmarks.data?.filter((b) => b.available).map((b) => <option key={b.symbol} value={b.symbol}>{b.label}</option>)}
                </select>
              </label>
              <BacktestForm value={launch} onChange={setLaunch} />
              <ErrorNote error={batch.error} />
              <button className="btn-primary" disabled={picked.length < 2 || batch.isPending}><Play size={15} /> Lancer {picked.length} backtests</button>
            </form>
          ) : <p className="text-sm text-muted">Permission requise pour lancer des backtests.</p>}
        </Card>
        <Card title="Ou reprendre des résultats déjà calculés">
          <div className="max-h-[420px] space-y-1 overflow-y-auto">
            {list.data?.items.map((b) => (
              <label key={b.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-raised">
                <input type="checkbox" checked={ids.includes(b.id)} onChange={() => setIds(ids.includes(b.id) ? ids.filter((x) => x !== b.id) : [...ids, b.id].slice(0, 8))} />
                <span className="min-w-0 flex-1 truncate text-sm">{b.name}</span>
                <span className="num text-xs text-muted">{pct(b.summary?.strategy.cagr)}</span>
              </label>
            ))}
            {list.data?.items.length === 0 && <p className="text-sm text-muted">Aucun backtest terminé.</p>}
          </div>
        </Card>
      </div>

      {ids.length === 0 ? (
        <div className="card"><Empty icon={<GitCompareArrows size={28} />} title="Rien à comparer pour l'instant">Sélectionnez au moins un backtest ou lancez une comparaison.</Empty></div>
      ) : running > 0 ? (
        <div className="card flex items-center justify-center gap-3 py-16 text-sm text-muted"><Spinner /> {running} simulation(s) en cours…</div>
      ) : cmp.isLoading ? <Loading /> : (
        <div className="space-y-6">
          {items.some((a) => items.some((b) => a.config.start !== b.config.start || a.config.end !== b.config.end)) && (
            <p className="text-xs text-warn">Attention : les périodes diffèrent entre backtests, la comparaison n'est pas strictement équitable.</p>
          )}
          <Card title="100 € investis" subtitle="Valeur de 100 € placés au départ, hors effet des versements (rendement pondéré par le temps)"
            actions={<Segmented size="sm" value={metric} onChange={setMetric} options={[{ value: "twr", label: "Base 100" }, { value: "drawdown", label: "Drawdown" }]} />}>
            <CompareChart metric={metric} items={[
              ...items.map((i) => ({ id: i.id, label: `${i.strategy_name} v${i.strategy_version}`, dates: i.series.dates, values: metric === "twr" ? i.series.twr : i.series.drawdown })),
              ...(metric === "twr" && items[0] && sameBench ? [{ id: "bench", label: benchName, dates: items[0].series.dates, values: items[0].series.benchmark_twr, bench: true }] : []),
            ]} />
          </Card>
          <Card title="Classement" subtitle="Cliquez un en-tête pour trier. En couleur : la meilleure valeur de la colonne." pad={false}
            actions={<button type="button" className="btn-ghost h-9" aria-pressed={allCols} onClick={() => setAllCols(!allCols)}>{allCols ? "Indicateurs essentiels" : "Tous les indicateurs"}</button>}>
            <div tabIndex={0} className="overflow-x-auto px-3 pb-3">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Stratégie</th>
                    {cols.map((c) => (
                      <th key={c.key} className="text-right">
                        <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-ink" onClick={() => setSort((x) => ({ key: c.key, dir: x.key === c.key ? (-x.dir as 1 | -1) : -1 }))}
                          aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                          {c.label}{sort.key === c.key && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                        </button>
                        {c.help && <span className="ml-1 normal-case"><Help text={c.help} /></span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((i) => (
                    <tr key={i.id}>
                      <td className="min-w-[200px]">
                        <div className="flex items-center gap-2">
                          <Link to={`/backtests/${i.id}`} className="font-medium hover:text-accent">{i.strategy_name}</Link>
                          <button onClick={() => setIds(ids.filter((x) => x !== i.id))} aria-label={`Retirer ${i.strategy_name}`} className="text-muted hover:text-ink"><X size={12} /></button>
                        </div>
                        {can("portfolio:write") && (
                          <Link to={`/accounts?follow=${i.strategy_id}`} className="text-xs text-accent hover:underline">Suivre sur un compte réel →</Link>
                        )}
                        <div className="num text-xs text-muted">v{i.strategy_version} · {i.config.start.slice(0, 4)}–{i.config.end.slice(0, 4)}</div>
                      </td>
                      {cols.map((c) => {
                        const v = c.get(i.summary.strategy, i.summary.benchmark);
                        const top = best(c);
                        return <td key={c.key} className={`num text-right ${top != null && v === top ? "font-semibold text-accent" : c.key === "vs" ? tone(v) : ""}`}>{c.fmt(v)}</td>;
                      })}
                    </tr>
                  ))}
                  {items[0] && sameBench && (
                    <tr className="bg-raised/50">
                      <td><div className="font-medium text-ink2">{benchName}</div><div className="text-xs text-muted">Indice de référence, mêmes versements</div></td>
                      {cols.map((c) => <td key={c.key} className="num text-right text-muted">{c.bench ? c.fmt(c.get(items[0].summary.benchmark, items[0].summary.benchmark)) : "—"}</td>)}
                    </tr>
                  )}
                </tbody>
              </table>
              {!sameBench && <p className="px-3 pt-3 text-xs text-warn">Les backtests n'utilisent pas tous le même indice : la colonne « vs indice » compare chacun au sien.</p>}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
