import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowRight, FlaskConical, Play, Target } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PerformanceChart, Sparkline } from "../components/charts";
import { Badge, Card, Empty, Help, Loading, PageHeader, Segmented, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dateTime, pct, ratio, spct, tone } from "../lib/format";
import { METRIC_HELP, STATUS } from "../lib/labels";
import type { Metrics } from "../lib/types";
import { useStrategies } from "../lib/queries";

interface Brief { id: string; name: string; status: string; strategy_name: string; portfolio_id: string | null; created_at: string; cagr: number | null; sharpe: number | null; max_drawdown: number | null; benchmark_cagr: number | null }
interface Dash {
  counts: { strategies: number; templates: number; backtests: number; portfolios: number };
  recent: Brief[];
  best: Brief[];
  markets: { symbol: string; name: string; last: number; day: number; month: number | null; ytd: number | null; year: number | null; spark: number[]; date: string }[];
}

const PERIODS = ["1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y", "MAX"] as const;
type Period = (typeof PERIODS)[number];

interface PerfItem {
  id: string; name: string; strategy_name: string; strategy_id: string; benchmark: string; benchmark_name: string;
  dates: string[]; values: (number | null)[]; benchmark_values: (number | null)[]; metrics: Metrics; benchmark_metrics: Metrics;
  start: string; end: string; win_rate?: number | null; closed_trades?: number;
}
interface Perf { period: Period; start: string; end: string; items: PerfItem[]; focus: string | null }

