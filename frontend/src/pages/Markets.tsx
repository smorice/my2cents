import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ValueChart } from "../components/charts";
import { Badge, Card, ErrorNote, Loading, Notice, PageHeader, Segmented, SourceBadge, Spinner, toast } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { date, dateTime, spct } from "../lib/format";
import { useInstruments } from "../lib/queries";
import type { Instrument } from "../lib/types";

const KIND: Record<string, string> = { equity: "Action", etf: "ETF", index: "Indice" };

interface Hit { symbol: string; name: string; kind: "equity" | "etf" | "index"; exchange: string | null; in_catalog: boolean }

/** Listings found on the markets for the search term, outside the catalogue, with a one-click add. */
function MarketHits({ term, canAdd, onAdded }: { term: string; canAdd: boolean; onAdded: (symbol: string, name: string) => void }) {
  const qc = useQueryClient();
  const [debounced, setDebounced] = useState(term);
  useEffect(() => { const t = setTimeout(() => setDebounced(term), 350); return () => clearTimeout(t); }, [term]);
  const q = useQuery({
    queryKey: ["symbol-search", debounced], staleTime: 5 * 60_000,
    queryFn: () => api<{ items: Hit[]; remote_error: string | null }>("/market/search", { params: { q: debounced } }),
  });
  const add = useMutation({
    mutationFn: (h: Hit) => api<Instrument>("/market/instruments", { method: "POST", body: { symbol: h.symbol, kind: h.kind } }),
    onSuccess: (i) => { qc.invalidateQueries({ queryKey: ["instruments"] }); qc.invalidateQueries({ queryKey: ["symbol-search"] }); onAdded(i.symbol, i.name); },
  });
  const hits = (q.data?.items ?? []).filter((h) => !h.in_catalog);
  return (
    <div className="border-t border-line">
      <p className="eyebrow px-4 pb-1 pt-3">Sur les marchés</p>
      {q.isFetching && !hits.length && <p className="flex items-center gap-2 px-4 py-2 text-sm text-muted"><Spinner /> Recherche de « {debounced} »…</p>}
      {!q.isFetching && !hits.length && !q.data?.remote_error && <p className="px-4 py-2 text-sm text-muted">Rien de plus que le catalogue pour « {debounced} ».</p>}
      {q.data?.remote_error && <p className="px-4 py-2 text-xs text-warn">{q.data.remote_error}</p>}
      <ul className="max-h-[300px] overflow-y-auto pb-2">
        {hits.map((h) => (
          <li key={h.symbol} className="flex items-center gap-3 px-4 py-2 text-sm">
            <span className="min-w-0 flex-1"><span className="block truncate font-medium">{h.name}</span>
              <span className="text-xs text-muted">{h.symbol} · {KIND[h.kind]}{h.exchange ? ` · ${h.exchange}` : ""}</span></span>
            {canAdd && (
              <button className="btn-outline h-8 shrink-0 px-2.5 text-xs" disabled={add.isPending} onClick={() => add.mutate(h)}>
                {add.isPending && add.variables?.symbol === h.symbol ? <Spinner /> : <Plus size={13} />} Ajouter
              </button>
            )}
          </li>
        ))}
      </ul>
      {add.error && <div className="px-4 pb-3"><ErrorNote error={add.error} /></div>}
    </div>
  );
}

