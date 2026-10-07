import { useMemo, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { eur, monthYear, pct, short, spct } from "../lib/format";
import { useChartColors } from "../lib/theme";

const MAX_POINTS = 900;

/** Evenly thin a series for rendering, always keeping the last point. */
function thin<T>(rows: T[]): T[] {
  if (rows.length <= MAX_POINTS) return rows;
  const step = rows.length / MAX_POINTS;
  const out: T[] = [];
  for (let i = 0; i < MAX_POINTS; i++) out.push(rows[Math.floor(i * step)]);
  out.push(rows[rows.length - 1]);
  return out;
}

function TipBox({ title, rows }: { title: ReactNode; rows: { color: string; label: ReactNode; value: ReactNode; dashed?: boolean }[] }) {
  return (
    <div className="min-w-[180px] rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs shadow-card backdrop-blur">
      <div className="mb-1.5 font-medium text-ink">{title}</div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-ink2">
            <span className="inline-block h-0.5 w-3 rounded" style={{ background: r.color, opacity: r.dashed ? 0.7 : 1 }} />
            {r.label}
          </span>
          <span className="num font-medium text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { color: string; label: ReactNode; dashed?: boolean; area?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink2">
      {items.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {it.area ? (
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: it.color }} />
          ) : (
            <svg width="16" height="4" aria-hidden="true"><line x1="0" y1="2" x2="16" y2="2" stroke={it.color} strokeWidth="2" strokeDasharray={it.dashed ? "3 3" : undefined} strokeLinecap="round" /></svg>
          )}
          {it.label}
        </span>
      ))}
    </div>
  );
}

const axisProps = { tickLine: false, axisLine: false, minTickGap: 40 } as const;
const fmtDateTick = (d: string) => monthYear(d);
const dateLabel = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });

interface Series {
  dates: string[];
  equity: number[];
  invested: number[];
  benchmark_equity: number[];
  twr: number[];
  benchmark_twr: number[];
  drawdown: number[];
  benchmark_drawdown: number[];
}

