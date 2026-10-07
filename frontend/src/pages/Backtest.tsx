import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Download, GitCompareArrows, RotateCcw, Trash2 } from "lucide-react";
import { Fragment, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AllocationChart, DrawdownChart, EquityChart, MonthlyHeatmap, YearlyBars } from "../components/charts";
import { Badge, Card, ErrorNote, Help, Loading, Notice, PageHeader, Pagination, Spinner, Stat, Tabs, toast } from "../components/ui";
import { api, exportUrl } from "../lib/api";
import { useAuth } from "../lib/auth";
import { date, dateTime, days, eur, num, pct, ratio, spct, tone } from "../lib/format";
import { ACTION, FREQ, METRIC_HELP, STATUS } from "../lib/labels";
import type { BacktestFull, Decision, Metrics, Page, Results, Trade } from "../lib/types";

type Tab = "perf" | "alloc" | "decisions" | "trades" | "contrib" | "assumptions";

function Verdict({ s, b, bench }: { s: Metrics; b: Metrics; bench: string }) {
  const diff = (s.cagr ?? 0) - (b.cagr ?? 0);
  const ddBetter = (s.max_drawdown ?? 0) > (b.max_drawdown ?? 0);
  return (
    <p className="text-[15px] leading-relaxed text-ink2">
      Sur {num(s.years, 1)} ans, la stratégie a progressé de <b className={tone(s.cagr)}>{pct(s.cagr)}</b> par an, contre{" "}
      <b className="text-ink">{pct(b.cagr)}</b> pour {bench} : un écart de <b className={tone(diff)}>{spct(diff)}</b> par an.
      Sa pire baisse a été de <b className="text-ink">{pct(s.max_drawdown)}</b>{" "}
      ({ddBetter ? "moins sévère" : "plus sévère"} que les {pct(b.max_drawdown)} de l'indice), pour une volatilité de {pct(s.volatility)}.
      {s.fees ? <> Frais, slippage et impôts ont coûté <b className="text-ink">{eur((s.fees ?? 0) + (s.slippage ?? 0) + (s.taxes ?? 0))}</b>.</> : null}
    </p>
  );
}

const ROWS: [keyof Metrics, string, (v?: number | null) => string][] = [
  ["total_return", "Performance totale (TWR)", spct], ["cagr", "CAGR", pct], ["irr", "TRI (pondéré par l'argent)", pct],
  ["volatility", "Volatilité annualisée", pct], ["sharpe", "Ratio de Sharpe", ratio], ["sortino", "Ratio de Sortino", ratio],
  ["max_drawdown", "Perte maximale", pct], ["max_drawdown_days", "Plus longue période sous un sommet", (v) => days(v)],
  ["calmar", "Ratio de Calmar", ratio], ["positive_months", "Mois positifs", pct], ["best_month", "Meilleur mois", spct],
  ["worst_month", "Pire mois", spct], ["beta", "Bêta", ratio], ["alpha", "Alpha annualisé", spct],
  ["correlation", "Corrélation", ratio], ["tracking_error", "Tracking error", pct], ["information_ratio", "Ratio d'information", ratio],
];

function MetricsTable({ s, b }: { s: Metrics; b: Metrics }) {
  return (
    <table className="table-base">
      <thead><tr><th>Indicateur</th><th className="text-right">Stratégie</th><th className="text-right">Indice</th></tr></thead>
      <tbody>
        {ROWS.filter(([k]) => s[k] != null).map(([k, l, f]) => (
          <tr key={k}>
            <td className="text-ink2"><span className="inline-flex items-center gap-1">{l}{METRIC_HELP[k] && <Help text={METRIC_HELP[k]} />}</span></td>
            <td className="num text-right font-medium">{f(s[k] as number)}</td>
            <td className="num text-right text-ink2">{["beta", "alpha", "correlation", "tracking_error", "information_ratio"].includes(k) ? "—" : f(b[k] as number)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DecisionExplorer({ id, names }: { id: string; names: Record<string, string> }) {
  const [symbol, setSymbol] = useState("");
  const [actions, setActions] = useState<string[]>(["buy", "sell", "increase", "decrease"]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ["decisions", id, symbol, actions, from, to, page],
    queryFn: () => api<Page<Decision> & { symbols: string[] }>(`/backtests/${id}/decisions`, { params: { symbol, action: actions.join(","), from, to, page, page_size: 50 } }),
    placeholderData: (p) => p,
  });
  const toggle = (a: string) => { setPage(1); setActions((x) => (x.includes(a) ? x.filter((y) => y !== a) : [...x, a])); };
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(ACTION).map(([k, v]) => (
            <button key={k} onClick={() => toggle(k)} className={`chip ${actions.includes(k) ? v.cls : "opacity-50"}`} aria-pressed={actions.includes(k)}>{v.label}</button>
          ))}
        </div>
        <select className="input w-auto" value={symbol} onChange={(e) => { setSymbol(e.target.value); setPage(1); }} aria-label="Filtrer par actif">
          <option value="">Tous les actifs</option>
          {q.data?.symbols.map((s) => <option key={s} value={s}>{names[s] ?? s}</option>)}
        </select>
        <input type="date" className="input w-auto" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} aria-label="Du" />
        <input type="date" className="input w-auto" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} aria-label="Au" />
        <a className="btn-ghost ml-auto h-9 text-xs" href={exportUrl(id, "decisions")}><Download size={14} /> CSV</a>
      </div>
      {q.isLoading ? <Loading /> : (
        <>
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Date</th><th>Actif</th><th>Décision</th><th className="text-right">Poids</th><th>Pourquoi</th></tr></thead>
              <tbody>
                {q.data!.items.map((d, i) => (
                  <Fragment key={i}>
                    <tr className="cursor-pointer hover:bg-raised/50" onClick={() => setOpen(open === i ? null : i)}>
                      <td className="num whitespace-nowrap text-ink2">{date(d.date)}</td>
                      <td className="whitespace-nowrap"><div className="font-medium">{names[d.symbol] ?? d.symbol}</div><div className="text-xs text-muted">{d.symbol}</div></td>
                      <td><Badge className={ACTION[d.action].cls}>{ACTION[d.action].label}</Badge></td>
                      <td className="num whitespace-nowrap text-right">{pct(d.prev_weight)} <span className="text-muted">→</span> {pct(d.target_weight)}</td>
                      <td className="min-w-[280px] text-ink2"><span className="flex items-start gap-1"><ChevronRight size={14} className={`mt-0.5 shrink-0 text-muted transition ${open === i ? "rotate-90" : ""}`} />{d.reason}</span></td>
                    </tr>
                    {open === i && Object.keys(d.metrics).length > 0 && (
                      <tr><td colSpan={5} className="bg-raised/40">
                        <div className="flex flex-wrap gap-x-6 gap-y-1 px-2 text-xs">
                          {Object.entries(d.metrics).map(([k, v]) => (
                            <span key={k}><span className="text-muted">{k} </span><span className="num">{v == null ? "—" : Math.abs(v) < 5 && !["rank"].includes(k) ? num(v, 4) : num(v, 2)}</span></span>
                          ))}
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {q.data!.items.length === 0 && <p className="py-8 text-center text-sm text-muted">Aucune décision ne correspond à ces filtres.</p>}
          <Pagination page={q.data!.page} pages={q.data!.pages} total={q.data!.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

function TradesTable({ r, id }: { r: Results; id: string }) {
  const [symbol, setSymbol] = useState("");
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["transactions", id, symbol, page],
    queryFn: () => api<Page<Trade> & { symbols: string[] }>(`/backtests/${id}/transactions`, { params: { symbol, page, page_size: 50 } }),
    placeholderData: (p) => p,
  });
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select className="input w-auto" value={symbol} onChange={(e) => { setSymbol(e.target.value); setPage(1); }} aria-label="Filtrer par actif">
          <option value="">Tous les actifs</option>
          {q.data?.symbols.map((s) => <option key={s} value={s}>{r.names[s] ?? s}</option>)}
        </select>
        <a className="btn-ghost ml-auto h-9 text-xs" href={exportUrl(id, "trades")}><Download size={14} /> CSV</a>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : (
        <>
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Date</th><th>Actif</th><th>Sens</th><th className="text-right">Quantité</th><th className="text-right">Prix</th><th className="text-right">Montant</th><th className="text-right">Frais</th><th className="text-right">P/L réalisé</th><th>Motif</th></tr></thead>
              <tbody>
                {q.data!.items.map((t) => (
                  <tr key={t.seq}>
                    <td className="num whitespace-nowrap text-ink2">{date(t.date)}</td>
                    <td className="whitespace-nowrap font-medium">{r.names[t.symbol] ?? t.symbol}</td>
                    <td><Badge className={ACTION[t.side].cls}>{ACTION[t.side].label}</Badge></td>
                    <td className="num text-right">{num(t.qty, t.qty % 1 ? 3 : 0)}</td>
                    <td className="num text-right">{num(t.price)}</td>
                    <td className="num text-right">{eur(t.value)}</td>
                    <td className="num text-right text-ink2">{eur(t.fees + t.tax, true)}</td>
                    <td className={`num text-right ${tone(t.realized_pnl)}`}>{t.realized_pnl == null ? "—" : eur(t.realized_pnl)}</td>
                    <td className="max-w-[340px] truncate text-xs text-muted" title={t.reason}>{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={q.data!.page} pages={q.data!.pages} total={q.data!.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

export function BacktestView({ bt }: { bt: BacktestFull }) {
  const [tab, setTab] = useState<Tab>("perf");
  const r = bt.results!;
  const s = r.summary.strategy, b = r.summary.benchmark;
  const bench = r.names[bt.config.benchmark] ?? bt.config.benchmark;
  const dca = r.contributions.length > 0;
  return (
    <>
      <div className="card mb-6 p-5 sm:p-6">
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Valeur finale" value={eur(s.final_value)} sub={`versé ${eur(s.total_invested)}`} />
          <Stat label="Gain net" value={eur(s.net_profit)} valueClass={tone(s.net_profit)} sub={dca ? `TRI ${pct(s.irr)}` : spct(s.total_return)} help={METRIC_HELP.irr} />
          <Stat label="CAGR" value={pct(s.cagr)} valueClass={tone(s.cagr)} sub={`indice ${pct(b.cagr)}`} help={METRIC_HELP.cagr} />
          <Stat label="Perte max." value={pct(s.max_drawdown)} sub={`indice ${pct(b.max_drawdown)}`} help={METRIC_HELP.max_drawdown} />
          <Stat label="Sharpe" value={ratio(s.sharpe)} sub={`indice ${ratio(b.sharpe)}`} help={METRIC_HELP.sharpe} />
          <Stat label="Volatilité" value={pct(s.volatility)} sub={`exposition ${pct(s.avg_exposure)}`} help={METRIC_HELP.volatility} />
        </div>
        <div className="mt-5 border-t border-line pt-5"><Verdict s={s} b={b} bench={bench} /></div>
      </div>

      {r.warnings.length > 0 && (
        <div className="mb-6"><Notice tone="warn"><ul className="space-y-1">{r.warnings.slice(0, 6).map((w, i) => <li key={i}>{w}</li>)}</ul></Notice></div>
      )}

      <Tabs value={tab} onChange={setTab} tabs={[
        { value: "perf", label: "Performance" },
        { value: "alloc", label: "Positions & allocation", count: r.positions.length },
        { value: "decisions", label: "Décisions", count: r.counts.decisions },
        { value: "trades", label: "Transactions", count: r.counts.trades },
        ...(dca ? [{ value: "contrib" as Tab, label: "Versements", count: r.contributions.length }] : []),
        { value: "assumptions", label: "Hypothèses" },
      ]} />

      {tab === "perf" && (
        <div className="space-y-6">
          <Card title="Évolution du portefeuille" subtitle={dca ? "Valeur du portefeuille, capital versé et indice recevant les mêmes versements" : "Base 100 au départ"}>
            <EquityChart s={r.series} benchName={bench} />
          </Card>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Card title="Pertes depuis le plus haut" subtitle="Drawdown : la douleur ressentie en cours de route"><DrawdownChart s={r.series} benchName={bench} /></Card>
            <Card title="Performance annuelle"><YearlyBars rows={r.yearly} benchName={bench} /></Card>
          </div>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <Card title="Indicateurs détaillés" subtitle={`Indice : ${bench}`} pad={false}><div className="overflow-x-auto px-3 pb-3"><MetricsTable s={s} b={b} /></div></Card>
            <Card title="Rendements mensuels"><MonthlyHeatmap rows={r.monthly_returns} yearly={r.yearly} /></Card>
          </div>
        </div>
      )}

      {tab === "alloc" && (
        <div className="space-y-6">
          <Card title="Allocation dans le temps" subtitle="Poids de chaque ligne en début de mois (7 principales lignes, le reste regroupé)">
            <AllocationChart history={r.allocation_history} names={r.names} />
          </Card>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <Card title={`Positions au ${date(r.effective_period.end)}`} pad={false}>
              {r.positions.length === 0 ? <p className="px-6 pb-6 text-sm text-muted">Portefeuille entièrement en liquidités en fin de période.</p> : (
                <div className="overflow-x-auto px-3 pb-3">
                  <table className="table-base">
                    <thead><tr><th>Actif</th><th className="text-right">Poids</th><th className="text-right">Valeur</th><th className="text-right">PRU</th><th className="text-right">Cours</th><th className="text-right">+/- latente</th></tr></thead>
                    <tbody>
                      {r.positions.map((p) => (
                        <tr key={p.symbol}>
                          <td><div className="font-medium">{p.name}</div><div className="text-xs text-muted">{p.symbol} · {num(p.qty, p.qty % 1 ? 3 : 0)} titres</div></td>
                          <td className="num text-right">{pct(p.weight)}</td>
                          <td className="num text-right">{eur(p.value)}</td>
                          <td className="num text-right text-ink2">{num(p.avg_cost)}</td>
                          <td className="num text-right text-ink2">{num(p.price)}</td>
                          <td className={`num text-right ${tone(p.unrealized_pnl)}`}>{eur(p.unrealized_pnl)}<div className="text-xs">{spct(p.unrealized_pct)}</div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <Card title="Contribution au résultat" subtitle="Plus/moins-values réalisées et latentes, par actif">
              <ul className="space-y-2">
                {r.attribution.slice(0, 12).map((a) => {
                  const max = Math.max(...r.attribution.map((x) => Math.abs(x.pnl)), 1);
                  return (
                    <li key={a.symbol} className="text-sm">
                      <div className="flex justify-between gap-3"><span className="truncate">{a.name}</span><span className={`num ${tone(a.pnl)}`}>{eur(a.pnl)}</span></div>
                      <div className="mt-1 h-1.5 rounded-full bg-raised"><div className={`h-1.5 rounded-full ${a.pnl >= 0 ? "bg-pos/70" : "bg-neg/70"}`} style={{ width: `${(Math.abs(a.pnl) / max) * 100}%` }} /></div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>
        </div>
      )}

      {tab === "decisions" && (
        <Card title="Journal des décisions" subtitle="Chaque évaluation de la stratégie, actif par actif, avec la raison et les indicateurs utilisés. Cliquez une ligne pour voir les valeurs.">
          <DecisionExplorer id={bt.id} names={r.names} />
        </Card>
      )}
      {tab === "trades" && <Card title="Transactions simulées"><TradesTable r={r} id={bt.id} /></Card>}
      {tab === "contrib" && (
        <Card title="Historique des versements" actions={<a className="btn-ghost h-8 text-xs" href={exportUrl(bt.id, "contributions")}><Download size={14} /> CSV</a>} pad={false}>
          <div className="max-h-[560px] overflow-auto px-3 pb-3">
            <table className="table-base">
              <thead className="sticky top-0 bg-surface"><tr><th>Date</th><th className="text-right">Versement</th><th className="text-right">Cumul versé</th><th className="text-right">Valeur du portefeuille</th><th className="text-right">+/- latente</th></tr></thead>
              <tbody>
                {[...r.contributions].reverse().map((c) => (
                  <tr key={c.date}>
                    <td className="num text-ink2">{date(c.date)}</td>
                    <td className="num text-right">{eur(c.amount)}</td>
                    <td className="num text-right">{eur(c.cumulative)}</td>
                    <td className="num text-right">{eur(c.portfolio_value)}</td>
                    <td className={`num text-right ${tone(c.portfolio_value - c.cumulative)}`}>{spct(c.portfolio_value / c.cumulative - 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {tab === "assumptions" && (
        <div className="grid gap-6 xl:grid-cols-2">
          <Card title="Hypothèses de simulation" subtitle="À lire avant d'interpréter les résultats">
            <ul className="space-y-3 text-sm">{r.assumptions.map((a, i) => <li key={i} className="flex gap-3"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent" /><span className="leading-relaxed text-ink2">{a}</span></li>)}</ul>
          </Card>
          <Card title="Configuration exacte">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              {[
                ["Période demandée", `${date(bt.config.start)} → ${date(bt.config.end)}`],
                ["Période effective", `${date(r.effective_period.start)} → ${date(r.effective_period.end)}`],
                ["Capital initial", eur(bt.config.initial_capital)],
                ["Versements", bt.config.contributions.frequency === "none" ? "Aucun" : `${eur(bt.config.contributions.amount)} · ${FREQ[bt.config.contributions.frequency]}`],
                ["Rééquilibrage", FREQ[bt.config.rebalance]],
                ["Indice", bench],
                ["Univers", `${bt.config.universe.length} actifs`],
                ["Frais", `${bt.config.costs.fee_pct} % · min ${bt.config.costs.fee_min} € · slippage ${bt.config.costs.slippage_bps} pb`],
                ["Fiscalité", bt.config.tax_mode === "pfu" ? `Flat tax ${bt.config.tax_rate_pct} %` : "Aucune"],
                ["Paramètres", Object.entries(bt.config.parameters).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ")],
              ].map(([k, v]) => <Fragment key={k}><dt className="text-muted">{k}</dt><dd className="num break-words">{v}</dd></Fragment>)}
            </dl>
            <div className="mt-4 flex flex-wrap gap-1">{bt.config.universe.map((u) => <span key={u} className="chip">{u}</span>)}</div>
          </Card>
        </div>
      )}
    </>
  );
}

export function BacktestPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ["backtest", id],
    queryFn: () => api<BacktestFull>(`/backtests/${id}`),
    refetchInterval: (q) => (q.state.data && ["queued", "running"].includes(q.state.data.status) ? 1500 : false),
  });
  const del = useMutation({
    mutationFn: () => api(`/backtests/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["backtests"] }); toast("Backtest supprimé"); nav("/backtests"); },
    onError: (e) => toast((e as Error).message, "err"),
  });
  const rerun = useMutation({
    mutationFn: () => {
      const c = q.data!.config;
      return api<{ id: string }>("/backtests", { method: "POST", body: {
        strategy_id: q.data!.strategy_id, version: q.data!.strategy_version, start: c.start, end: new Date().toISOString().slice(0, 10),
        initial_capital: c.initial_capital, contributions: c.contributions, tax_mode: c.tax_mode, tax_rate_pct: c.tax_rate_pct,
        fractional: c.fractional, risk_free_pct: c.risk_free_pct,
      } });
    },
    onSuccess: (b) => nav(`/backtests/${b.id}`),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const bt = q.data!;
  return (
    <>
      <PageHeader
        eyebrow={<span className="flex items-center gap-2"><Link to="/backtests" className="hover:text-ink">Backtests</Link><span>·</span><Link to={`/strategies/${bt.strategy_id}`} className="hover:text-ink">{bt.strategy_name} v{bt.strategy_version}</Link></span>}
        title={bt.name}
        description={<>Lancé le {dateTime(bt.created_at)} {bt.status !== "done" && <Badge className={STATUS[bt.status].cls}>{STATUS[bt.status].label}</Badge>}</>}
        actions={bt.status === "done" && (
          <>
            <Link to={`/compare?ids=${bt.id}`} className="btn-outline"><GitCompareArrows size={15} /> Comparer</Link>
            <a href={exportUrl(bt.id, "equity")} className="btn-outline"><Download size={15} /> Export</a>
            {can("backtest:run") && <button className="btn-ghost" onClick={() => rerun.mutate()} title="Relancer jusqu'à aujourd'hui"><RotateCcw size={15} /></button>}
            {can("backtest:delete") && <button className="btn-ghost" onClick={() => del.mutate()} title="Supprimer"><Trash2 size={15} /></button>}
          </>
        )} />
      {(bt.status === "queued" || bt.status === "running") && (
        <div className="card flex flex-col items-center gap-3 px-6 py-20 text-center">
          <Spinner className="h-6 w-6" />
          <div className="font-medium">{bt.status === "queued" ? "En file d'attente…" : bt.progress_message ?? "Simulation en cours…"}</div>
          <div className="h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((bt.progress ?? 0) * 100)}>
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(3, (bt.progress ?? 0) * 100)}%` }} />
          </div>
          <p className="max-w-md text-sm text-muted">Calcul exécuté en arrière-plan : vous pouvez quitter cette page, le résultat sera conservé.</p>
        </div>
      )}
      {bt.status === "failed" && <ErrorNote error={bt.error ?? "Échec du backtest"} />}
      {bt.status === "done" && bt.results && <BacktestView bt={bt} />}
    </>
  );
}
