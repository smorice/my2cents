import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Copy, History, Pencil, Play, Power, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BacktestForm, defaultLaunch, type LaunchConfig } from "../components/BacktestForm";
import { KindIcon } from "../components/KindIcon";
import { Badge, Card, ErrorNote, Loading, Modal, PageHeader, toast } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dateTime, pct, ratio, tone } from "../lib/format";
import { STATUS } from "../lib/labels";
import { useCatalog, useNames } from "../lib/queries";
import type { BacktestRow, Page, Strategy, Version } from "../lib/types";

function flatten(o: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (o && typeof o === "object" && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o)) Object.assign(out, flatten(v, prefix ? `${prefix}.${k}` : k));
  } else out[prefix] = Array.isArray(o) ? o.join(", ") : String(o);
  return out;
}

const PATH_LABELS: Record<string, string> = {
  benchmark: "Indice", rebalance_frequency: "Rééquilibrage", "universe.preset": "Univers", "universe.symbols": "Symboles",
  "transaction_cost_model.fee_pct": "Frais %", "transaction_cost_model.fee_min": "Frais min", "transaction_cost_model.slippage_bps": "Slippage",
  "risk_model.max_weight_pct": "Poids max", "risk_model.cash_buffer_pct": "Réserve cash", "risk_model.stop_loss_pct": "Stop-loss",
};

function VersionDiff({ prev, cur }: { prev: Version; cur: Version }) {
  const a = flatten(prev.definition), b = flatten(cur.definition);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
  if (!keys.length) return <p className="text-xs text-muted">Aucun changement de définition.</p>;
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {keys.map((k) => (
        <li key={k} className="num flex flex-wrap gap-x-2">
          <span className="text-muted">{PATH_LABELS[k] ?? k.replace("parameters.", "")}</span>
          <span className="text-neg line-through decoration-neg/50">{a[k] ?? "∅"}</span>
          <span className="text-muted">→</span>
          <span className="text-pos">{b[k] ?? "∅"}</span>
        </li>
      ))}
    </ul>
  );
}

function OutperformanceRule({ p, bench }: { p: Record<string, unknown>; bench: string }) {
  const names = useNames();
  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-4 text-sm leading-relaxed">
      <div className="eyebrow mb-2 text-accent">La règle, en une phrase</div>
      Acheter une action si sa performance sur les <b className="num">{String(p.lookback_days)}</b> derniers jours de bourse dépasse
      celle de <b>{names[bench] ?? bench}</b> d'au moins <b className="num">{String(p.entry_threshold_pct)} %</b>.
      La conserver tant que l'écart reste ≥ <b className="num">{String(p.exit_threshold_pct)} %</b>, avec au plus{" "}
      <b className="num">{String(p.max_positions)}</b> lignes simultanées.
    </div>
  );
}

