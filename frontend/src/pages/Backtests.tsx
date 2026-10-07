import { useQuery } from "@tanstack/react-query";
import { BarChart3, FlaskConical, GitCompareArrows } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DataTable, type Column } from "../components/DataTable";
import { Badge, Empty, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { dateTime, eur, pct, ratio, spct, tone } from "../lib/format";
import { FREQ, STATUS } from "../lib/labels";
import type { BacktestRow, Page } from "../lib/types";

const vsIndex = (b: BacktestRow) => {
  const s = b.summary?.strategy, bm = b.summary?.benchmark;
  return s?.cagr != null && bm?.cagr != null ? s.cagr - bm.cagr : null;
};

export function BacktestsPage() {
  const nav = useNavigate();
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [strategy, setStrategy] = useState("");
  const q = useQuery({
    queryKey: ["backtests", "all"],
    queryFn: () => api<Page<BacktestRow>>("/backtests", { params: { page_size: 500 } }),
    refetchInterval: (q) => (q.state.data?.items.some((b) => b.status === "queued" || b.status === "running") ? 2500 : false),
  });
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 8 ? s : [...s, id]));
  const rows = useMemo(() => (q.data?.items ?? []).filter((b) => (!status || b.status === status) && (!strategy || b.strategy_name === strategy)), [q.data, status, strategy]);
  const strategies = useMemo(() => [...new Set((q.data?.items ?? []).map((b) => b.strategy_name ?? ""))].sort(), [q.data]);

  const columns: Column<BacktestRow>[] = [
    {
      key: "sel", label: "", sticky: true, className: "w-8",
      render: (b) => <input type="checkbox" disabled={b.status !== "done"} checked={selected.includes(b.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(b.id)} aria-label={`Sélectionner ${b.name} pour comparer`} />,
    },
    {
      key: "name", label: "Backtest", sticky: true, className: "min-w-[220px]", value: (b) => b.name,
      render: (b) => (
        <>
          <Link to={`/backtests/${b.id}`} className="font-medium hover:text-accent" onClick={(e) => e.stopPropagation()}>{b.name}</Link>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">{b.strategy_name} v{b.strategy_version} · {dateTime(b.created_at)}
            {b.status !== "done" && <Badge className={STATUS[b.status].cls}>{STATUS[b.status].label}{b.status === "running" && b.progress != null ? ` ${Math.round(b.progress * 100)} %` : ""}</Badge>}</div>
        </>
      ),
    },
    { key: "created", label: "Lancé le", hidden: true, value: (b) => b.created_at, render: (b) => <span className="num whitespace-nowrap text-xs text-ink2">{dateTime(b.created_at)}</span> },
    { key: "period", label: "Période", value: (b) => b.config.start, render: (b) => <span className="num whitespace-nowrap text-ink2">{b.config.start.slice(0, 7)} → {b.config.end.slice(0, 7)}</span> },
    {
      key: "config", label: "Configuration", value: (b) => `${FREQ[b.config.rebalance]}${b.config.contributions.frequency !== "none" ? ` DCA ${b.config.contributions.amount}` : ""}`,
      render: (b) => <span className="whitespace-nowrap text-xs text-ink2">{FREQ[b.config.rebalance]}{b.config.contributions.frequency !== "none" && ` · DCA ${eur(b.config.contributions.amount)}`}{b.config.tax_mode === "pfu" && " · CTO"}</span>,
    },
    { key: "bench", label: "Indice", hidden: true, value: (b) => b.config.benchmark, render: (b) => <span className="text-xs text-ink2">{b.config.benchmark}</span> },
    { key: "final", label: "Valeur finale", align: "right", value: (b) => b.summary?.strategy.final_value, render: (b) => eur(b.summary?.strategy.final_value) },
    { key: "total", label: "Perf. totale", align: "right", hidden: true, value: (b) => b.summary?.strategy.total_return, render: (b) => <span className={tone(b.summary?.strategy.total_return)}>{spct(b.summary?.strategy.total_return)}</span> },
    { key: "cagr", label: "CAGR", align: "right", value: (b) => b.summary?.strategy.cagr, render: (b) => <span className={tone(b.summary?.strategy.cagr)}>{pct(b.summary?.strategy.cagr)}</span> },
    { key: "vs", label: "vs indice", align: "right", value: vsIndex, render: (b) => <span className={tone(vsIndex(b))}>{spct(vsIndex(b))}</span> },
    { key: "vol", label: "Volatilité", align: "right", hidden: true, value: (b) => b.summary?.strategy.volatility, render: (b) => pct(b.summary?.strategy.volatility) },
    { key: "mdd", label: "Perte max.", align: "right", value: (b) => b.summary?.strategy.max_drawdown, render: (b) => <span className="text-ink2">{pct(b.summary?.strategy.max_drawdown)}</span> },
    { key: "sharpe", label: "Sharpe", align: "right", value: (b) => b.summary?.strategy.sharpe, render: (b) => ratio(b.summary?.strategy.sharpe) },
    { key: "sortino", label: "Sortino", align: "right", hidden: true, value: (b) => b.summary?.strategy.sortino, render: (b) => ratio(b.summary?.strategy.sortino) },
    { key: "trades", label: "Ordres", align: "right", hidden: true, value: (b) => b.summary?.strategy.trades, render: (b) => b.summary?.strategy.trades ?? "—" },
    { key: "fees", label: "Frais", align: "right", hidden: true, value: (b) => b.summary?.strategy.fees, render: (b) => eur(b.summary?.strategy.fees) },
  ];

  if (q.isLoading) return <Loading />;
  return (
    <>
      <PageHeader eyebrow="Backtests" title="Historique des simulations"
        description="Chaque backtest fige la version de stratégie et la configuration utilisées : il reste reproductible et comparable."
        actions={<>
          <button className="btn-outline" disabled={selected.length < 1} onClick={() => nav(`/compare?ids=${selected.join(",")}`)}><GitCompareArrows size={15} /> Comparer ({selected.length})</button>
          <Link to="/backtests/new" className="btn-primary"><FlaskConical size={15} /> Nouveau backtest</Link>
        </>} />
      <div className="card pt-3">
        {q.data!.items.length === 0 ? (
          <Empty icon={<BarChart3 size={28} />} title="Aucun backtest" action={<Link to="/backtests/new" className="btn-primary">Ouvrir le laboratoire</Link>}>Lancez votre première simulation depuis le laboratoire.</Empty>
        ) : (
          <DataTable rows={rows} columns={columns} rowKey={(b) => b.id} storageKey="backtests" csvName="my2cents-backtests"
            search={(b) => `${b.name} ${b.strategy_name} ${b.config.benchmark}`} defaultSort={{ key: "created", dir: -1 }}
            onRowClick={(b) => nav(`/backtests/${b.id}`)}
            filters={<>
              <select className="input w-auto" value={strategy} onChange={(e) => setStrategy(e.target.value)} aria-label="Filtrer par stratégie">
                <option value="">Toutes les stratégies</option>
                {strategies.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filtrer par statut">
                <option value="">Tous les statuts</option>
                {["done", "running", "queued", "failed"].map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
              </select>
            </>} />
        )}
      </div>
    </>
  );
}
