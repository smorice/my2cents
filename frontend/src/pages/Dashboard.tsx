import { useQuery } from "@tanstack/react-query";
import { ArrowRight, FlaskConical, Play, Target } from "lucide-react";
import { Link } from "react-router-dom";
import { Sparkline } from "../components/charts";
import { Badge, Card, Empty, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dateTime, pct, ratio, spct, tone } from "../lib/format";
import { STATUS } from "../lib/labels";
import { useStrategies } from "../lib/queries";

interface Brief { id: string; name: string; status: string; strategy_name: string; portfolio_id: string | null; created_at: string; cagr: number | null; sharpe: number | null; max_drawdown: number | null; benchmark_cagr: number | null }
interface Dash {
  counts: { strategies: number; templates: number; backtests: number; portfolios: number };
  recent: Brief[];
  best: Brief[];
  markets: { symbol: string; name: string; last: number; day: number; month: number | null; ytd: number | null; year: number | null; spark: number[]; date: string }[];
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