export function MarketsPage() {
  const q = useInstruments();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"all" | "equity" | "etf" | "index">("all");
  const [sel, setSel] = useState<string>("^FCHI");
  const [years, setYears] = useState<"1" | "5" | "10" | "20">("5");
  const prices = useQuery({
    queryKey: ["prices", sel, years],
    queryFn: () => api<{ dates: string[]; close: number[]; anomalies: { date: string; change: number }[] }>(`/market/instruments/${encodeURIComponent(sel)}/prices`, { params: { days: Number(years) * 365 } }),
  });
  const sync = useMutation({
    mutationFn: (s: string) => api<Instrument>(`/market/instruments/${encodeURIComponent(s)}/sync`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["instruments"] }); qc.invalidateQueries({ queryKey: ["prices"] }); toast("Données rafraîchies"); },
    onError: (e) => toast((e as Error).message, "err"),
  });
  const rows = useMemo(() => (q.data ?? []).filter((i) => (kind === "all" || i.kind === kind) && (!filter || `${i.symbol} ${i.name}`.toLowerCase().includes(filter.toLowerCase()))), [q.data, kind, filter]);
  const current = q.data?.find((i) => i.symbol === sel);
  if (q.isLoading) return <Loading />;
  return (
    <>
      <PageHeader eyebrow={<span className="flex items-center gap-2">Marchés <SourceBadge kind="real" title="Cours quotidiens Yahoo Finance, datés et historisés" /></span>} title="Données de marché"
        description="Cours quotidiens ajustés (dividendes et opérations sur titres) issus de Yahoo Finance, mis en cache et rafraîchis automatiquement." />
      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        <Card pad={false}>
          <div className="space-y-3 p-4">
            <div className="relative"><Search size={15} className="absolute left-3 top-2.5 text-muted" aria-hidden="true" /><input className="input pl-9" aria-label="Rechercher un titre" placeholder="Rechercher un titre (nom ou code)…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
            <Segmented size="sm" value={kind} onChange={setKind} options={[{ value: "all", label: "Tout" }, { value: "equity", label: "Actions" }, { value: "etf", label: "ETF" }, { value: "index", label: "Indices" }]} />
          </div>
          <ul className="max-h-[560px] overflow-y-auto border-t border-line">
            {rows.map((i) => (
              <li key={i.symbol}>
                <button onClick={() => setSel(i.symbol)} className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-raised ${sel === i.symbol ? "bg-raised" : ""}`}>
                  <span className="min-w-0"><span className="block truncate font-medium">{i.name}</span><span className="text-xs text-muted">{i.symbol} · {i.sector ?? KIND[i.kind]}</span></span>
                  {i.sync_error ? <Badge className="text-neg">erreur</Badge> : !i.last_date && <Badge>non chargé</Badge>}
                </button>
              </li>
            ))}
          </ul>
          {filter.trim().length >= 2 && <MarketHits term={filter.trim()} canAdd={can("strategy:create")} onAdded={(sym, name) => { setSel(sym); setFilter(""); toast(`${name} ajouté au catalogue`); }} />}
        </Card>
        <Card title={current ? `${current.name}` : sel} subtitle={current && `${current.symbol} · ${current.currency} · historique ${date(current.first_date)} → ${date(current.last_date)} · synchronisé ${dateTime(current.last_synced_at)}`}
          actions={<>
            <Segmented size="sm" value={years} onChange={setYears} options={[{ value: "1", label: "1A" }, { value: "5", label: "5A" }, { value: "10", label: "10A" }, { value: "20", label: "20A" }]} />
            {can("market:refresh") && <button className="btn-ghost h-8 px-2" onClick={() => sync.mutate(sel)} disabled={sync.isPending} title="Rafraîchir"><RefreshCw size={15} className={sync.isPending ? "animate-spin" : ""} /></button>}
          </>}>
          {!!prices.data?.anomalies.length && (
            <Notice tone="warn">
              Données suspectes : {prices.data.anomalies.map((a) => `${spct(a.change)} le ${date(a.date)}`).join(", ")}.
              Probablement une opération sur titres mal ajustée par la source (regroupement, scission, restructuration).
              Dans les simulations et les calculs d'ordres, ces jours-là comptent pour 0 %.
            </Notice>
          )}
          {prices.isLoading ? <Loading /> : prices.data && prices.data.dates.length > 1 ? (
            <ValueChart dates={prices.data.dates} values={prices.data.close} height={380} label="Cours de clôture" />
          ) : <p className="py-16 text-center text-sm text-muted">Pas encore de données pour ce symbole (chargement automatique en cours ou au premier backtest).</p>}
          {current?.sync_error && <div className="mt-4"><ErrorNote error={current.sync_error} /></div>}
        </Card>
      </div>
    </>
  );
}
