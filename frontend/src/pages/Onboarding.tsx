import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, ArrowRight, Check, Play, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { KindIcon } from "../components/KindIcon";
import { ErrorNote, Field, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { eur, pct, tone } from "../lib/format";
import { useBenchmarks, useCatalog, useStrategies } from "../lib/queries";
import type { BacktestFull, BacktestRow } from "../lib/types";

const STEPS = ["Bienvenue", "Stratégie", "Indice", "Capital", "Simulation"];
const yearsAgo = (n: number) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); };

export function OnboardingPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const strategies = useStrategies();
  const catalog = useCatalog();
  const benchmarks = useBenchmarks();
  const [step, setStep] = useState(0);
  const [sid, setSid] = useState<string | null>(null);
  const [bench, setBench] = useState<string | null>(null);
  const [capital, setCapital] = useState(10000);
  const [monthly, setMonthly] = useState(200);
  const [years, setYears] = useState(10);
  const [btId, setBtId] = useState<string | null>(null);

  const templates = (strategies.data ?? []).filter((s) => s.is_template && s.status === "active");
  const chosen = templates.find((s) => s.id === sid);
  useEffect(() => { if (chosen?.definition && !bench) setBench(chosen.definition.benchmark); }, [chosen, bench]);

  const markDone = () => api("/auth/me", { method: "PATCH", body: { preferences: { onboarded: true } } }).then(() => qc.invalidateQueries({ queryKey: ["me"] })).catch(() => undefined);
  const run = useMutation({
    mutationFn: () => api<BacktestRow>("/backtests", { method: "POST", body: {
      strategy_id: sid, start: yearsAgo(years), end: new Date().toISOString().slice(0, 10), initial_capital: capital,
      contributions: monthly > 0 ? { amount: monthly, frequency: "monthly" } : { amount: 0, frequency: "none" },
      benchmark: bench, name: `Première simulation · ${chosen?.name}`,
    } }),
    onSuccess: (b) => { setBtId(b.id); markDone(); },
  });
  const bt = useQuery({
    queryKey: ["backtest", btId], queryFn: () => api<BacktestFull>(`/backtests/${btId}`), enabled: !!btId,
    refetchInterval: (q) => (q.state.data && ["queued", "running"].includes(q.state.data.status) ? 800 : false),
  });

  const canNext = [true, !!sid, !!bench, capital > 0 || monthly > 0, false][step];
  const r = bt.data?.results;
  return (
    <div className="mx-auto max-w-3xl">
      <ol className="mb-8 flex items-center gap-2" aria-label="Étapes">
        {STEPS.map((s, i) => (
          <li key={s} className="flex flex-1 items-center gap-2">
            <span className={clsx("flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition",
              i < step ? "border-accent bg-accent text-accent-ink" : i === step ? "border-accent text-accent" : "border-line text-muted")}
              aria-current={i === step ? "step" : undefined}>
              {i < step ? <Check size={14} /> : i + 1}
            </span>
            <span className={clsx("hidden text-xs font-medium sm:block", i === step ? "text-ink" : "text-muted")}>{s}</span>
            {i < STEPS.length - 1 && <span className={clsx("h-px flex-1", i < step ? "bg-accent" : "bg-line")} />}
          </li>
        ))}
      </ol>

      <div className="card p-6 sm:p-8 [animation:fadein_.3s_ease-out]" key={step}>
        {step === 0 && (
          <div className="py-4 text-center">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-accent"><Sparkles size={26} /></div>
            <h1 className="text-2xl font-semibold tracking-tight">Bienvenue sur My2cents{user ? `, ${user.display_name}` : ""}</h1>
            <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-ink2">
              En quatre choix, vous allez voir ce qu'une stratégie d'investissement aurait donné sur les dernières années, face à un indice de référence —
              avec chaque achat et chaque vente expliqués. Il s'agit d'une simulation sur données historiques réelles, pas d'une promesse de rendement.
            </p>
          </div>
        )}

        {step === 1 && (
          <>
            <h2 className="text-xl font-semibold tracking-tight">Choisissez une stratégie</h2>
            <p className="mb-5 mt-1 text-sm text-muted">Vous pourrez en tester et en créer d'autres ensuite.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {templates.map((s) => {
                const k = catalog.data?.find((x) => x.kind === s.kind);
                return (
                  <button key={s.id} type="button" onClick={() => { setSid(s.id); setBench(null); }} aria-pressed={sid === s.id}
                    className={clsx("rounded-xl border p-4 text-left transition", sid === s.id ? "border-accent bg-accent/10" : "border-line hover:border-accent/40 hover:bg-raised")}>
                    <div className="flex items-center gap-2 font-medium"><KindIcon kind={s.kind} size={16} />{s.name}</div>
                    <p className="mt-1.5 text-xs leading-relaxed text-ink2">{s.description}</p>
                    {k && <div className="mt-2 text-[11px] text-muted">{k.horizon} · risque {["", "faible", "moyen", "élevé"][k.risk_level]}</div>}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="text-xl font-semibold tracking-tight">Face à quel indice ?</h2>
            <p className="mb-5 mt-1 text-sm text-muted">La stratégie sera comparée à cet indice, qui reçoit exactement les mêmes versements.</p>
            <div className="space-y-2">
              {benchmarks.data?.filter((b) => b.available).map((b) => (
                <label key={b.symbol} className={clsx("flex cursor-pointer gap-3 rounded-xl border p-3.5 transition", bench === b.symbol ? "border-accent bg-accent/10" : "border-line hover:bg-raised")}>
                  <input type="radio" name="bench" className="mt-1" checked={bench === b.symbol} onChange={() => setBench(b.symbol)} />
                  <span>
                    <span className="text-sm font-medium">{b.label}</span>
                    {b.symbol === chosen?.definition?.benchmark && <span className="chip ml-2 border-accent/40 text-accent">Recommandé pour cette stratégie</span>}
                    <span className="mt-0.5 block text-xs text-muted">{b.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2 className="text-xl font-semibold tracking-tight">Définissez votre capital</h2>
            <p className="mb-6 mt-1 text-sm text-muted">Un montant de départ, et éventuellement un versement mensuel automatique.</p>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Capital de départ (€)"><input type="number" min={0} step={500} className="input num h-11 text-base" value={capital} onChange={(e) => setCapital(Number(e.target.value))} /></Field>
              <Field label="Versement mensuel (€)" hint="0 = pas de versement"><input type="number" min={0} step={50} className="input num h-11 text-base" value={monthly} onChange={(e) => setMonthly(Number(e.target.value))} /></Field>
            </div>
            <div className="mt-6">
              <span className="label">Depuis</span>
              <div className="flex flex-wrap gap-2">
                {[3, 5, 10, 15, 20].map((n) => (
                  <button key={n} type="button" onClick={() => setYears(n)} aria-pressed={years === n}
                    className={clsx("rounded-lg border px-4 py-2 text-sm font-medium", years === n ? "border-accent bg-accent/10 text-ink" : "border-line text-ink2 hover:bg-raised")}>{n} ans</button>
                ))}
              </div>
            </div>
            <p className="mt-6 rounded-xl bg-raised px-4 py-3 text-sm text-ink2">
              Total versé sur la période : <b className="num text-ink">{eur(capital + monthly * 12 * years)}</b>
            </p>
          </>
        )}

        {step === 4 && (
          <div className="py-2">
            {!btId ? (
              <>
                <h2 className="text-xl font-semibold tracking-tight">Prêt à lancer votre première simulation</h2>
                <ul className="mt-5 space-y-2 text-sm text-ink2">
                  <li><span className="text-muted">Stratégie :</span> {chosen?.name}</li>
                  <li><span className="text-muted">Indice :</span> {benchmarks.data?.find((b) => b.symbol === bench)?.label}</li>
                  <li><span className="text-muted">Capital :</span> {eur(capital)}{monthly > 0 && ` puis ${eur(monthly)} par mois`}, depuis {years} ans</li>
                </ul>
                <ErrorNote error={run.error} />
                <button className="btn-primary mt-6 h-11 px-6 text-[15px]" onClick={() => run.mutate()} disabled={run.isPending}><Play size={16} /> Lancer la simulation</button>
              </>
            ) : !bt.data || ["queued", "running"].includes(bt.data.status) ? (
              <div className="flex flex-col items-center py-10 text-center">
                <Spinner className="h-7 w-7" />
                <div className="mt-4 font-medium" aria-live="polite">{bt.data?.progress_message ?? "Préparation…"}</div>
                <div className="mt-4 h-1.5 w-64 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(4, (bt.data?.progress ?? 0) * 100)}%` }} /></div>
              </div>
            ) : bt.data.status === "failed" ? <ErrorNote error={bt.data.error} /> : r && (
              <div className="text-center">
                <div className="eyebrow">Résultat simulé</div>
                <div className="num mt-3 text-4xl font-semibold tracking-tight">{eur(r.summary.strategy.final_value)}</div>
                <p className="num mt-2 text-sm text-ink2">pour {eur(r.summary.strategy.total_invested)} versés · <b className={tone(r.summary.strategy.cagr)}>{pct(r.summary.strategy.cagr)}</b> par an, contre{" "}
                  <b className="text-ink">{pct(r.summary.benchmark.cagr)}</b> pour l'indice</p>
                <p className="mx-auto mt-4 max-w-md text-xs text-muted">Les performances passées ne préjugent pas des performances futures. Le rapport détaille les hypothèses et explique chaque décision.</p>
                <div className="mt-6 flex flex-wrap justify-center gap-3">
                  <button className="btn-primary" onClick={() => nav(`/backtests/${btId}`)}>Voir le rapport complet <ArrowRight size={15} /></button>
                  <Link to="/" className="btn-outline">Aller au tableau de bord</Link>
                </div>
              </div>
            )}
          </div>
        )}

        {step < 4 && (
          <div className="mt-8 flex items-center justify-between border-t border-line pt-5">
            {step > 0 ? <button className="btn-ghost" onClick={() => setStep(step - 1)}><ArrowLeft size={15} /> Retour</button>
              : <button className="btn-ghost text-muted" onClick={() => { markDone(); nav("/"); }}>Passer</button>}
            <button className="btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>{step === 0 ? "Commencer" : "Continuer"} <ArrowRight size={15} /></button>
          </div>
        )}
      </div>
    </div>
  );
}
