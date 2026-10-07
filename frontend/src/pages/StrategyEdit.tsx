import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Save, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { KindIcon } from "../components/KindIcon";
import { Card, ErrorNote, Field, Loading, Notice, PageHeader, Toggle, toast } from "../components/ui";
import { api } from "../lib/api";
import { FREQ } from "../lib/labels";
import { useCatalog, useInstruments, useUniverses } from "../lib/queries";
import type { Definition, Param, Strategy, StrategyKind } from "../lib/types";

const emptyDef = (k?: StrategyKind): Definition => ({
  parameters: Object.fromEntries((k?.params ?? []).map((p) => [p.key, p.default])),
  universe: { preset: k?.kind === "fixed_allocation" ? null : "cac40", symbols: [] },
  benchmark: k?.kind === "fixed_allocation" ? "CW8.PA" : "^FCHI",
  rebalance_frequency: k?.default_rebalance ?? "monthly",
  transaction_cost_model: { fee_pct: 0.1, fee_min: 0, slippage_bps: 5 },
  risk_model: { max_weight_pct: 100, cash_buffer_pct: 0, stop_loss_pct: 0 },
});

function WeightsEditor({ value, onChange }: { value: Record<string, number>; onChange: (v: Record<string, number>) => void }) {
  const inst = useInstruments();
  const [sym, setSym] = useState("");
  const total = Object.values(value).reduce((a, b) => a + b, 0);
  return (
    <div className="space-y-2">
      {Object.entries(value).map(([s, w]) => (
        <div key={s} className="flex items-center gap-2">
          <span className="num w-24 text-sm font-medium">{s}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{inst.data?.find((i) => i.symbol === s)?.name}</span>
          <input type="number" min={0} max={100} step={1} className="input num w-24" value={w}
            onChange={(e) => onChange({ ...value, [s]: Number(e.target.value) })} aria-label={`Poids ${s}`} />
          <span className="text-xs text-muted">%</span>
          <button type="button" className="btn-ghost h-8 px-2" onClick={() => { const n = { ...value }; delete n[s]; onChange(n); }} aria-label="Retirer"><X size={14} /></button>
        </div>
      ))}
      <div className="flex gap-2">
        <input className="input" list="instr-list" placeholder="Symbole (ex. CW8.PA)" value={sym} onChange={(e) => setSym(e.target.value.toUpperCase())} />
        <button type="button" className="btn-outline" disabled={!sym || sym in value} onClick={() => { onChange({ ...value, [sym]: 0 }); setSym(""); }}><Plus size={14} /> Ajouter</button>
      </div>
      <p className={`num text-xs ${total > 100 ? "text-neg" : "text-muted"}`}>Total : {total.toFixed(1).replace(".", ",")} % {total < 100 && `— ${(100 - total).toFixed(1).replace(".", ",")} % resteront en liquidités`}</p>
    </div>
  );
}

function ParamInput({ p, value, onChange }: { p: Param; value: unknown; onChange: (v: unknown) => void }) {
  if (p.type === "bool") return <Toggle checked={!!value} onChange={onChange} label={p.label} hint={p.help} />;
  if (p.type === "weights") return <Field label={p.label} hint={p.help}><WeightsEditor value={(value as Record<string, number>) ?? {}} onChange={onChange} /></Field>;
  return (
    <Field label={<>{p.label}{p.unit && <span className="font-normal text-muted"> ({p.unit})</span>}</>} hint={p.help}>
      {p.type === "choice" ? (
        <select className="input" value={String(value)} onChange={(e) => onChange(typeof p.default === "number" ? Number(e.target.value) : e.target.value)}>
          {p.choices!.map((c) => <option key={String(c)} value={String(c)}>{String(c)}</option>)}
        </select>
      ) : (
        <input type="number" className="input num" value={value as number} min={p.min} max={p.max} step={p.step ?? (p.type === "int" ? 1 : 0.1)}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />
      )}
    </Field>
  );
}

