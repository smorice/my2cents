import { useQuery } from "@tanstack/react-query";
import { BarChart3, GitCompareArrows } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge, Empty, Loading, PageHeader, Pagination } from "../components/ui";
import { api } from "../lib/api";
import { dateTime, eur, pct, ratio, spct, tone } from "../lib/format";
import { FREQ, STATUS } from "../lib/labels";
import type { BacktestRow, Page } from "../lib/types";

export function BacktestsPage() {
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const q = useQuery({
    queryKey: ["backtests", { page }],
    queryFn: () => api<Page<BacktestRow>>("/backtests", { params: { page, page_size: 25 } }),
    refetchInterval: (q) => (q.state.data?.items.some((b) => b.status === "queued" || b.status === "running") ? 2500 : false),
  });
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 8 ? s : [...s, id]));
  if (q.isLoading) return <Loading />;
  const d = q.data!;
  return (
    <>
      <PageHeader eyebrow="Backtests" title="Historique des simulations"
        description="Chaque backtest fige la version de stratégie et la configuration utilisées : il reste reproductible et comparable."
        actions={<button className="btn-primary" disabled={selected.length < 1} onClick={() => nav(`/compare?ids=${selected.join(",")}`)}><GitCompareArrows size={15} /> Comparer ({selected.length})</button>} />
      <div className="card">
        {d.items.length === 0 ? (
          <Empty icon={<BarChart3 size={28} />} title="Aucun backtest" action={<Link to="/strategies" className="btn-outline">Choisir une stratégie</Link>}>Lancez une simulation depuis la page d'une stratégie.</Empty>
        ) : (
          <div className="overflow-x-auto p-2">
            <table className="table-base">
              <thead><tr><th className="w-8" /><th>Backtest</th><th>Période</th><th>Config</th><th className="text-right">Valeur finale</th><th className="text-right">CAGR</th><th className="text-right">vs indice</th><th className="text-right">Max DD</th><th className="text-right">Sharpe</th></tr></thead>
              <tbody>
                {d.items.map((b) => {
                  const s = b.summary?.strategy, bm = b.summary?.benchmark;
                  const diff = s?.cagr != null && bm?.cagr != null ? s.cagr - bm.cagr : null;
                  return (
                    <tr key={b.id} className="hover:bg-raised/50">
                      <td><input type="checkbox" className="accent-[rgb(var(--accent))]" disabled={b.status !== "done"} checked={selected.includes(b.id)} onChange={() => toggle(b.id)} aria-label="Sélectionner pour comparer" /></td>
                      <td className="min-w-[220px]">
                        <Link to={`/backtests/${b.id}`} className="font-medium hover:text-accent">{b.name}</Link>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">{b.strategy_name} v{b.strategy_version} · {dateTime(b.created_at)}{b.status !== "done" && <Badge className={STATUS[b.status].cls}>{STATUS[b.status].label}</Badge>}</div>
                      </td>
                      <td className="num whitespace-nowrap text-ink2">{b.config.start.slice(0, 7)} → {b.config.end.slice(0, 7)}</td>
                      <td className="whitespace-nowrap text-xs text-ink2">{FREQ[b.config.rebalance]}{b.config.contributions.frequency !== "none" && ` · DCA ${eur(b.config.contributions.amount)}`}{b.config.tax_mode === "pfu" && " · CTO"}</td>
                      <td className="num text-right">{eur(s?.final_value)}</td>
                      <td className={`num text-right ${tone(s?.cagr)}`}>{pct(s?.cagr)}</td>
                      <td className={`num text-right ${tone(diff)}`}>{spct(diff)}</td>
                      <td className="num text-right text-ink2">{pct(s?.max_drawdown)}</td>
                      <td className="num text-right">{ratio(s?.sharpe)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} />
          </div>
        )}
      </div>
    </>
  );
}
