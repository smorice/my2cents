import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Card, ErrorNote, Loading, PageHeader, Pagination } from "../components/ui";
import { api } from "../lib/api";
import { date, dateTime, eur, num, tone } from "../lib/format";
import { ACTION } from "../lib/labels";
import { useNames } from "../lib/queries";
import type { AuditEvent, Page, Trade } from "../lib/types";

interface Tx extends Trade { backtest_id: string; backtest_name: string; portfolio_id: string | null }

export function TransactionsPage() {
  const names = useNames();
  const [source, setSource] = useState("");
  const [side, setSide] = useState("");
  const [symbol, setSymbol] = useState("");
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["all-transactions", source, side, symbol, page],
    queryFn: () => api<Page<Tx> & { sources: { id: string; name: string; portfolio: boolean }[] }>("/transactions", {
      params: { backtest_id: source === "portfolios" ? undefined : source, portfolios_only: source === "portfolios" || undefined, side, symbol, page },
    }),
    placeholderData: (p) => p,
  });
  return (
    <>
      <PageHeader eyebrow="Transactions" title="Transactions simulées"
        description="Tous les ordres simulés de vos backtests et portefeuilles. Aucun ordre réel n'est jamais passé." />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 p-4">
          <select className="input w-auto max-w-xs" value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} aria-label="Source">
            <option value="">Tous les backtests et portefeuilles</option>
            <option value="portfolios">Portefeuilles uniquement</option>
            {q.data?.sources.map((s) => <option key={s.id} value={s.id}>{s.portfolio ? "◆ " : ""}{s.name}</option>)}
          </select>
          <select className="input w-auto" value={side} onChange={(e) => { setSide(e.target.value); setPage(1); }} aria-label="Sens">
            <option value="">Achats et ventes</option><option value="buy">Achats</option><option value="sell">Ventes</option>
          </select>
          <input className="input w-36" placeholder="Symbole" value={symbol} onChange={(e) => { setSymbol(e.target.value.toUpperCase()); setPage(1); }} aria-label="Symbole" />
        </div>
        {q.isLoading ? <Loading /> : q.error ? <div className="p-4"><ErrorNote error={q.error} /></div> : (
          <div tabIndex={0} className="overflow-x-auto px-3 pb-3">
            <table className="table-base">
              <thead><tr><th>Date</th><th>Actif</th><th>Sens</th><th className="text-right">Quantité</th><th className="text-right">Prix</th><th className="text-right">Montant</th><th className="text-right">P/L réalisé</th><th>Source</th></tr></thead>
              <tbody>
                {q.data!.items.map((t) => (
                  <tr key={`${t.backtest_id}-${t.seq}`}>
                    <td className="num whitespace-nowrap text-ink2">{date(t.date)}</td>
                    <td className="whitespace-nowrap"><div className="font-medium">{names[t.symbol] ?? t.symbol}</div><div className="text-xs text-muted">{t.symbol}</div></td>
                    <td><Badge className={ACTION[t.side].cls}>{ACTION[t.side].label}</Badge></td>
                    <td className="num text-right">{num(t.qty, t.qty % 1 ? 3 : 0)}</td>
                    <td className="num text-right">{num(t.price)}</td>
                    <td className="num text-right">{eur(t.value)}</td>
                    <td className={`num text-right ${tone(t.realized_pnl)}`}>{t.realized_pnl == null ? "—" : eur(t.realized_pnl)}</td>
                    <td className="max-w-[260px] truncate text-xs"><Link className="text-ink2 hover:text-accent" to={t.portfolio_id ? `/portfolios/${t.portfolio_id}` : `/backtests/${t.backtest_id}`}>{t.backtest_name}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {q.data!.items.length === 0 && <p className="py-10 text-center text-sm text-muted">Aucune transaction : lancez un backtest pour en générer.</p>}
            <Pagination page={q.data!.page} pages={q.data!.pages} total={q.data!.total} onPage={setPage} />
          </div>
        )}
      </Card>
    </>
  );
}

const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Connexion", "auth.logout": "Déconnexion", "auth.login_failed": "Échec de connexion", "backtest.launch": "Backtest lancé",
  "backtest.complete": "Backtest terminé", "backtest.delete": "Backtest supprimé", "backtest.export": "Export CSV", "strategy.create": "Stratégie créée",
  "strategy.update": "Stratégie modifiée", "strategy.clone": "Stratégie clonée", "portfolio.create": "Portefeuille créé",
  "portfolio.allocation_change": "Allocation modifiée", "portfolio.delete": "Portefeuille supprimé", "access.denied": "Accès refusé",
};

export function ActivityPage() {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ["my-activity", page], queryFn: () => api<Page<AuditEvent>>("/audit/me", { params: { page } }), placeholderData: (p) => p });
  return (
    <>
      <PageHeader eyebrow="Compte" title="Mon activité"
        description="Le journal de vos actions importantes : connexions, simulations, modifications de stratégies et de portefeuilles. Il est infalsifiable (chaîné par empreintes) et conservé pour la traçabilité." />
      <Card pad={false}>
        {q.isLoading ? <Loading /> : (
          <div tabIndex={0} className="overflow-x-auto px-3 py-3">
            <table className="table-base">
              <thead><tr><th>Date</th><th>Action</th><th>Ressource</th><th>Résultat</th><th>Adresse IP</th></tr></thead>
              <tbody>
                {q.data!.items.map((e) => (
                  <tr key={e.id}>
                    <td className="num whitespace-nowrap text-ink2">{dateTime(e.occurred_at)}</td>
                    <td className="whitespace-nowrap">{ACTION_LABEL[e.action] ?? e.action}</td>
                    <td className="text-xs text-muted">
                      {e.resource_type === "backtest" && e.resource_id ? <Link className="hover:text-accent" to={`/backtests/${e.resource_id}`}>backtest</Link>
                        : e.resource_type === "strategy" && e.resource_id ? <Link className="hover:text-accent" to={`/strategies/${e.resource_id}`}>stratégie</Link>
                        : e.resource_type === "portfolio" && e.resource_id ? <Link className="hover:text-accent" to={`/portfolios/${e.resource_id}`}>portefeuille</Link>
                        : e.resource_type ?? "—"}
                    </td>
                    <td><Badge className={e.outcome === "success" ? "border-pos/30 text-pos" : "border-neg/30 text-neg"}>{e.outcome === "success" ? "Succès" : e.outcome === "denied" ? "Refusé" : "Échec"}</Badge></td>
                    <td className="num text-xs text-muted">{e.ip ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={q.data!.page} pages={q.data!.pages} total={q.data!.total} onPage={setPage} />
          </div>
        )}
      </Card>
    </>
  );
}
