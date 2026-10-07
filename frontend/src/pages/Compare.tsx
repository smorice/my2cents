import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitCompareArrows, Play, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BacktestForm, defaultLaunch, type LaunchConfig } from "../components/BacktestForm";
import { CompareChart } from "../components/charts";
import { Card, Empty, ErrorNote, Help, Loading, PageHeader, Segmented, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { pct, ratio, spct } from "../lib/format";
import { METRIC_HELP } from "../lib/labels";
import { useStrategies } from "../lib/queries";
import type { BacktestRow, Metrics, Page } from "../lib/types";

interface CmpItem {
  id: string; name: string; strategy_name: string; strategy_version: number; config: BacktestRow["config"];
  summary: { strategy: Metrics; benchmark: Metrics };
  series: { dates: string[]; twr: number[]; benchmark_twr: number[]; drawdown: number[] };
}

const METRICS: [keyof Metrics, string, (v?: number | null) => string, boolean][] = [
  ["cagr", "CAGR", pct, true], ["total_return", "Performance totale", spct, true], ["volatility", "Volatilité", pct, false],
  ["sharpe", "Sharpe", ratio, true], ["sortino", "Sortino", ratio, true], ["max_drawdown", "Perte max.", pct, true],
  ["calmar", "Calmar", ratio, true], ["beta", "Bêta", ratio, false], ["alpha", "Alpha", spct, true],
  ["avg_exposure", "Exposition moyenne", pct, false], ["trades", "Transactions", (v) => String(v ?? "—"), false],
];

export function ComparePage() {
  const [params, setParams] = useSearchParams();
  const ids = (params.get("ids") ?? "").split(",").filter(Boolean);
  const { can } = useAuth();
  const qc = useQueryClient();
  const [metric, setMetric] = useState<"twr" | "drawdown">("twr");
  const [picked, setPicked] = useState<string[]>([]);
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
    mutationFn: () => api<BacktestRow[]>("/backtests/batch", { method: "POST", body: { strategy_ids: picked, base: { strategy_id: picked[0], ...launch } } }),
    onSuccess: (rows) => setParams({ ids: rows.map((r) => r.id).join(",") }),
  });

  const setIds = (next: string[]) => setParams(next.length ? { ids: next.join(",") } : {});
  const items = cmp.data ?? [];
  const best = (k: keyof Metrics, higher: boolean) => {
    const vals = items.map((i) => i.summary.strategy[k] as number | null).filter((v): v is number => v != null);
    if (!vals.length) return null;
    return k === "max_drawdown" ? Math.max(...vals) : higher ? Math.max(...vals) : null;
  };

  return (
    <>
      <PageHeader eyebrow="Comparer" title="Comparer des stratégies"
        description="Superposez des backtests sur une même base 100, ou lancez plusieurs stratégies avec exactement la même configuration pour une comparaison équitable." />

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
              <BacktestForm value={launch} onChange={setLaunch} />
              <ErrorNote error={batch.error} />
              <button className="btn-primary" disabled={picked.length < 2 || batch.isPending}><Play size={15} /> Lancer {picked.length} backtests</button>
            </form>
          ) : <p className="text-sm text-muted">Permission requise pour lancer des backtests.</p>}
        </Card>
        <Card title="Ou choisir des backtests existants">
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
          <Card title="Performance cumulée" actions={<Segmented size="sm" value={metric} onChange={setMetric} options={[{ value: "twr", label: "Base 100" }, { value: "drawdown", label: "Drawdown" }]} />}>
            <CompareChart metric={metric} items={[
              ...items.map((i) => ({ id: i.id, label: `${i.strategy_name} v${i.strategy_version}`, dates: i.series.dates, values: metric === "twr" ? i.series.twr : i.series.drawdown })),
              ...(metric === "twr" && items[0] ? [{ id: "bench", label: `Indice (${items[0].config.benchmark})`, dates: items[0].series.dates, values: items[0].series.benchmark_twr }] : []),
            ]} />
          </Card>
          <Card title="Indicateurs" pad={false}>
            <div className="overflow-x-auto px-3 pb-3">
              <table className="table-base">
                <thead>
                  <tr><th>Indicateur</th>{items.map((i) => (
                    <th key={i.id} className="text-right normal-case tracking-normal">
                      <span className="inline-flex items-center gap-1"><Link to={`/backtests/${i.id}`} className="text-ink hover:text-accent">{i.strategy_name}</Link>
                        <button onClick={() => setIds(ids.filter((x) => x !== i.id))} aria-label="Retirer"><X size={12} /></button></span>
                    </th>
                  ))}<th className="text-right">Indice</th></tr>
                </thead>
                <tbody>
                  {METRICS.map(([k, l, f, higher]) => {
                    const top = best(k, higher);
                    return (
                      <tr key={k}>
                        <td className="text-ink2"><span className="inline-flex items-center gap-1">{l}{METRIC_HELP[k] && <Help text={METRIC_HELP[k]} />}</span></td>
                        {items.map((i) => {
                          const v = i.summary.strategy[k] as number | null;
                          return <td key={i.id} className={`num text-right ${top != null && v === top && items.length > 1 ? "font-semibold text-accent" : ""}`}>{f(v)}</td>;
                        })}
                        <td className="num text-right text-muted">{["beta", "alpha", "trades", "avg_exposure"].includes(k) ? "—" : f(items[0]?.summary.benchmark[k] as number)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="px-3 pt-3 text-xs text-muted">En violet : la meilleure valeur de la ligne.</p>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
