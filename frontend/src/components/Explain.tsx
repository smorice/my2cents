import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowRight, CheckCircle2, LineChart as LineIcon, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../lib/api";
import { date, eur, monthYear, num, pct, short, spct, tone } from "../lib/format";
import { ACTION } from "../lib/labels";
import { useChartColors } from "../lib/theme";
import type { BacktestFull, Check, Decision, Explain, Fact, Page, Trade } from "../lib/types";
import { Legend } from "./charts";
import { Badge, ErrorNote, Loading, Modal } from "./ui";

// ---------------------------------------------------------------------------------------------
// Formatting of explanation values
// ---------------------------------------------------------------------------------------------

export function fmtValue(v: number | null | undefined, fmt: string): string {
  if (v == null) return "—";
  if (fmt === "pct") return spct(v);
  if (fmt === "z") return (v > 0 ? "+" : "") + num(v, 2);
  if (fmt === "int") return String(Math.round(v));
  return num(v, 2);
}

const OP: Record<string, string> = { ">=": "≥", ">": ">", "<=": "≤", "<": "<" };

export const VERDICT: Record<string, string> = {
  buy: "Signal d'achat", increase: "Renforcement", sell: "Signal de vente", decrease: "Allègement", hold: "Position conservée", skip: "Pas de signal",
};

function fillLabel(label: string, names: { asset: string; benchmark: string }) {
  return label.replace("{asset}", names.asset).replace("{benchmark}", names.benchmark);
}

// ---------------------------------------------------------------------------------------------
// Signal card: measured facts → conditions (with thresholds) → verdict
// ---------------------------------------------------------------------------------------------