function Kpi({ label, value, sub, tone: t, help }: { label: string; value: string; sub?: string; tone?: string; help?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-raised/40 px-3.5 py-3">
      <div className="flex items-center gap-1 truncate text-[11px] text-muted">{label}{help && <Help text={help} />}</div>
      <div className={clsx("num mt-1 text-lg font-semibold tracking-tight", t)}>{value}</div>
      {sub && <div className="num truncate text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function StrategiesPerformance() {
  const [period, setPeriod] = useState<Period>("5Y");
  const [focus, setFocus] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["dashboard-perf", period, focus],
    queryFn: () => api<Perf>("/dashboard/performance", { params: { period, focus } }),
    placeholderData: (p) => p,
  });
  if (q.isLoading) return <div className="card mb-6"><Loading /></div>;
  const d = q.data;
  if (!d || d.items.length === 0) {
    return (
      <div className="card mb-6">
        <Empty icon={<FlaskConical size={28} />} title="Comment vos stratégies auraient-elles performé ?"
          action={<Link to="/backtests/new" className="btn-primary"><Play size={15} /> Lancer ma première simulation</Link>}>
          Lancez un premier backtest : sa courbe face à l'indice et ses indicateurs clés apparaîtront ici.
        </Empty>
      </div>
    );
  }
  const f = d.items.find((i) => i.id === d.focus) ?? d.items[0];
  const s = f.metrics, b = f.benchmark_metrics;
  const series = [
    ...d.items.map((i) => ({ id: i.id, label: i.strategy_name, dates: i.dates, values: i.values })),
    { id: "bench", label: f.benchmark_name, dates: f.dates, values: f.benchmark_values, bench: true },
  ];
  return (
    <section className="card mb-6 p-5 sm:p-6" aria-labelledby="perf-title">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="perf-title" className="text-lg font-semibold tracking-tight">Comment mes stratégies auraient-elles performé ?</h2>
          <p className="mt-0.5 text-xs text-muted">Dernier backtest de chaque stratégie, base 100 au {new Date(d.start + "T12:00:00").toLocaleDateString("fr-FR")} · simulation sur données historiques</p>
        </div>
        <div className="flex items-center gap-2">
          {q.isFetching && <Spinner />}
          <div className="max-w-full overflow-x-auto"><Segmented size="sm" value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p, label: p === "MAX" ? "Max" : p }))} /></div>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Indicateurs de</span>
        <select className="input h-8 w-auto py-0 text-sm" value={f.id} onChange={(e) => setFocus(e.target.value)} aria-label="Stratégie détaillée">
          {d.items.map((i) => <option key={i.id} value={i.id}>{i.strategy_name}</option>)}
        </select>
        <span className="text-muted">vs {f.benchmark_name}</span>
        <Link to={`/backtests/${f.id}`} className="ml-auto text-xs text-accent hover:underline">Rapport complet</Link>
      </div>
      <div className="mb-6 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi label="Performance totale" value={spct(s.total_return)} tone={tone(s.total_return)} sub={`indice ${spct(b.total_return)}`} />
        <Kpi label="Annualisée (CAGR)" value={pct(s.cagr)} tone={tone(s.cagr)} sub={`indice ${pct(b.cagr)}`} help={METRIC_HELP.cagr} />
        <Kpi label="Écart vs indice" value={s.cagr != null && b.cagr != null ? spct(s.cagr - b.cagr) : "—"} tone={tone(s.cagr != null && b.cagr != null ? s.cagr - b.cagr : null)} sub="par an" />
        <Kpi label="Alpha" value={spct(s.alpha)} tone={tone(s.alpha)} sub={`bêta ${ratio(s.beta)}`} help={METRIC_HELP.alpha} />
        <Kpi label="Volatilité" value={pct(s.volatility)} sub={`indice ${pct(b.volatility)}`} help={METRIC_HELP.volatility} />
        <Kpi label="Sharpe" value={ratio(s.sharpe)} sub={`indice ${ratio(b.sharpe)}`} help={METRIC_HELP.sharpe} />
        <Kpi label="Sortino" value={ratio(s.sortino)} sub={`indice ${ratio(b.sortino)}`} help={METRIC_HELP.sortino} />
        <Kpi label="Perte maximale" value={pct(s.max_drawdown)} sub={`indice ${pct(b.max_drawdown)}`} help={METRIC_HELP.max_drawdown} />
        <Kpi label="Calmar" value={ratio(s.calmar)} sub={`indice ${ratio(b.calmar)}`} help={METRIC_HELP.calmar} />
        <Kpi label="Ventes gagnantes" value={f.closed_trades ? pct(f.win_rate) : "—"} sub={f.closed_trades ? `${f.closed_trades} ventes, tout l'historique` : "aucune vente"}
          help="Part des ventes réalisées avec une plus-value, sur toute la durée du backtest. Non pertinent pour une stratégie qui ne vend jamais." />
      </div>
      <PerformanceChart series={series} focus={f.id} />
    </section>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => api<Dash>("/dashboard"), refetchInterval: (q) => (q.state.data?.recent.some((r) => r.status === "running" || r.status === "queued") ? 3000 : false) });
  const strategies = useStrategies();
  const featured = strategies.data?.find((s) => s.is_template && s.kind === "benchmark_outperformance");
  const hour = new Date().getHours();
  if (q.isLoading) return <Loading />;
  const d = q.data!;
  return (
    <>
      <PageHeader eyebrow={new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}
        title={`${hour < 18 ? "Bonjour" : "Bonsoir"}, ${user?.display_name}`}
        description="Votre laboratoire de stratégies : explorez, testez sur l'historique, comparez à l'indice — avant toute décision réelle."
        actions={<Link to="/strategies" className="btn-primary"><FlaskConical size={16} /> Explorer les stratégies</Link>} />

      <StrategiesPerformance />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {d.markets.map((m) => (
          <div key={m.symbol} className="card px-4 py-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-xs text-muted">{m.name}</div>
                <div className="num mt-1 text-lg font-semibold tracking-tight">{m.last.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}</div>
              </div>
              <Sparkline values={m.spark} width={72} height={30} />
            </div>
            <div className="num mt-2 flex gap-3 text-xs">
              <span className={tone(m.day)}>{spct(m.day)} <span className="text-muted">jour</span></span>
              <span className={tone(m.ytd)}>{spct(m.ytd)} <span className="text-muted">YTD</span></span>
            </div>
          </div>
        ))}
        {d.markets.length === 0 && <div className="card col-span-full px-4 py-4 text-sm text-muted">Données de marché en cours de chargement (premier démarrage)…</div>}
      </div>

      {featured && (
        <div className="card mb-6 overflow-hidden">
          <div className="grid gap-6 p-6 md:grid-cols-[1fr_auto] md:items-center">
            <div className="flex gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent"><Target size={20} /></div>
              <div>
                <div className="eyebrow">Cas d'usage phare</div>
                <h3 className="mt-1 text-lg font-semibold tracking-tight">Battre le CAC 40 : acheter ce qui le surperforme</h3>
                <p className="mt-1 max-w-2xl text-sm text-ink2">« Acheter une action si sa performance sur les N derniers jours dépasse celle du CAC 40 de X %. » Réglez N et X, puis testez sur 5, 10 ou 20 ans.</p>
              </div>
            </div>
            <Link to={`/strategies/${featured.id}`} className="btn-primary"><Play size={15} /> Tester la règle</Link>
          </div>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card title="Derniers backtests" actions={<Link to="/backtests" className="btn-ghost h-8 text-xs">Tout voir <ArrowRight size={14} /></Link>} pad={false}>
          {d.recent.length === 0 ? (
            <Empty title="Aucun backtest pour l'instant" action={<Link to="/strategies" className="btn-outline">Choisir une stratégie</Link>}>Lancez votre premier test depuis une stratégie modèle.</Empty>
          ) : (
            <div className="overflow-x-auto px-2 pb-3">
              <table className="table-base">
                <thead><tr><th>Backtest</th><th className="text-right">CAGR</th><th className="text-right">vs indice</th><th className="text-right">Max DD</th><th className="text-right">Sharpe</th></tr></thead>
                <tbody>
                  {d.recent.map((b) => (
                    <tr key={b.id} className="hover:bg-raised/50">
                      <td>
                        <Link to={b.portfolio_id ? `/portfolios/${b.portfolio_id}` : `/backtests/${b.id}`} className="font-medium hover:text-accent">{b.name}</Link>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">{dateTime(b.created_at)} {b.status !== "done" && <Badge className={STATUS[b.status]?.cls}>{STATUS[b.status]?.label}</Badge>}</div>
                      </td>
                      <td className={`num text-right ${tone(b.cagr)}`}>{pct(b.cagr)}</td>
                      <td className={`num text-right ${tone(b.cagr != null && b.benchmark_cagr != null ? b.cagr - b.benchmark_cagr : null)}`}>
                        {b.cagr != null && b.benchmark_cagr != null ? spct(b.cagr - b.benchmark_cagr) : "—"}
                      </td>
                      <td className="num text-right text-ink2">{pct(b.max_drawdown)}</td>
                      <td className="num text-right">{ratio(b.sharpe)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="space-y-6">
          <Card title="Meilleurs ratios de Sharpe" subtitle="Parmi vos backtests terminés">
            {d.best.length === 0 ? <p className="text-sm text-muted">Les meilleures stratégies apparaîtront ici.</p> : (
              <ol className="space-y-3">
                {d.best.map((b, i) => (
                  <li key={b.id} className="flex items-center gap-3">
                    <span className="num w-5 text-xs text-muted">{i + 1}</span>
                    <Link to={`/backtests/${b.id}`} className="min-w-0 flex-1 truncate text-sm font-medium hover:text-accent">{b.name}</Link>
                    <span className="num text-sm">{ratio(b.sharpe)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
          <Card title="Votre espace">
            <div className="grid grid-cols-2 gap-4 text-sm">
              {[
                ["Stratégies perso", d.counts.strategies, "/strategies"],
                ["Modèles", d.counts.templates, "/strategies"],
                ["Backtests", d.counts.backtests, "/backtests"],
                ["Portefeuilles", d.counts.portfolios, "/portfolios"],
              ].map(([l, v, to]) => (
                <Link key={l as string} to={to as string} className="rounded-xl border border-line px-4 py-3 hover:bg-raised">
                  <div className="num text-xl font-semibold">{v}</div>
                  <div className="text-xs text-muted">{l}</div>
                </Link>
              ))}
            </div>
          </Card>
        </div>
      </div>
      <p className="mt-10 text-center text-xs text-muted">My2cents est un outil de recherche et de simulation. Aucun résultat ne constitue une garantie de performance future ni un conseil en investissement.</p>
    </>
  );
}
