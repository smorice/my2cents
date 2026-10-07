import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ValueChart } from "../components/charts";
import { Badge, Card, ErrorNote, Loading, PageHeader, Segmented, toast } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { date, dateTime } from "../lib/format";
import { useInstruments } from "../lib/queries";
import type { Instrument } from "../lib/types";

const KIND: Record<string, string> = { equity: "Action", etf: "ETF", index: "Indice" };

export function MarketsPage() {
  const q = useInstruments();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"all" | "equity" | "etf" | "index">("all");
  const [sel, setSel] = useState<string>("^FCHI");
  const [years, setYears] = useState<"1" | "5" | "10" | "20">("5");
  const [newSym, setNewSym] = useState("");
  const prices = useQuery({
    queryKey: ["prices", sel, years],
    queryFn: () => api<{ dates: string[]; close: number[] }>(`/market/instruments/${encodeURIComponent(sel)}/prices`, { params: { days: Number(years) * 365 } }),
  });
  const add = useMutation({
    mutationFn: () => api<Instrument>("/market/instruments", { method: "POST", body: { symbol: newSym } }),
    onSuccess: (i) => { qc.invalidateQueries({ queryKey: ["instruments"] }); setSel(i.symbol); setNewSym(""); toast(`${i.name} ajouté`); },
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
      <PageHeader eyebrow="Marchés" title="Données de marché"
        description="Cours quotidiens ajustés (dividendes et opérations sur titres) issus de Yahoo Finance, mis en cache et rafraîchis automatiquement." />
      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        <Card pad={false}>
          <div className="space-y-3 p-4">
            <div className="relative"><Search size={15} className="absolute left-3 top-2.5 text-muted" /><input className="input pl-9" placeholder="Rechercher…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
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
          {can("strategy:create") && (
            <form className="flex gap-2 border-t border-line p-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
              <input className="input" placeholder="Ajouter un ticker Yahoo (ex. ALO.PA)" value={newSym} onChange={(e) => setNewSym(e.target.value.toUpperCase())} />
              <button className="btn-outline" disabled={!newSym || add.isPending}><Plus size={15} /></button>
            </form>
          )}
          {add.error && <div className="px-4 pb-4"><ErrorNote error={add.error} /></div>}
        </Card>
        <Card title={current ? `${current.name}` : sel} subtitle={current && `${current.symbol} · ${current.currency} · historique ${date(current.first_date)} → ${date(current.last_date)} · synchronisé ${dateTime(current.last_synced_at)}`}
          actions={<>
            <Segmented size="sm" value={years} onChange={setYears} options={[{ value: "1", label: "1A" }, { value: "5", label: "5A" }, { value: "10", label: "10A" }, { value: "20", label: "20A" }]} />
            {can("market:refresh") && <button className="btn-ghost h-8 px-2" onClick={() => sync.mutate(sel)} disabled={sync.isPending} title="Rafraîchir"><RefreshCw size={15} className={sync.isPending ? "animate-spin" : ""} /></button>}
          </>}>
          {prices.isLoading ? <Loading /> : prices.data && prices.data.dates.length > 1 ? (
            <ValueChart dates={prices.data.dates} values={prices.data.close} height={380} label="Cours de clôture" />
          ) : <p className="py-16 text-center text-sm text-muted">Pas encore de données pour ce symbole (chargement automatique en cours ou au premier backtest).</p>}
          {current?.sync_error && <div className="mt-4"><ErrorNote error={current.sync_error} /></div>}
        </Card>
      </div>
    </>
  );
}
