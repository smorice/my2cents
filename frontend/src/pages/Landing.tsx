import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BookOpenCheck, GitCompareArrows, LineChart, Moon, Scale, ShieldCheck, Sun } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Link } from "react-router-dom";
import { Legend } from "../components/charts";
import { Logo } from "../components/Logo";
import { Spinner } from "../components/ui";
import { api } from "../lib/api";
import { date, dateTime, eur, monthYear, pct, short, tone } from "../lib/format";
import { setTheme, useChartColors, useTheme } from "../lib/theme";

interface Showcase {
  title: string; asset: string; benchmark: string; start: string; end: string; data_as_of: string | null;
  summary: { final_value: number; total_invested: number; net_profit: number; irr: number | null; cagr: number | null; max_drawdown: number | null; volatility: number | null };
  benchmark_summary: { final_value: number; cagr: number | null; max_drawdown: number | null };
  series: { dates: string[]; equity: number[]; invested: number[]; benchmark_equity: number[] };
  assumptions: string[];
}

function ShowcaseChart({ s }: { s: Showcase }) {
  const c = useChartColors();
  const data = useMemo(() => s.series.dates.map((d, i) => ({ d, v: s.series.equity[i], b: s.series.benchmark_equity[i], inv: s.series.invested[i] })), [s]);
  return (
    <div>
      <div className="mb-3"><Legend items={[{ color: c["c-1"], label: s.asset }, { color: c["c-bench"], label: `${s.benchmark} (mêmes versements)`, dashed: true }, { color: c["c-invested"], label: "Capital versé", area: true }]} /></div>
      <div className="h-[260px] sm:h-[300px]" role="img" aria-label={`Simulation : ${s.title}, comparée à ${s.benchmark}`}>
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={c["c-grid"]} />
            <XAxis dataKey="d" tickFormatter={monthYear} tickLine={false} axisLine={false} minTickGap={50} />
            <YAxis width={52} tickFormatter={(v) => short(v)} tickLine={false} axisLine={false} />
            <Tooltip content={({ active, payload }) => active && payload?.length ? (
              <div className="rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs shadow-card">
                <div className="mb-1 font-medium">{date(payload[0].payload.d)}</div>
                <div className="num flex justify-between gap-6"><span className="text-ink2">Portefeuille</span><b>{eur(payload[0].payload.v)}</b></div>
                <div className="num flex justify-between gap-6"><span className="text-ink2">{s.benchmark}</span><span>{eur(payload[0].payload.b)}</span></div>
                <div className="num flex justify-between gap-6"><span className="text-ink2">Versé</span><span>{eur(payload[0].payload.inv)}</span></div>
              </div>
            ) : null} />
            <Area type="stepAfter" dataKey="inv" stroke="none" fill={c["c-invested"]} fillOpacity={0.35} isAnimationActive={false} />
            <Area type="monotone" dataKey="b" stroke={c["c-bench"]} strokeDasharray="4 3" strokeWidth={1.5} fill="none" isAnimationActive={false} />
            <Area type="monotone" dataKey="v" stroke={c["c-1"]} strokeWidth={2} fill={c["c-1"]} fillOpacity={0.1} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Pillar({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="card p-6">
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent">{icon}</div>
      <h3 className="font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink2">{children}</p>
    </div>
  );
}

export function LandingPage() {
  const theme = useTheme();
  const q = useQuery({ queryKey: ["showcase"], queryFn: () => api<Showcase>("/public/showcase"), staleTime: 3600_000, retry: 1 });
  const s = q.data;
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 border-b border-line/70 bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <nav className="flex items-center gap-1 sm:gap-2">
            <button className="btn-ghost px-2" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? "Passer au thème clair" : "Passer au thème sombre"}>
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <Link to="/login" className="btn-ghost">Se connecter</Link>
            <Link to="/register" className="btn-primary hidden sm:inline-flex">Créer un compte</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pt-24">
          <div className="max-w-3xl [animation:fadein_.5s_ease-out]">
            <div className="eyebrow mb-4">Laboratoire de stratégies d'investissement</div>
            <h1 className="text-4xl font-semibold leading-[1.08] tracking-tight sm:text-6xl">
              Investir dans le futur<br /><span className="text-accent">en comprenant le passé.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink2">
              Testez, comparez et simulez des stratégies d'investissement à partir de données historiques.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/research" className="btn-primary h-11 px-5 text-[15px]">Explorer les stratégies <ArrowRight size={16} /></Link>
              <a href="#simulation" className="btn-outline h-11 px-5 text-[15px]"><LineChart size={16} /> Voir une simulation</a>
            </div>
          </div>
        </section>

        <section id="simulation" className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-20 sm:px-6">
          <div className="card overflow-hidden">
            <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[1fr_300px]">
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="chip border-pos/30 text-pos">Données réelles</span>
                  <span className="chip border-accent/40 text-accent">Simulation</span>
                </div>
                <h2 className="mt-2 text-xl font-semibold tracking-tight">{s ? `${s.title}, sur 10 ans` : "Une simulation sur données historiques"}</h2>
                <p className="mb-6 mt-1 text-sm text-muted">{s ? `Du ${date(s.start)} au ${date(s.end)}, comparé à ${s.benchmark} recevant les mêmes versements.` : " "}</p>
                {q.isLoading ? <div className="flex h-[300px] items-center justify-center"><Spinner /></div>
                  : s ? <ShowcaseChart s={s} />
                  : <div className="flex h-[300px] items-center justify-center rounded-xl border border-dashed border-line text-sm text-muted">Données historiques en cours de chargement : la simulation sera disponible sous peu.</div>}
              </div>
              {s && (
                <aside className="space-y-5 lg:border-l lg:border-line lg:pl-8">
                  <div>
                    <div className="text-xs text-muted">Valeur finale simulée</div>
                    <div className="num mt-1 text-3xl font-semibold tracking-tight">{eur(s.summary.final_value)}</div>
                    <div className="num text-xs text-muted">pour {eur(s.summary.total_invested)} versés</div>
                  </div>
                  <dl className="grid grid-cols-2 gap-4 text-sm">
                    <div><dt className="text-xs text-muted">Rendement annuel (TRI)</dt><dd className={`num font-semibold ${tone(s.summary.irr)}`}>{pct(s.summary.irr)}</dd></div>
                    <div><dt className="text-xs text-muted">Pire baisse</dt><dd className="num font-semibold">{pct(s.summary.max_drawdown)}</dd></div>
                    <div><dt className="text-xs text-muted">CAGR</dt><dd className="num font-semibold">{pct(s.summary.cagr)}</dd></div>
                    <div><dt className="text-xs text-muted">CAGR de l'indice</dt><dd className="num font-semibold text-ink2">{pct(s.benchmark_summary.cagr)}</dd></div>
                  </dl>
                  <ul className="space-y-1.5 border-t border-line pt-4 text-xs leading-relaxed text-muted">
                    {s.assumptions.map((a) => <li key={a}>· {a}</li>)}
                    {s.data_as_of && <li>· Données mises à jour le {dateTime(s.data_as_of)}.</li>}
                  </ul>
                </aside>
              )}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Pillar icon={<BookOpenCheck size={20} />} title="Comprendre">Testez vos hypothèses. Chaque stratégie est décrite en clair, avec ses paramètres, ses risques et son horizon.</Pillar>
            <Pillar icon={<GitCompareArrows size={20} />} title="Comparer">Comparez vos stratégies aux benchmarks — CAC 40, S&P 500, Nasdaq-100, MSCI World — sur exactement la même période.</Pillar>
            <Pillar icon={<LineChart size={20} />} title="Simuler">Visualisez l'évolution d'un portefeuille avec versements programmés, frais, slippage et fiscalité.</Pillar>
            <Pillar icon={<Scale size={20} />} title="Décider">Comprenez les hypothèses et les risques : chaque achat et chaque vente simulés sont expliqués, chiffres à l'appui.</Pillar>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
          <div className="card grid gap-6 p-6 sm:p-8 md:grid-cols-[auto_1fr]">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-warn/15 text-warn"><ShieldCheck size={22} /></div>
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Les performances passées ne garantissent pas les performances futures.</h2>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink2">
                My2cents est un outil de recherche, de simulation et d'analyse — pas un conseil en investissement. Un backtest rejoue le passé
                avec des hypothèses : frais, slippage, dividendes réinvestis, fiscalité simplifiée, univers d'actifs actuel (biais du survivant).
                Ces hypothèses sont affichées avec chaque résultat. Aucune donnée fictive n'est présentée comme réelle.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link to="/register" className="btn-primary">Créer un compte gratuit <ArrowRight size={15} /></Link>
                <Link to="/login" className="btn-outline">J'ai déjà un compte</Link>
              </div>
            </div>
          </div>
        </section>
      </main>
      <footer className="border-t border-line py-8 text-center text-xs text-muted">My2cents · nayonne.ovh · Simulation sur données historiques, sans garantie de performance future.</footer>
    </div>
  );
}