export function StrategyPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const cat = useCatalog();
  const [launch, setLaunch] = useState<LaunchConfig>(defaultLaunch);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const s = useQuery({ queryKey: ["strategy", id], queryFn: () => api<Strategy>(`/strategies/${id}`) });
  const versions = useQuery({ queryKey: ["strategy", id, "versions"], queryFn: () => api<Version[]>(`/strategies/${id}/versions`) });
  const runs = useQuery({
    queryKey: ["backtests", { strategy: id }],
    queryFn: () => api<Page<BacktestRow>>("/backtests", { params: { strategy_id: id, page_size: 10 } }),
    refetchInterval: (q) => (q.state.data?.items.some((b) => b.status === "queued" || b.status === "running") ? 2500 : false),
  });

  const run = useMutation({
    mutationFn: () => api<BacktestRow>("/backtests", { method: "POST", body: { strategy_id: id, ...launch } }),
    onSuccess: (b) => { qc.invalidateQueries({ queryKey: ["backtests"] }); nav(`/backtests/${b.id}`); },
  });
  const clone = useMutation({
    mutationFn: () => api<Strategy>(`/strategies/${id}/clone`, { method: "POST", body: { name: cloneName || null } }),
    onSuccess: (n) => { qc.invalidateQueries({ queryKey: ["strategies"] }); toast("Stratégie clonée"); setCloneOpen(false); nav(`/strategies/${n.id}/edit`); },
  });
  const status = useMutation({
    mutationFn: (st: string) => api<Strategy>(`/strategies/${id}/status`, { method: "POST", body: { status: st } }),
    onSuccess: (n) => { qc.setQueryData(["strategy", id], n); qc.invalidateQueries({ queryKey: ["strategies"] }); toast(`Statut : ${STATUS[n.status].label}`); },
    onError: (e) => toast((e as Error).message, "err"),
  });
  const del = useMutation({
    mutationFn: () => api(`/strategies/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["strategies"] }); toast("Stratégie supprimée"); nav("/strategies"); },
  });

  if (s.isLoading) return <Loading />;
  if (s.error) return <ErrorNote error={s.error} />;
  const st = s.data!;
  const kind = cat.data?.find((k) => k.kind === st.kind);
  const def = st.definition!;
  const disabled = st.status === "inactive" || st.status === "archived";

  return (
    <>
      <PageHeader
        eyebrow={<Link to="/strategies" className="hover:text-ink">Stratégies</Link>}
        title={<span className="flex items-center gap-3"><KindIcon kind={st.kind} size={20} /> {st.name}</span>}
        description={st.description}
        actions={
          <>
            {can("strategy:create") && <button className="btn-outline" onClick={() => { setCloneName(`${st.name} (copie)`); setCloneOpen(true); }}><Copy size={15} /> Cloner</button>}
            {st.can_edit && <Link to={`/strategies/${st.id}/edit`} className="btn-outline"><Pencil size={15} /> Modifier</Link>}
            {st.can_edit && st.status !== "archived" && (
              <button className="btn-ghost" onClick={() => status.mutate(st.status === "active" ? "inactive" : "active")}>
                <Power size={15} /> {st.status === "active" ? "Désactiver" : "Activer"}
              </button>
            )}
            {st.can_edit && (
              <button className="btn-ghost" onClick={() => status.mutate(st.status === "archived" ? "active" : "archived")}>
                <Archive size={15} /> {st.status === "archived" ? "Désarchiver" : "Archiver"}
              </button>
            )}
            {!st.is_template && st.can_edit && can("strategy:delete") && <button className="btn-danger" onClick={() => setConfirmDelete(true)}><Trash2 size={15} /></button>}
          </>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge className={STATUS[st.status].cls}>{STATUS[st.status].label}</Badge>
        <Badge>{kind?.name}</Badge>
        <Badge>Version {st.current_version}</Badge>
        {st.is_template && <Badge className="border-accent/40 text-accent">Modèle</Badge>}
        <span>par {st.author} · modifiée le {dateTime(st.updated_at)}</span>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <div className="space-y-6">
          {st.kind === "benchmark_outperformance" && <OutperformanceRule p={def.parameters} bench={def.benchmark} />}
          <Card title="Comment fonctionne cette stratégie">
            <p className="text-sm leading-relaxed text-ink2">{kind?.explanation}</p>
          </Card>
          <Card title="Règles et paramètres" subtitle={`Version ${st.current_version} — c'est exactement ce que le moteur exécute`}>
            <ul className="space-y-2 text-sm">
              {st.rules.map((r, i) => (
                <li key={i} className="flex gap-3"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent" /><span className="text-ink2">{r}</span></li>
              ))}
            </ul>
          </Card>
          <Card title="Backtests de cette stratégie" pad={false}>
            {runs.data?.items.length ? (
              <div className="overflow-x-auto px-2 pb-3">
                <table className="table-base">
                  <thead><tr><th>Date</th><th>Période</th><th>Version</th><th className="text-right">CAGR</th><th className="text-right">Indice</th><th className="text-right">Max DD</th><th className="text-right">Sharpe</th></tr></thead>
                  <tbody>
                    {runs.data.items.map((b) => (
                      <tr key={b.id} className="cursor-pointer hover:bg-raised/50" onClick={() => nav(`/backtests/${b.id}`)}>
                        <td className="whitespace-nowrap">{dateTime(b.created_at)}{b.status !== "done" && <Badge className={`ml-2 ${STATUS[b.status].cls}`}>{STATUS[b.status].label}</Badge>}</td>
                        <td className="num whitespace-nowrap text-ink2">{b.config.start.slice(0, 4)}–{b.config.end.slice(0, 4)}</td>
                        <td className="num">v{b.strategy_version}</td>
                        <td className={`num text-right ${tone(b.summary?.strategy.cagr)}`}>{pct(b.summary?.strategy.cagr)}</td>
                        <td className="num text-right text-ink2">{pct(b.summary?.benchmark.cagr)}</td>
                        <td className="num text-right">{pct(b.summary?.strategy.max_drawdown)}</td>
                        <td className="num text-right">{ratio(b.summary?.strategy.sharpe)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="px-6 pb-6 text-sm text-muted">Aucun backtest. Lancez le premier depuis le panneau de droite.</p>}
          </Card>
          <Card title={<span className="flex items-center gap-2"><History size={16} /> Historique des versions</span>} subtitle="Les versions sont immuables : une modification crée toujours une nouvelle version.">
            <ol className="relative space-y-5 border-l border-line pl-5">
              {versions.data?.map((v, i, arr) => (
                <li key={v.version} className="relative">
                  <span className={`absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full border-2 border-surface ${v.version === st.current_version ? "bg-accent" : "bg-line"}`} />
                  <div className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className="font-medium">v{v.version}</span>
                    <span className="text-ink2">{v.change_note}</span>
                    <span className="text-xs text-muted">{dateTime(v.created_at)}</span>
                  </div>
                  {arr[i + 1] && <VersionDiff prev={arr[i + 1]} cur={v} />}
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div>
          <div className="card sticky top-6 p-5 sm:p-6">
            <h2 className="flex items-center gap-2 font-semibold"><Play size={16} className="text-accent" /> Lancer un backtest</h2>
            <p className="mb-5 mt-1 text-xs text-muted">Sur la version {st.current_version}, avec les frais et le modèle de risque de la stratégie.</p>
            {disabled ? (
              <p className="text-sm text-ink2">Cette stratégie est {STATUS[st.status].label.toLowerCase()} : réactivez-la pour la tester.</p>
            ) : can("backtest:run") ? (
              <form onSubmit={(e) => { e.preventDefault(); run.mutate(); }} className="space-y-5">
                <BacktestForm value={launch} onChange={setLaunch} compact />
                <ErrorNote error={run.error} />
                <button className="btn-primary h-10 w-full" disabled={run.isPending}><Play size={15} /> Lancer la simulation</button>
              </form>
            ) : <p className="text-sm text-muted">Vous n'avez pas la permission de lancer des backtests.</p>}
          </div>
        </div>
      </div>

      <Modal open={cloneOpen} onClose={() => setCloneOpen(false)} title="Cloner la stratégie">
        <form onSubmit={(e) => { e.preventDefault(); clone.mutate(); }} className="space-y-4">
          <p className="text-sm text-ink2">La copie démarre en version 1 avec la définition actuelle (v{st.current_version}). L'original reste inchangé.</p>
          <input className="input" value={cloneName} onChange={(e) => setCloneName(e.target.value)} autoFocus />
          <ErrorNote error={clone.error} />
          <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={() => setCloneOpen(false)}>Annuler</button><button className="btn-primary" disabled={clone.isPending}>Cloner</button></div>
        </form>
      </Modal>
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Supprimer la stratégie ?">
        <p className="text-sm text-ink2">La stratégie disparaîtra de vos listes. Ses versions et les backtests passés sont conservés pour la traçabilité.</p>
        <ErrorNote error={del.error} />
        <div className="mt-5 flex justify-end gap-2"><button className="btn-ghost" onClick={() => setConfirmDelete(false)}>Annuler</button><button className="btn-danger" onClick={() => del.mutate()} disabled={del.isPending}>Supprimer</button></div>
      </Modal>
    </>
  );
}