/** Signed horizontal bars on a shared scale, so "asset vs index" reads at a glance. */
function CompareBars({ facts, names }: { facts: Fact[]; names: { asset: string; benchmark: string } }) {
  const max = Math.max(0.01, ...facts.map((f) => Math.abs(f.value ?? 0)));
  return (
    <div className="space-y-2.5">
      {facts.map((f, i) => {
        const v = f.value ?? 0;
        const w = (Math.abs(v) / max) * 50;
        return (
          <div key={i}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
              <span className="text-ink2">{fillLabel(f.label, names)}</span>
              <span className={clsx("num font-semibold", f.emphasis ? "text-base" : "text-sm", tone(f.value))}>{fmtValue(f.value, f.fmt)}</span>
            </div>
            <div className="relative h-2 rounded-full bg-raised" aria-hidden="true">
              <span className="absolute inset-y-[-3px] left-1/2 w-px bg-line" />
              <span
                className={clsx("absolute inset-y-0 rounded-full", f.subject === "benchmark" || f.subject === "universe" ? "bg-muted/60" : v >= 0 ? "bg-pos" : "bg-neg")}
                style={v >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Where the measured value sits relative to the rule's threshold. */
function Gauge({ c }: { c: Check }) {
  if (c.value == null || c.threshold == null || c.fmt === "int") return null;
  const lo = Math.min(c.value, c.threshold, 0), hi = Math.max(c.value, c.threshold, 0);
  const span = hi - lo || 1;
  const pad = span * 0.15;
  const pos = (x: number) => ((x - lo + pad) / (span + 2 * pad)) * 100;
  return (
    <div className="relative mt-2 h-1.5 rounded-full bg-raised" aria-hidden="true">
      <span className={clsx("absolute inset-y-0 rounded-full", c.passed ? "bg-pos/50" : "bg-neg/40")}
        style={{ left: `${Math.min(pos(0), pos(c.value))}%`, width: `${Math.abs(pos(c.value) - pos(0))}%` }} />
      <span className="absolute -top-1 h-3.5 w-0.5 rounded bg-ink" style={{ left: `${pos(c.threshold)}%` }} title="Seuil" />
      <span className={clsx("absolute -top-[3px] h-3 w-3 -translate-x-1/2 rounded-full border-2 border-surface", c.passed ? "bg-pos" : "bg-neg")}
        style={{ left: `${pos(c.value)}%` }} />
    </div>
  );
}

function CheckRow({ c }: { c: Check }) {
  const Icon = c.passed ? CheckCircle2 : XCircle;
  return (
    <li className="py-2">
      <div className="flex items-start gap-2 text-sm">
        <Icon size={16} className={clsx("mt-0.5 shrink-0", c.passed ? "text-pos" : "text-neg")} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="text-ink2">{c.label}<span className="sr-only"> : {c.passed ? "condition remplie" : "condition non remplie"}</span></span>
            {c.threshold != null && (
              <span className="num whitespace-nowrap text-xs">
                <b className={c.passed ? "text-pos" : "text-neg"}>{fmtValue(c.value, c.fmt ?? "pct")}</b>
                <span className="mx-1 text-muted">{OP[c.op ?? ">="]}</span>
                <span className="text-ink">{fmtValue(c.threshold, c.fmt ?? "pct")}</span>
              </span>
            )}
          </div>
          <Gauge c={c} />
        </div>
      </div>
    </li>
  );
}

export function SignalCard({ action, explain, reason, asset, benchmark, compact }: {
  action: Decision["action"]; explain: Explain | null; reason: string; asset: string; benchmark: string; compact?: boolean;
}) {
  const names = { asset, benchmark };
  if (!explain) {
    // Backtests run before structured explanations existed only have the sentence.
    return <p className="text-sm leading-relaxed text-ink2">{reason}</p>;
  }
  // Asset vs benchmark/universe performances (and the resulting gap) are drawn as bars; the rest is a list.
  const compared = explain.facts.filter((f) => f.fmt === "pct" && f.subject);
  const barFacts = compared.length >= 2 ? explain.facts.filter((f) => f.fmt === "pct" && (f.subject || f.emphasis)) : [];
  const listFacts = explain.facts.filter((f) => !barFacts.includes(f));
  const failed = explain.checks.filter((c) => !c.passed);
  const pos = action === "buy" || action === "increase";
  const neg = action === "sell" || action === "decrease";
  return (
    <div className={clsx("grid gap-4", !compact && "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]")}>
      <div className="space-y-3">
        {barFacts.length > 0 && <CompareBars facts={barFacts} names={names} />}
        {listFacts.length > 0 && (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm">
            {listFacts.map((f, i) => (
              <div key={i} className="contents">
                <dt className="text-ink2">{fillLabel(f.label, names)}</dt>
                <dd className={clsx("num text-right", f.emphasis ? "font-semibold " + (f.fmt === "pct" ? tone(f.value) : "") : "text-ink")}>{fmtValue(f.value, f.fmt)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div>
        {explain.checks.length > 0 && <ul className="-my-2 divide-y divide-line/60">{explain.checks.map((c, i) => <CheckRow key={i} c={c} />)}</ul>}
        <div className={clsx("mt-3 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2.5",
          pos ? "border-pos/30 bg-pos/10" : neg ? "border-neg/30 bg-neg/10" : "border-line bg-raised")}>
          <ArrowRight size={16} className={pos ? "text-pos" : neg ? "text-neg" : "text-muted"} aria-hidden="true" />
          <span className={clsx("text-sm font-semibold uppercase tracking-wide", pos ? "text-pos" : neg ? "text-neg" : "text-ink2")}>{VERDICT[action]}</span>
          <span className="text-xs text-muted">
            {failed.length === 0 ? (explain.checks.length ? "Conditions de la stratégie satisfaites" : "") : `Condition non remplie : ${failed.map((c) => c.label.toLowerCase()).join(", ")}`}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Decision detail: signal + the orders it produced + the context it was taken in
// ---------------------------------------------------------------------------------------------

export function DecisionDetail({ bt, d, names }: { bt: BacktestFull; d: Decision; names: Record<string, string> }) {
  const trades = d.action === "hold" || d.action === "skip";
  const q = useQuery({
    queryKey: ["decision-trades", bt.id, d.seq],
    queryFn: () => api<Page<Trade>>(`/backtests/${bt.id}/transactions`, { params: { decision_seq: d.seq } }),
    enabled: !trades,
  });
  const bench = names[bt.config.benchmark] ?? bt.config.benchmark;
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div>
        <div className="eyebrow mb-3">Pourquoi</div>
        <SignalCard action={d.action} explain={d.explain} reason={d.reason} asset={names[d.symbol] ?? d.symbol} benchmark={bench} />
        {d.explain && <p className="mt-3 text-xs leading-relaxed text-muted">{d.reason}</p>}
      </div>
      <div className="space-y-4 text-sm">
        <div>
          <div className="eyebrow mb-2">Exécution</div>
          {trades ? <p className="text-muted">Aucun ordre : la position n'a pas changé.</p> : q.isLoading ? <Loading label="" /> : q.data?.items.length ? (
            <ul className="space-y-2">
              {q.data.items.map((t) => (
                <li key={t.seq} className="rounded-lg border border-line bg-raised/60 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <Badge className={ACTION[t.side].cls}>{ACTION[t.side].label}</Badge>
                    <span className="num text-xs text-muted">{date(t.date)} · ouverture</span>
                  </div>
                  <div className="num mt-1.5">{num(t.qty, t.qty % 1 ? 3 : 0)} titres × {num(t.price)} € = <b>{eur(t.value)}</b></div>
                  <div className="num text-xs text-muted">Frais {eur(t.fees, true)}{t.tax ? ` · impôt ${eur(t.tax, true)}` : ""}{t.realized_pnl != null ? ` · P/L réalisé ` : ""}
                    {t.realized_pnl != null && <span className={tone(t.realized_pnl)}>{eur(t.realized_pnl)}</span>}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">Aucun ordre exécuté : pas de cotation à l'ouverture suivante, ou écart trop faible pour justifier des frais.</p>
          )}
        </div>
        <div>
          <div className="eyebrow mb-2">Contexte</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted">Décision</dt><dd className="num">{date(d.date)} à la clôture</dd>
            <dt className="text-muted">Stratégie</dt><dd>{bt.strategy_name} · v{bt.strategy_version}</dd>
            <dt className="text-muted">Indice</dt><dd>{bench}</dd>
            <dt className="text-muted">Poids</dt><dd className="num">{pct(d.prev_weight)} → {pct(d.target_weight)}</dd>
            <dt className="text-muted">Paramètres</dt>
            <dd className="num break-words">{Object.entries(bt.config.parameters).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ")}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Asset story: price vs benchmark with every order, and every decision on that asset
// ---------------------------------------------------------------------------------------------

interface AssetDetail {
  symbol: string; name: string; benchmark: string; dates: string[]; price: (number | null)[]; benchmark_price: (number | null)[] | null;
  trades: Trade[]; decisions: Decision[]; realized_pnl: number;
}

const MAX_POINTS = 700;

function AssetChart({ a, benchName }: { a: AssetDetail; benchName: string }) {
  const c = useChartColors();
  const { rows: data, domain } = useMemo(() => {
    const p0 = a.price.find((v) => v != null) ?? 1;
    const b0 = a.benchmark_price?.find((v) => v != null) ?? 1;
    const buys = new Map<string, Trade[]>(), sells = new Map<string, Trade[]>();
    for (const t of a.trades) {
      const m = t.side === "buy" ? buys : sells;
      m.set(t.date, [...(m.get(t.date) ?? []), t]);
    }
    const step = Math.max(1, Math.floor(a.dates.length / MAX_POINTS));
    const rows = [];
    for (let i = 0; i < a.dates.length; i++) {
      const d = a.dates[i];
      const marker = buys.has(d) || sells.has(d);
      if (i % step && i !== a.dates.length - 1 && !marker) continue;
      const v = a.price[i] == null ? null : (a.price[i]! / p0) * 100;
      rows.push({
        d, v, b: a.benchmark_price?.[i] == null ? null : (a.benchmark_price![i]! / b0) * 100,
        buy: buys.has(d) ? v : null, sell: sells.has(d) ? v : null, bt: buys.get(d), st: sells.get(d),
      });
    }
    const vals = rows.flatMap((r) => [r.v, r.b]).filter((x): x is number => x != null);
    return { rows, domain: [Math.floor(Math.min(...vals) * 0.95), Math.ceil(Math.max(...vals) * 1.05)] as [number, number] };
  }, [a]);
  return (
    <div>
      <div className="mb-3">
        <Legend items={[
          { color: c["c-1"], label: `${a.name} (base 100)` }, { color: c["c-bench"], label: benchName, dashed: true },
          { color: c["c-pos"], label: "Achats", area: true }, { color: c["c-neg"], label: "Ventes", area: true },
        ]} />
      </div>
      <div style={{ height: 280 }} role="img" aria-label={`Cours de ${a.name} comparé à ${benchName}, avec les achats et les ventes simulés`}>
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={c["c-grid"]} />
            <XAxis dataKey="d" tickFormatter={monthYear} tickLine={false} axisLine={false} minTickGap={40} />
            <YAxis width={44} tickLine={false} axisLine={false} domain={domain} allowDataOverflow tickFormatter={(v) => String(Math.round(v))} />
            <Tooltip cursor={{ stroke: c["c-axis"], strokeDasharray: "3 3" }} content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const r = payload[0].payload;
              return (
                <div className="min-w-[200px] rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs shadow-card">
                  <div className="mb-1 font-medium">{date(r.d)}</div>
                  <div className="num flex justify-between gap-4"><span className="text-ink2">{a.name}</span><span>{r.v == null ? "—" : num(r.v, 1)}</span></div>
                  <div className="num flex justify-between gap-4"><span className="text-ink2">{benchName}</span><span>{r.b == null ? "—" : num(r.b, 1)}</span></div>
                  {[...(r.bt ?? []), ...(r.st ?? [])].map((t: Trade) => (
                    <div key={t.seq} className={clsx("num mt-1 font-medium", t.side === "buy" ? "text-pos" : "text-neg")}>
                      {ACTION[t.side].label} {eur(t.value)}
                    </div>
                  ))}
                </div>
              );
            }} />
            <Line type="monotone" dataKey="b" stroke={c["c-bench"]} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />
            <Line type="monotone" dataKey="v" stroke={c["c-1"]} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            <Scatter dataKey="buy" fill={c["c-pos"]} shape="triangle" isAnimationActive={false} />
            <Scatter dataKey="sell" fill={c["c-neg"]} shape="diamond" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function AssetStory({ bt, symbol, names, onClose }: { bt: BacktestFull; symbol: string | null; names: Record<string, string>; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["asset", bt.id, symbol],
    queryFn: () => api<AssetDetail>(`/backtests/${bt.id}/assets/${encodeURIComponent(symbol!)}`),
    enabled: !!symbol,
  });
  const [open, setOpen] = useState<number | null>(null);
  const bench = names[bt.config.benchmark] ?? bt.config.benchmark;
  const a = q.data;
  return (
    <Modal open={!!symbol} onClose={onClose} wide title={<span className="flex items-center gap-2"><LineIcon size={16} /> {names[symbol ?? ""] ?? symbol}</span>}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : a && (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <span><span className="text-muted">Ordres </span><b className="num">{a.trades.length}</b></span>
            <span><span className="text-muted">Décisions actives </span><b className="num">{a.decisions.length}</b></span>
            <span><span className="text-muted">P/L réalisé </span><b className={clsx("num", tone(a.realized_pnl))}>{eur(a.realized_pnl)}</b></span>
          </div>
          <AssetChart a={a} benchName={bench} />
          <div>
            <div className="eyebrow mb-2">Décisions sur cet actif</div>
            {a.decisions.length === 0 ? <p className="text-sm text-muted">La stratégie n'a jamais pris position sur cet actif.</p> : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {[...a.decisions].reverse().map((d) => (
                  <li key={d.seq}>
                    <button className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-raised/60" aria-expanded={open === d.seq}
                      onClick={() => setOpen(open === d.seq ? null : d.seq)}>
                      <span className="num w-24 shrink-0 text-ink2">{date(d.date)}</span>
                      <Badge className={ACTION[d.action].cls}>{ACTION[d.action].label}</Badge>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted">{d.reason}</span>
                    </button>
                    {open === d.seq && <div className="border-t border-line bg-raised/30 p-4"><DecisionDetail bt={bt} d={d} names={names} /></div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Trade timeline: money moved at each execution date
// ---------------------------------------------------------------------------------------------

interface TimelineDay { date: string; buy_value: number; sell_value: number; buys: string[]; sells: string[]; contribution_only: boolean }

export function TradeTimeline({ id, names, onAsset }: { id: string; names: Record<string, string>; onAsset?: (s: string) => void }) {
  const c = useChartColors();
  const [withContrib, setWithContrib] = useState(false);
  const q = useQuery({ queryKey: ["timeline", id], queryFn: () => api<TimelineDay[]>(`/backtests/${id}/timeline`) });
  const data = useMemo(() => (q.data ?? []).filter((x) => withContrib || !x.contribution_only).map((x) => ({ ...x, sell: -x.sell_value })), [q.data, withContrib]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const hasContrib = q.data!.some((x) => x.contribution_only);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Legend items={[{ color: c["c-pos"], label: "Achats", area: true }, { color: c["c-neg"], label: "Ventes", area: true }]} />
        {hasContrib && (
          <label className="flex items-center gap-2 text-xs text-ink2">
            <input type="checkbox" checked={withContrib} onChange={(e) => setWithContrib(e.target.checked)} />
            Inclure l'investissement des versements
          </label>
        )}
      </div>
      <div style={{ height: 200 }} role="img" aria-label="Chronologie des ordres : montants achetés et vendus à chaque date d'exécution">
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} stackOffset="sign"
            onClick={(e) => { const p = (e as { activePayload?: { payload: TimelineDay }[] })?.activePayload?.[0]?.payload; if (p && onAsset && p.buys.length + p.sells.length === 1) onAsset([...p.buys, ...p.sells][0]); }}>
            <CartesianGrid vertical={false} stroke={c["c-grid"]} />
            <XAxis dataKey="date" tickFormatter={monthYear} tickLine={false} axisLine={false} minTickGap={40} />
            <YAxis width={56} tickLine={false} axisLine={false} tickFormatter={(v) => short(Math.abs(v))} />
            <ReferenceLine y={0} stroke={c["c-axis"]} />
            <Tooltip cursor={{ fill: "rgb(var(--raised))" }} content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const x = payload[0].payload as TimelineDay;
              const list = (s: string[]) => s.slice(0, 6).map((k) => names[k] ?? k).join(", ") + (s.length > 6 ? ` +${s.length - 6}` : "");
              return (
                <div className="max-w-[280px] rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs shadow-card">
                  <div className="mb-1 font-medium">{date(x.date)}{x.contribution_only ? " · versement" : ""}</div>
                  {x.buys.length > 0 && <div><span className="num font-medium text-pos">+{eur(x.buy_value)}</span> <span className="text-ink2">{list(x.buys)}</span></div>}
                  {x.sells.length > 0 && <div className="mt-0.5"><span className="num font-medium text-neg">−{eur(x.sell_value)}</span> <span className="text-ink2">{list(x.sells)}</span></div>}
                </div>
              );
            }} />
            <Bar dataKey="buy_value" stackId="a" fill={c["c-pos"]} isAnimationActive={false} />
            <Bar dataKey="sell" stackId="a" fill={c["c-neg"]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
