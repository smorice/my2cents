import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { FREQ } from "../lib/labels";
import { Field, Segmented, Toggle } from "./ui";

export interface LaunchConfig {
  start: string;
  end: string;
  initial_capital: number;
  contributions: { amount: number; frequency: string; start: string | null; end: string | null };
  tax_mode: "none" | "pfu";
  tax_rate_pct: number;
  fractional: boolean;
  risk_free_pct: number;
}

const today = () => new Date().toISOString().slice(0, 10);
const yearsAgo = (n: number) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
};

export const defaultLaunch = (): LaunchConfig => ({
  start: yearsAgo(10), end: today(), initial_capital: 10000,
  contributions: { amount: 0, frequency: "none", start: null, end: null },
  tax_mode: "none", tax_rate_pct: 30, fractional: true, risk_free_pct: 2,
});

const PRESETS = [3, 5, 10, 15, 20];

export function BacktestForm({ value, onChange, compact }: { value: LaunchConfig; onChange: (v: LaunchConfig) => void; compact?: boolean }) {
  const [advanced, setAdvanced] = useState(false);
  const set = (p: Partial<LaunchConfig>) => onChange({ ...value, ...p });
  const dca = value.contributions.frequency !== "none";
  return (
    <div className="space-y-5">
      <div>
        <span className="label">Période</span>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {PRESETS.map((n) => (
            <button key={n} type="button" onClick={() => set({ start: yearsAgo(n), end: today() })}
              className={`chip hover:border-accent/50 hover:text-ink ${value.start === yearsAgo(n) && value.end === today() ? "border-accent/60 text-ink" : ""}`}>
              {n} ans
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <input type="date" className="input" value={value.start} max={value.end} onChange={(e) => set({ start: e.target.value })} aria-label="Date de début" />
          <input type="date" className="input" value={value.end} min={value.start} max={today()} onChange={(e) => set({ end: e.target.value })} aria-label="Date de fin" />
        </div>
      </div>
      <div className={compact ? "grid gap-4" : "grid gap-4 sm:grid-cols-2"}>
        <Field label="Capital initial (€)">
          <input type="number" min={0} step={500} className="input num" value={value.initial_capital} onChange={(e) => set({ initial_capital: Number(e.target.value) })} />
        </Field>
        <Field label="Versements programmés" hint={dca ? "Investis selon l'allocation cible, à l'ouverture suivante." : "Simulez un investissement automatique (DCA)."}>
          <div className="flex gap-2">
            <input type="number" min={0} step={50} className="input num w-28" value={value.contributions.amount} disabled={!dca}
              onChange={(e) => set({ contributions: { ...value.contributions, amount: Number(e.target.value) } })} aria-label="Montant du versement" />
            <select className="input" value={value.contributions.frequency}
              onChange={(e) => set({ contributions: { ...value.contributions, frequency: e.target.value, amount: e.target.value !== "none" && !value.contributions.amount ? 500 : value.contributions.amount } })}>
              {["none", "weekly", "monthly", "quarterly"].map((f) => <option key={f} value={f}>{f === "none" ? "Aucun" : FREQ[f]}</option>)}
            </select>
          </div>
        </Field>
      </div>
      {dca && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Début des versements" hint="Vide = début de période">
            <input type="date" className="input" value={value.contributions.start ?? ""} onChange={(e) => set({ contributions: { ...value.contributions, start: e.target.value || null } })} />
          </Field>
          <Field label="Fin des versements" hint="Vide = fin de période">
            <input type="date" className="input" value={value.contributions.end ?? ""} onChange={(e) => set({ contributions: { ...value.contributions, end: e.target.value || null } })} />
          </Field>
        </div>
      )}
      <div>
        <span className="label">Fiscalité</span>
        <Segmented value={value.tax_mode} onChange={(v) => set({ tax_mode: v })}
          options={[{ value: "none", label: "Aucune (PEA)" }, { value: "pfu", label: "Flat tax (CTO)" }]} />
      </div>
      <button type="button" className="flex items-center gap-1 text-xs font-medium text-muted hover:text-ink" onClick={() => setAdvanced(!advanced)}>
        <ChevronDown size={14} className={advanced ? "rotate-180 transition" : "transition"} /> Options avancées
      </button>
      {advanced && (
        <div className="space-y-4 rounded-xl border border-line bg-raised/50 p-4">
          <Toggle checked={value.fractional} onChange={(v) => set({ fractional: v })} label="Fractions d'actions"
            hint="Désactivé : achats en nombre entier d'actions, comme chez la plupart des courtiers." />
          <div className="grid grid-cols-2 gap-3">
            {value.tax_mode === "pfu" && (
              <Field label="Taux d'imposition (%)"><input type="number" step={0.1} min={0} max={60} className="input num" value={value.tax_rate_pct} onChange={(e) => set({ tax_rate_pct: Number(e.target.value) })} /></Field>
            )}
            <Field label="Taux sans risque (%)" hint="Pour Sharpe, Sortino, alpha"><input type="number" step={0.1} className="input num" value={value.risk_free_pct} onChange={(e) => set({ risk_free_pct: Number(e.target.value) })} /></Field>
          </div>
        </div>
      )}
    </div>
  );
}