export function EquityChart({ s, benchName, height = 320 }: { s: Series; benchName: string; height?: number }) {
  const c = useChartColors();
  const hasFlows = s.invested[s.invested.length - 1] !== s.invested[0];
  const [mode, setMode] = useState<"value" | "base100">(hasFlows ? "value" : "base100");
  const data = useMemo(
    () => thin(s.dates.map((d, i) => ({
      d,
      v: mode === "value" ? s.equity[i] : s.twr[i] * 100,
      b: mode === "value" ? s.benchmark_equity[i] : s.benchmark_twr[i] * 100,
      inv: s.invested[i],
    }))),
    [s, mode],
  );
  const fmt = (v: number) => (mode === "value" ? eur(v) : v.toFixed(1).replace(".", ","));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Legend items={[
          { color: c["c-1"], label: "Stratégie" },
          { color: c["c-bench"], label: benchName + (mode === "value" && hasFlows ? " (mêmes versements)" : ""), dashed: true },
          ...(mode === "value" ? [{ color: c["c-invested"], label: "Capital versé", area: true }] : []),
        ]} />
        <div className="inline-flex rounded-lg border border-line bg-raised p-0.5 text-xs">
          {(["value", "base100"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`rounded-md px-2.5 py-1 font-medium ${mode === m ? "bg-surface text-ink shadow-sm" : "text-muted"}`}>
              {m === "value" ? "Valeur €" : "Base 100"}
            </button>
          ))}
        </div>
      </div>
      <div style={{ height }} role="img" aria-label="Évolution de la valeur du portefeuille comparée à l'indice">
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={c["c-grid"]} />
            <XAxis dataKey="d" tickFormatter={fmtDateTick} {...axisProps} />
            <YAxis width={64} tickFormatter={(v) => (mode === "value" ? short(v) : String(Math.round(v)))} {...axisProps} domain={["auto", "auto"]} />
            <Tooltip cursor={{ stroke: c["c-axis"], strokeDasharray: "3 3" }} content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TipBox title={dateLabel(label)} rows={[
                  { color: c["c-1"], label: "Stratégie", value: fmt(payload[0].payload.v) },
                  { color: c["c-bench"], label: benchName, value: fmt(payload[0].payload.b), dashed: true },
                  ...(mode === "value" ? [{ color: c["c-invested"], label: "Versé", value: eur(payload[0].payload.inv) }] : []),
                ]} />
              ) : null} />
            {mode === "value" && <Area type="stepAfter" dataKey="inv" stroke="none" fill={c["c-invested"]} fillOpacity={0.35} isAnimationActive={false} />}
            <Area type="monotone" dataKey="b" stroke={c["c-bench"]} strokeWidth={1.5} strokeDasharray="4 3" fill="none" dot={false} isAnimationActive={false} />
            <Area type="monotone" dataKey="v" stroke={c["c-1"]} strokeWidth={2} fill={c["c-1"]} fillOpacity={0.08} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "rgb(var(--surface))" }} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function DrawdownChart({ s, benchName, height = 180 }: { s: Series; benchName: string; height?: number }) {
  const c = useChartColors();
  const data = useMemo(() => thin(s.dates.map((d, i) => ({ d, v: s.drawdown[i], b: s.benchmark_drawdown[i] }))), [s]);
  return (
    <div>
      <div className="mb-3"><Legend items={[{ color: c["c-1"], label: "Stratégie" }, { color: c["c-bench"], label: benchName, dashed: true }]} /></div>
      <div style={{ height }} role="img" aria-label="Pertes depuis le plus haut (drawdown)">
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={c["c-grid"]} />
            <XAxis dataKey="d" tickFormatter={fmtDateTick} {...axisProps} />
            <YAxis width={64} tickFormatter={(v) => pct(v)} {...axisProps} domain={["dataMin", 0]} />
            <Tooltip cursor={{ stroke: c["c-axis"], strokeDasharray: "3 3" }} content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TipBox title={dateLabel(label)} rows={[
                  { color: c["c-1"], label: "Stratégie", value: pct(payload[0].payload.v) },
                  { color: c["c-bench"], label: benchName, value: pct(payload[0].payload.b), dashed: true },
                ]} />
              ) : null} />
            <Area type="monotone" dataKey="b" stroke={c["c-bench"]} strokeWidth={1.5} strokeDasharray="4 3" fill="none" isAnimationActive={false} />
            <Area type="monotone" dataKey="v" stroke={c["c-1"]} strokeWidth={1.5} fill={c["c-1"]} fillOpacity={0.15} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const MONTHS = ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin", "Juil", "Août", "Sep", "Oct", "Nov", "Déc"];

