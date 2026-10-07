import clsx from "clsx";
import { ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { KindIcon } from "../components/KindIcon";
import { Loading, PageHeader, Segmented } from "../components/ui";
import { pct, tone } from "../lib/format";
import { useBenchmarks, useCatalog, useStrategies } from "../lib/queries";

const LEVEL = ["", "Faible", "Moyen", "Élevé"];
const COMPLEXITY = ["", "Simple", "Intermédiaire", "Avancée"];

function Meter({ n, label, text }: { n: number; label: string; text: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-1 flex items-center gap-2" aria-label={`${label} : ${text}`}>
        <span className="flex gap-0.5">{[1, 2, 3].map((i) => <span key={i} className={clsx("h-1.5 w-3.5 rounded-full", i <= n ? "bg-accent" : "bg-line")} />)}</span>
        <span className="text-xs text-ink2">{text}</span>
      </div>
    </div>
  );
}

export function ResearchPage() {
  const catalog = useCatalog();
  const strategies = useStrategies();
  const benchmarks = useBenchmarks();
  const [family, setFamily] = useState("Toutes");
  const [risk, setRisk] = useState<"all" | "1" | "2" | "3">("all");
  const families = useMemo(() => ["Toutes", ...new Set((catalog.data ?? []).map((k) => k.family))], [catalog.data]);
  if (catalog.isLoading || strategies.isLoading) return <Loading />;
  const kinds = (catalog.data ?? []).filter((k) => (family === "Toutes" || k.family === family) && (risk === "all" || String(k.risk_level) === risk));
  return (
    <>
      <PageHeader eyebrow="Research" title="Explorer les stratégies"
        description="Les grandes familles de stratégies, expliquées simplement : comment elles décident, sur quel horizon, avec quels risques. Explorez un modèle prêt à l'emploi ou créez votre variante." />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Famille">
          {families.map((f) => (
            <button key={f} type="button" onClick={() => setFamily(f)} aria-pressed={family === f}
              className={clsx("chip px-3 py-1 text-xs", family === f ? "border-accent/60 bg-accent/10 text-ink" : "hover:text-ink")}>{f}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted">Risque
          <Segmented size="sm" value={risk} onChange={setRisk} options={[{ value: "all", label: "Tous" }, { value: "1", label: "Faible" }, { value: "2", label: "Moyen" }, { value: "3", label: "Élevé" }]} />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {kinds.map((k) => {
          const templates = (strategies.data ?? []).filter((s) => s.is_template && s.kind === k.kind);
          const t = templates[0];
          const bench = t?.definition ? benchmarks.data?.find((b) => b.symbol === t.definition!.benchmark)?.label ?? t.definition.benchmark : "Au choix";
          const last = t?.last_backtest?.summary;
          return (
            <article key={k.kind} className="card flex flex-col p-5 transition hover:border-accent/40 sm:p-6">
              <div className="flex items-start gap-3">
                <KindIcon kind={k.kind} />
                <div className="min-w-0">
                  <div className="eyebrow">{k.family}</div>
                  <h2 className="mt-0.5 font-semibold tracking-tight">{k.name}</h2>
                </div>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-ink2">{k.summary}</p>
              <div className="mt-5 grid grid-cols-2 gap-4 border-t border-line pt-4">
                <Meter n={k.complexity} label="Complexité" text={COMPLEXITY[k.complexity]} />
                <Meter n={k.risk_level} label="Risque" text={LEVEL[k.risk_level]} />
                <div><div className="text-[11px] text-muted">Horizon</div><div className="mt-1 text-xs text-ink2">{k.horizon}</div></div>
                <div><div className="text-[11px] text-muted">Indice de référence</div><div className="mt-1 truncate text-xs text-ink2" title={bench}>{bench}</div></div>
              </div>
              {last && (
                <p className="mt-4 rounded-lg bg-raised px-3 py-2 text-xs text-ink2">
                  Votre dernier backtest du modèle : <b className={clsx("num", tone(last.cagr))}>{pct(last.cagr)}</b> par an, perte max. <b className="num">{pct(last.max_drawdown)}</b>
                </p>
              )}
              <div className="mt-auto flex flex-wrap gap-2 pt-5">
                {t ? <Link to={`/strategies/${t.id}`} className="btn-primary">Explore <ArrowRight size={15} /></Link>
                  : <Link to={`/strategies/new?kind=${k.kind}`} className="btn-primary">Explore <ArrowRight size={15} /></Link>}
                <Link to={`/strategies/new?kind=${k.kind}`} className="btn-ghost">Créer ma variante</Link>
              </div>
              {templates.length > 1 && <p className="mt-2 text-[11px] text-muted">{templates.length} modèles disponibles dans la bibliothèque.</p>}
            </article>
          );
        })}
      </div>
      <p className="mt-10 text-center text-xs text-muted">Description pédagogique des stratégies ; aucune ne constitue une recommandation d'investissement.</p>
    </>
  );
}