export function StrategyEditPage() {
  const { id } = useParams();
  const isNew = !id;
  const nav = useNavigate();
  const qc = useQueryClient();
  const cat = useCatalog();
  const universes = useUniverses();
  const instruments = useInstruments();
  const existing = useQuery({ queryKey: ["strategy", id], queryFn: () => api<Strategy>(`/strategies/${id}`), enabled: !isNew });

  const [kind, setKind] = useState<string>("benchmark_outperformance");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [def, setDef] = useState<Definition | null>(null);
  const [note, setNote] = useState("");
  const [symbolInput, setSymbolInput] = useState("");

  const kindSpec = useMemo(() => cat.data?.find((k) => k.kind === kind), [cat.data, kind]);

  useEffect(() => {
    if (!isNew && existing.data && !def) {
      setKind(existing.data.kind);
      setName(existing.data.name);
      setDescription(existing.data.description);
      setDef(existing.data.definition);
    }
  }, [existing.data, isNew, def]);
  useEffect(() => {
    if (isNew && kindSpec) setDef(emptyDef(kindSpec));
  }, [isNew, kindSpec]);

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? api<Strategy>("/strategies", { method: "POST", body: { name, description, kind, definition: def } })
        : api<Strategy>(`/strategies/${id}`, { method: "PUT", body: { name, description, definition: def, change_note: note, expected_version: existing.data?.current_version } }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ["strategies"] });
      qc.setQueryData(["strategy", s.id], s);
      qc.invalidateQueries({ queryKey: ["strategy", s.id, "versions"] });
      toast(isNew ? "Stratégie créée" : `Enregistrée — version ${s.current_version}`);
      nav(`/strategies/${s.id}`);
    },
  });

  if ((!isNew && existing.isLoading) || cat.isLoading) return <Loading />;
  if (!isNew && existing.data && !existing.data.can_edit) return <Notice tone="warn">Vous ne pouvez pas modifier cette stratégie. Clonez-la pour l'adapter.</Notice>;
  if (!def || !kindSpec) return <Loading />;

  const setParam = (k: string, v: unknown) => setDef({ ...def, parameters: { ...def.parameters, [k]: v } });
  const indices = (instruments.data ?? []).filter((i) => i.kind === "index" || i.kind === "etf");
  const addSymbol = () => {
    const s = symbolInput.trim().toUpperCase();
    if (s && !def.universe.symbols.includes(s)) setDef({ ...def, universe: { ...def.universe, symbols: [...def.universe.symbols, s] } });
    setSymbolInput("");
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <PageHeader eyebrow={<Link to={isNew ? "/strategies" : `/strategies/${id}`} className="hover:text-ink">{isNew ? "Stratégies" : existing.data?.name}</Link>}
        title={isNew ? "Nouvelle stratégie" : "Modifier la stratégie"}
        description={isNew ? "Choisissez une famille de stratégie, puis réglez ses paramètres." : `Les changements de définition créeront la version ${existing.data!.current_version + 1} ; la version ${existing.data!.current_version} reste consultable et rejouable.`}
        actions={<button className="btn-primary" disabled={save.isPending || !name.trim()}><Save size={15} /> Enregistrer</button>} />
      <datalist id="instr-list">{instruments.data?.map((i) => <option key={i.symbol} value={i.symbol}>{i.name}</option>)}</datalist>

      <div className="space-y-6">
        {isNew && (
          <Card title="Famille de stratégie">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {cat.data!.map((k) => (
                <button type="button" key={k.kind} onClick={() => setKind(k.kind)}
                  className={`flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors ${kind === k.kind ? "border-accent bg-accent/5" : "border-line hover:bg-raised"}`}>
                  <KindIcon kind={k.kind} />
                  <span className="text-sm font-semibold">{k.name}</span>
                  <span className="text-xs leading-relaxed text-muted">{k.summary}</span>
                </button>
              ))}
            </div>
          </Card>
        )}

        <div className="grid gap-6 xl:grid-cols-2">
          <Card title="Identité">
            <div className="space-y-4">
              <Field label="Nom"><input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Description"><textarea className="input min-h-[96px] py-2" maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
              {!isNew && <Field label="Note de version" hint="Pourquoi ce changement ? Visible dans l'historique."><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="ex. Seuil d'entrée relevé à 7 %" /></Field>}
            </div>
          </Card>
          <Card title={`Paramètres — ${kindSpec.name}`} subtitle={kindSpec.summary}>
            <div className="space-y-4">
              {kindSpec.params.map((p) => <ParamInput key={p.key} p={p} value={def.parameters[p.key]} onChange={(v) => setParam(p.key, v)} />)}
            </div>
          </Card>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <Card title="Univers et référence">
            <div className="space-y-4">
              {kind !== "fixed_allocation" ? (
                <>
                  <Field label="Univers prédéfini">
                    <select className="input" value={def.universe.preset ?? ""} onChange={(e) => setDef({ ...def, universe: { ...def.universe, preset: e.target.value || null } })}>
                      <option value="">Aucun (symboles personnalisés uniquement)</option>
                      {universes.data?.map((u) => <option key={u.key} value={u.key}>{u.label} — {u.symbols.length} actifs</option>)}
                    </select>
                  </Field>
                  <Field label="Symboles supplémentaires" hint="Tickers Yahoo Finance (ex. ALO.PA). Les nouveaux symboles sont téléchargés au premier backtest.">
                    <div className="flex gap-2">
                      <input className="input" list="instr-list" value={symbolInput} onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSymbol(); } }} />
                      <button type="button" className="btn-outline" onClick={addSymbol}><Plus size={14} /></button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {def.universe.symbols.map((s) => (
                        <span key={s} className="chip">{s}<button type="button" onClick={() => setDef({ ...def, universe: { ...def.universe, symbols: def.universe.symbols.filter((x) => x !== s) } })} aria-label={`Retirer ${s}`}><X size={11} /></button></span>
                      ))}
                    </div>
                  </Field>
                </>
              ) : <p className="text-sm text-ink2">L'univers est constitué des actifs de l'allocation.</p>}
              <Field label="Indice de référence (benchmark)">
                <select className="input" value={def.benchmark} onChange={(e) => setDef({ ...def, benchmark: e.target.value })}>
                  {indices.map((i) => <option key={i.symbol} value={i.symbol}>{i.name} ({i.symbol})</option>)}
                  {!indices.some((i) => i.symbol === def.benchmark) && <option value={def.benchmark}>{def.benchmark}</option>}
                </select>
              </Field>
              <Field label="Fréquence de rééquilibrage" hint="Les signaux sont calculés le premier jour de bourse de chaque période.">
                <select className="input" value={def.rebalance_frequency} onChange={(e) => setDef({ ...def, rebalance_frequency: e.target.value })}>
                  {["daily", "weekly", "monthly", "quarterly", "yearly", "never"].map((f) => <option key={f} value={f}>{FREQ[f]}</option>)}
                </select>
              </Field>
            </div>
          </Card>
          <Card title="Frais et risque">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Frais (%)"><input type="number" step={0.01} min={0} max={5} className="input num" value={def.transaction_cost_model.fee_pct} onChange={(e) => setDef({ ...def, transaction_cost_model: { ...def.transaction_cost_model, fee_pct: Number(e.target.value) } })} /></Field>
              <Field label="Frais min (€)"><input type="number" step={0.5} min={0} className="input num" value={def.transaction_cost_model.fee_min} onChange={(e) => setDef({ ...def, transaction_cost_model: { ...def.transaction_cost_model, fee_min: Number(e.target.value) } })} /></Field>
              <Field label="Slippage (pb)"><input type="number" step={1} min={0} className="input num" value={def.transaction_cost_model.slippage_bps} onChange={(e) => setDef({ ...def, transaction_cost_model: { ...def.transaction_cost_model, slippage_bps: Number(e.target.value) } })} /></Field>
              <Field label="Poids max / ligne (%)"><input type="number" step={1} min={1} max={100} className="input num" value={def.risk_model.max_weight_pct} onChange={(e) => setDef({ ...def, risk_model: { ...def.risk_model, max_weight_pct: Number(e.target.value) } })} /></Field>
              <Field label="Réserve cash (%)"><input type="number" step={1} min={0} max={99} className="input num" value={def.risk_model.cash_buffer_pct} onChange={(e) => setDef({ ...def, risk_model: { ...def.risk_model, cash_buffer_pct: Number(e.target.value) } })} /></Field>
              <Field label="Stop-loss (%)" hint="0 = désactivé"><input type="number" step={1} min={0} max={90} className="input num" value={def.risk_model.stop_loss_pct} onChange={(e) => setDef({ ...def, risk_model: { ...def.risk_model, stop_loss_pct: Number(e.target.value) } })} /></Field>
            </div>
            <p className="hint mt-4">Frais typiques : 0,1 % à 0,5 % selon le courtier. Le slippage modélise l'écart entre le cours d'ouverture et le prix réellement obtenu.</p>
          </Card>
        </div>
        <ErrorNote error={save.error} />
      </div>
    </form>
  );
}