export function MonthlyHeatmap({ rows, yearly }: { rows: { year: number; month: number; return: number | null }[]; yearly: { year: number; strategy: number | null }[] }) {
  const years = [...new Set(rows.map((r) => r.year))].sort((a, b) => b - a);
  const get = (y: number, m: number) => rows.find((r) => r.year === y && r.month === m)?.return ?? null;
  const max = Math.max(0.02, ...rows.map((r) => Math.abs(r.return ?? 0)));
  const bg = (v: number | null) => {
    if (v == null) return undefined;
    const a = Math.min(Math.abs(v) / max, 1) * 0.55 + 0.06;
    return v >= 0 ? `rgb(var(--pos) / ${a})` : `rgb(var(--neg) / ${a})`;
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-separate border-spacing-[2px] text-[11px]">
        <thead>
          <tr>
            <th className="w-12 text-left font-medium text-muted" />
            {MONTHS.map((m) => <th key={m} className="font-medium text-muted">{m}</th>)}
            <th className="font-semibold text-ink2">Année</th>
          </tr>
        </thead>
        <tbody>
          {years.map((y) => {
            const yr = yearly.find((x) => x.year === y)?.strategy ?? null;
            return (
              <tr key={y}>
                <td className="num pr-2 font-medium text-ink2">{y}</td>
                {MONTHS.map((_, i) => {
                  const v = get(y, i + 1);
                  return (
                    <td key={i} title={v == null ? "" : `${MONTHS[i]} ${y} : ${spct(v)}`} className="num h-7 rounded-[4px] text-center text-ink" style={{ background: bg(v) }}>
                      {v == null ? "" : (v * 100).toFixed(1).replace(".", ",")}
                    </td>
                  );
                })}
                <td className="num rounded-[4px] border border-line text-center font-semibold" style={{ background: bg(yr) }}>{spct(yr)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-muted">Rendements mensuels en %. Vert : hausse, rouge : baisse ; l'intensité suit l'amplitude.</p>
    </div>
  );
}

export function YearlyBars({ rows, benchName, height = 220 }: { rows: { year: number; strategy: number | null; benchmark: number | null }[]; benchName: string; height?: number }) {
  const c = useChartColors();
  return (
    <div>
      <div className="mb-3"><Legend items={[{ color: c["c-1"], label: "Stratégie", area: true }, { color: c["c-bench"], label: benchName, area: true }]} /></div>
      <div style={{ height }} role="img" aria-label="Performance annuelle comparée">
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barGap={2} barCategoryGap="25%">
            <CartesianGrid vertical={false} stroke={c["c-grid"]} />
            <XAxis dataKey="year" {...axisProps} minTickGap={8} />
            <YAxis width={56} tickFormatter={(v) => pct(v)} {...axisProps} />
            <ReferenceLine y={0} stroke={c["c-axis"]} />
            <Tooltip cursor={{ fill: "rgb(var(--raised))" }} content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TipBox title={String(label)} rows={[
                  { color: c["c-1"], label: "Stratégie", value: spct(payload[0].payload.strategy) },
                  { color: c["c-bench"], label: benchName, value: spct(payload[0].payload.benchmark) },
                ]} />
              ) : null} />
            <Bar dataKey="strategy" fill={c["c-1"]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="benchmark" fill={c["c-bench"]} fillOpacity={0.7} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function AllocationChart({ history, names, height = 260 }: { history: { date: string; weights: Record<string, number>; cash: number }[]; names: Record<string, string>; height?: number }) {
  const c = useChartColors();
  const { data, keys } = useMemo(() => {
    const avg: Record<string, number> = {};
    for (const h of history) for (const [s, w] of Object.entries(h.weights)) avg[s] = (avg[s] ?? 0) + w;
    // At most 7 named series; the rest fold into "Autres" so no colour is ever generated.
    const top = Object.keys(avg).sort((a, b) => avg[b] - avg[a]).slice(0, 7);
    const data = history.map((h) => {
      const row: Record<string, number | string> = { d: h.date, cash: Math.max(h.cash, 0) };
      let other = 0;
      for (const [s, w] of Object.entries(h.weights)) {
        if (top.includes(s)) row[s] = w;
        else other += w;
      }
      row.other = other;
      return row;
    });
    return { data, keys: top };
  }, [history]);
  const colorOf = (i: number) => c.series[i];
  const label = (k: string) => (k === "other" ? "Autres" : k === "cash" ? "Liquidités" : names[k] ?? k);
  return (
    <div>
      <div className="mb-3">
        <Legend items={[
          ...keys.map((k, i) => ({ color: colorOf(i), label: label(k), area: true })),
          { color: c["c-bench"], label: "Autres", area: true },
          { color: c["c-invested"], label: "Liquidités", area: true },
        ]} />
      </div>
      <div style={{ height }} role="img" aria-label="Évolution de l'allocation du portefeuille">
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} stackOffset="expand">
            <XAxis dataKey="d" tickFormatter={fmtDateTick} {...axisProps} />
            <YAxis width={48} tickFormatter={(v) => pct(v)} {...axisProps} />
            <Tooltip content={({ active, payload, label: l }) =>
              active && payload?.length ? (
                <TipBox title={dateLabel(l)} rows={[...payload].reverse().filter((p) => (p.value as number) > 0.0005).map((p) => ({
                  color: p.color as string, label: label(p.dataKey as string), value: pct(p.value as number),
                }))} />
              ) : null} />
            {keys.map((k, i) => (
              <Area key={k} type="stepAfter" dataKey={k} stackId="1" stroke="rgb(var(--surface))" strokeWidth={1} fill={colorOf(i)} fillOpacity={0.9} isAnimationActive={false} />
            ))}
            <Area type="stepAfter" dataKey="other" stackId="1" stroke="rgb(var(--surface))" strokeWidth={1} fill={c["c-bench"]} fillOpacity={0.6} isAnimationActive={false} />
            <Area type="stepAfter" dataKey="cash" stackId="1" stroke="rgb(var(--surface))" strokeWidth={1} fill={c["c-invested"]} fillOpacity={0.5} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function CompareChart({ items, metric, height = 340 }: { items: { id: string; label: string; dates: string[]; values: number[]; bench?: boolean }[]; metric: "twr" | "drawdown"; height?: number }) {
  const c = useChartColors();
  const color = (i: number) => (items[i].bench ? c["c-bench"] : c.series[i]);
  const data = useMemo(() => {
    const map = new Map<string, Record<string, number | string>>();
    items.forEach((it) => it.dates.forEach((d, i) => {
      const row = map.get(d) ?? { d };
      row[it.id] = metric === "twr" ? it.values[i] * 100 : it.values[i];
      map.set(d, row);
    }));
    return thin([...map.values()].sort((a, b) => String(a.d).localeCompare(String(b.d))));
  }, [items, metric]);
  const fmt = (v: number) => (metric === "twr" ? v.toFixed(1).replace(".", ",") : pct(v));
  return (
    <div>
      <div className="mb-3"><Legend items={items.map((it, i) => ({ color: color(i), label: it.label, dashed: it.bench }))} /></div>
      <div style={{ height }} role="img" aria-label="Comparaison des stratégies">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={c["c-grid"]} />
            <XAxis dataKey="d" tickFormatter={fmtDateTick} {...axisProps} />
            <YAxis width={56} tickFormatter={(v) => (metric === "twr" ? String(Math.round(v)) : pct(v))} {...axisProps} domain={["auto", "auto"]} />
            <Tooltip cursor={{ stroke: c["c-axis"], strokeDasharray: "3 3" }} content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TipBox title={dateLabel(label)} rows={items.map((it, i) => ({
                  color: color(i), label: it.label, dashed: it.bench, value: payload[0].payload[it.id] == null ? "—" : fmt(payload[0].payload[it.id] as number),
                }))} />
              ) : null} />
            {items.map((it, i) => (
              <Line key={it.id} type="monotone" dataKey={it.id} stroke={color(i)} strokeWidth={it.bench ? 1.5 : 2} strokeDasharray={it.bench ? "4 3" : undefined} dot={false} connectNulls isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function Sparkline({ values, width = 96, height = 28 }: { values: number[]; width?: number; height?: number }) {
  const c = useChartColors();
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - 2 - ((v - min) / (max - min || 1)) * (height - 4)}`).join(" ");
  const up = values[values.length - 1] >= values[0];
  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={up ? c["c-pos"] : c["c-neg"]} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function ValueChart({ dates, values, height = 260, label = "Cours" }: { dates: string[]; values: number[]; height?: number; label?: string }) {
  const c = useChartColors();
  const data = useMemo(() => thin(dates.map((d, i) => ({ d, v: values[i] }))), [dates, values]);
  return (
    <div style={{ height }} role="img" aria-label={label}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={c["c-grid"]} />
          <XAxis dataKey="d" tickFormatter={fmtDateTick} {...axisProps} />
          <YAxis width={60} tickFormatter={(v) => short(v)} {...axisProps} domain={["auto", "auto"]} />
          <Tooltip cursor={{ stroke: c["c-axis"], strokeDasharray: "3 3" }} content={({ active, payload }) =>
            active && payload?.length ? <TipBox title={dateLabel(payload[0].payload.d)} rows={[{ color: c["c-1"], label, value: (payload[0].payload.v as number).toFixed(2).replace(".", ",") }]} /> : null} />
          <Area type="monotone" dataKey="v" stroke={c["c-1"]} strokeWidth={2} fill={c["c-1"]} fillOpacity={0.08} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
