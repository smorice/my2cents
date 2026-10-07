import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Plus, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Instrument } from "../lib/types";
import { Spinner } from "./ui";

interface Hit { symbol: string; name: string; kind: "equity" | "etf" | "index"; exchange: string | null; in_catalog: boolean }

const KIND = { equity: "Action", etf: "ETF", index: "Indice" } as const;

/**
 * Search an instrument by name or ticker. Hits come from the catalogue first, then from the
 * data provider's listings; picking one of the latter adds it to the catalogue (and downloads
 * its history) before handing the symbol back.
 */
export function SymbolPicker({ value, onChange, placeholder = "Nom ou code (ex. Figeac Aero)", label, className, kinds, clearOnPick }: {
  value: string; onChange: (symbol: string, name: string) => void; placeholder?: string; label: string; className?: string;
  kinds?: Hit["kind"][];
  clearOnPick?: boolean; // for "add to a list" inputs
}) {
  const qc = useQueryClient();
  const id = useId();
  const [text, setText] = useState(value);
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const busy = useRef(false); // a pick is in progress: the input's blur must not reset it

  useEffect(() => setText(value), [value]);
  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const q = useQuery({
    queryKey: ["symbol-search", term], enabled: open && term.length >= 2 && term !== value, staleTime: 5 * 60_000,
    queryFn: () => api<{ items: Hit[]; remote_error: string | null }>("/market/search", { params: { q: term } }),
  });
  const items = (q.data?.items ?? []).filter((h) => !kinds || kinds.includes(h.kind));

  const pick = async (h: Hit) => {
    busy.current = true;
    setError(null);
    if (!h.in_catalog) {
      setAdding(h.symbol);
      try {
        await api<Instrument>("/market/instruments", { method: "POST", body: { symbol: h.symbol, kind: h.kind } });
        qc.invalidateQueries({ queryKey: ["instruments"] });
        qc.invalidateQueries({ queryKey: ["symbol-search"] });
      } catch (e) {
        setError((e as Error).message);
        setAdding(null);
        busy.current = false;
        return;
      }
      setAdding(null);
    }
    setText(clearOnPick ? "" : h.symbol);
    setOpen(false);
    onChange(h.symbol, h.name);
    busy.current = false;
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % items.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); }
    else if (e.key === "Enter") { e.preventDefault(); pick(items[active]); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div ref={box} className={clsx("relative", className)}>
      <Search size={14} className="pointer-events-none absolute left-3 top-3 text-muted" aria-hidden="true" />
      <input className="input pl-8" role="combobox" aria-label={label} aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list"
        aria-activedescendant={open && items[active] ? `${id}-${active}` : undefined}
        placeholder={placeholder} value={text} disabled={!!adding}
        onFocus={() => setOpen(true)} onKeyDown={onKey}
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0); }}
        onBlur={() => {
          // Only a picked hit is a valid symbol: unpicked text falls back to the current value.
          if (!busy.current) { setText(value); setOpen(false); }
        }} />
      {adding && <p className="mt-1 flex items-center gap-1.5 text-xs text-muted"><Spinner /> Ajout de {adding} et téléchargement de son historique…</p>}
      {error && <p className="mt-1 text-xs text-neg">{error}</p>}
      {open && term.length >= 2 && term !== value && (
        <ul id={`${id}-list`} role="listbox" className="absolute z-50 mt-1 max-h-72 w-full min-w-[280px] overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-xl">
          {q.isFetching && !items.length && <li className="flex items-center gap-2 px-3 py-2 text-sm text-muted"><Spinner /> Recherche…</li>}
          {!q.isFetching && !items.length && <li className="px-3 py-2 text-sm text-muted">Aucun titre trouvé pour « {term} ».</li>}
          {items.map((h, k) => (
            <li key={h.symbol} id={`${id}-${k}`} role="option" aria-selected={k === active}
              onMouseDown={(e) => { e.preventDefault(); pick(h); }} onMouseEnter={() => setActive(k)}
              className={clsx("flex cursor-pointer items-center gap-3 px-3 py-2 text-sm", k === active && "bg-raised")}>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{h.name}</span>
                <span className="text-xs text-muted">{h.symbol} · {KIND[h.kind]}{h.exchange ? ` · ${h.exchange}` : ""}</span>
              </span>
              {!h.in_catalog && <span className="inline-flex shrink-0 items-center gap-1 text-xs text-accent"><Plus size={12} /> ajouter</span>}
            </li>
          ))}
          {q.data?.remote_error && <li className="border-t border-line px-3 py-2 text-xs text-warn">{q.data.remote_error}</li>}
        </ul>
      )}
    </div>
  );
}
