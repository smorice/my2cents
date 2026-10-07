import clsx from "clsx";
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, Download, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pagination } from "./ui";

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  /** Value used for sorting and CSV export (omit for non-sortable display-only columns). */
  value?: (row: T) => string | number | null | undefined;
  align?: "right";
  hidden?: boolean; // hidden by default, can be shown from the column menu
  sticky?: boolean; // always visible
  className?: string;
}

function toCsv<T>(rows: T[], cols: Column<T>[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? "" : typeof v === "number" ? String(v).replace(".", ",") : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const withValue = cols.filter((c) => c.value);
  return "﻿" + [withValue.map((c) => esc(c.label)).join(";"), ...rows.map((r) => withValue.map((c) => esc(c.value!(r))).join(";"))].join("\n");
}

function useStored<V>(key: string | undefined, initial: V): [V, (v: V) => void] {
  const [v, setV] = useState<V>(() => {
    if (!key) return initial;
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as V) : initial;
    } catch {
      return initial;
    }
  });
  return [v, (next: V) => {
    setV(next);
    try { if (key) localStorage.setItem(key, JSON.stringify(next)); } catch { /* private mode */ }
  }];
}

/** Client-side table: sort, search, column visibility (remembered per browser), CSV export, pagination. */
export function DataTable<T>({
  rows, columns, rowKey, search, filters, pageSize = 25, csvName, storageKey, empty, onRowClick, defaultSort,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  search?: (row: T) => string;
  filters?: ReactNode;
  pageSize?: number;
  csvName?: string;
  storageKey?: string;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  defaultSort?: { key: string; dir: 1 | -1 };
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(defaultSort ?? null);
  const [page, setPage] = useState(1);
  const [hidden, setHidden] = useStored<string[]>(storageKey && `m2c-cols-${storageKey}`, columns.filter((c) => c.hidden).map((c) => c.key));
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menu]);

  const visible = columns.filter((c) => c.sticky || !hidden.includes(c.key));
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = needle && search ? rows.filter((r) => search(r).toLowerCase().includes(needle)) : rows;
    const col = sort && columns.find((c) => c.key === sort.key);
    if (col?.value) {
      out = [...out].sort((a, b) => {
        const x = col.value!(a), y = col.value!(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1; // empty values always last
        if (y == null) return -1;
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "fr")) * sort!.dir;
      });
    }
    return out;
  }, [rows, q, sort, columns, search]);
  useEffect(() => setPage(1), [q, sort, rows]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const shown = filtered.slice((page - 1) * pageSize, page * pageSize);

  const download = () => {
    const blob = new Blob([toCsv(filtered, visible)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${csvName ?? "export"}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-1">
        {search && (
          <label className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input className="input pl-8" placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher dans le tableau" />
          </label>
        )}
        {filters}
        <div className="ml-auto flex items-center gap-1">
          <div className="relative" ref={menuRef}>
            <button type="button" className="btn-ghost h-9 text-xs" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-haspopup="true"><Columns3 size={14} /> Colonnes</button>
            {menu && (
              <div className="absolute right-0 z-30 mt-1 w-56 rounded-xl border border-line bg-surface p-2 shadow-card" role="menu">
                {columns.filter((c) => !c.sticky).map((c) => (
                  <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-raised">
                    <input type="checkbox" checked={!hidden.includes(c.key)} onChange={() => setHidden(hidden.includes(c.key) ? hidden.filter((k) => k !== c.key) : [...hidden, c.key])} />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
          {csvName && <button type="button" className="btn-ghost h-9 text-xs" onClick={download}><Download size={14} /> CSV</button>}
        </div>
      </div>
      <div tabIndex={0} className="overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              {visible.map((c) => (
                <th key={c.key} className={clsx(c.align === "right" && "text-right", c.className)}
                  aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                  {c.value ? (
                    <button type="button" className={clsx("inline-flex items-center gap-1 uppercase hover:text-ink", c.align === "right" && "flex-row-reverse")}
                      onClick={() => setSort((s) => (s?.key === c.key ? (s.dir === -1 ? { key: c.key, dir: 1 } : null) : { key: c.key, dir: -1 }))}>
                      {c.label}
                      {sort?.key === c.key ? (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : <ArrowUpDown size={11} className="opacity-30" />}
                    </button>
                  ) : c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={rowKey(r)} className={clsx("hover:bg-raised/50", onRowClick && "cursor-pointer")} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                {visible.map((c) => <td key={c.key} className={clsx(c.align === "right" && "num text-right", c.className)}>{c.render(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length === 0 && <div className="px-6 py-10 text-center text-sm text-muted">{rows.length === 0 ? empty ?? "Aucune donnée." : "Aucun résultat ne correspond à la recherche."}</div>}
      <div className="px-3 pb-3"><Pagination page={page} pages={pages} total={filtered.length} onPage={setPage} /></div>
    </div>
  );
}
