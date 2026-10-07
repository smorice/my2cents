import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Bell, BellOff, Check, ChevronDown, ClipboardList, Pencil, Play, Plus, Settings2, Trash2, Wallet, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { SignalCard } from "../components/Explain";
import { SymbolPicker } from "../components/SymbolPicker";
import { Badge, Card, Empty, ErrorNote, Field, Loading, Modal, Notice, PageHeader, Spinner, Stat, Tabs, Toggle, toast } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { date, dateTime, eur, num, pct, spct, tone } from "../lib/format";
import { useStrategies } from "../lib/queries";
import type { Account, AccountMovement, JobInfo, Proposal, ProposalRow, ProposedOrder } from "../lib/types";

const today = () => new Date().toISOString().slice(0, 10);
const qtyFmt = (q: number) => (Number.isInteger(q) ? String(q) : num(q, 4));

// ---------------------------------------------------------------------------------------------
// Settings form (create + edit)
// ---------------------------------------------------------------------------------------------

interface SettingsState {
  name: string; strategy_id: string; strategy_version: number | null; cash: number;
  fee_pct: number; fee_min: number; fractional: boolean; min_order_value: number; auto_review: boolean; notify_email: boolean;
}

const blank: SettingsState = {
  name: "", strategy_id: "", strategy_version: null, cash: 0, fee_pct: 0.1, fee_min: 0, fractional: false, min_order_value: 50,
  auto_review: true, notify_email: true,
};

function SettingsForm({ initial, creating, onSubmit, pending, error }: {
  initial: SettingsState; creating: boolean; onSubmit: (s: SettingsState) => void; pending: boolean; error: unknown;
}) {
  const [f, setF] = useState(initial);
  const strategies = useStrategies();
  const sel = strategies.data?.find((s) => s.id === f.strategy_id);
  const set = <K extends keyof SettingsState>(k: K, v: SettingsState[K]) => setF({ ...f, [k]: v });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onSubmit(f); }}>
      <Field label="Nom du compte"><input className="input" required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="ex. PEA Boursorama" /></Field>
      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <Field label="Stratégie à suivre" hint="Ses règles décident des ordres proposés.">
          <select className="input" required value={f.strategy_id} onChange={(e) => setF({ ...f, strategy_id: e.target.value, strategy_version: null })}>
            <option value="" disabled>Choisir…</option>
            {strategies.data?.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_template ? " (modèle)" : ""}</option>)}
          </select>
        </Field>
        <Field label="Version" hint="Vide = la dernière">
          <select className="input" value={f.strategy_version ?? ""} onChange={(e) => set("strategy_version", e.target.value ? Number(e.target.value) : null)}>
            <option value="">Dernière</option>
            {sel && Array.from({ length: sel.current_version }, (_, i) => sel.current_version - i).map((v) => <option key={v} value={v}>v{v}</option>)}
          </select>
        </Field>
      </div>
      {creating && (
        <Field label="Liquidités disponibles (€)" hint="Vous saisirez vos titres juste après.">
          <input className="input num" type="number" min={0} step="0.01" value={f.cash} onChange={(e) => set("cash", Number(e.target.value))} />
        </Field>
      )}
      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="label mb-2">Frais de votre courtier</legend>
        <Field label="Frais (%)"><input className="input num" type="number" min={0} max={5} step="0.01" value={f.fee_pct} onChange={(e) => set("fee_pct", Number(e.target.value))} /></Field>
        <Field label="Minimum par ordre (€)"><input className="input num" type="number" min={0} step="0.01" value={f.fee_min} onChange={(e) => set("fee_min", Number(e.target.value))} /></Field>
        <Field label="Ordre minimum (€)" hint="Plus petit : ignoré."><input className="input num" type="number" min={0} step="1" value={f.min_order_value} onChange={(e) => set("min_order_value", Number(e.target.value))} /></Field>
      </fieldset>
      <Toggle checked={f.fractional} onChange={(v) => set("fractional", v)} label="Mon courtier accepte les fractions d'action" hint="Sinon, les quantités proposées sont des nombres entiers." />
      <Toggle checked={f.auto_review} onChange={(v) => set("auto_review", v)} label="Calculer automatiquement chaque soir de semaine" hint="Après la clôture des marchés américains (vers minuit, heure de Paris)." />
      <Toggle checked={f.notify_email} onChange={(v) => set("notify_email", v)} label="M'envoyer un email quand il y a des ordres à passer" />
      <ErrorNote error={error} />
      <div className="flex justify-end"><button className="btn-primary" disabled={pending}>{pending && <Spinner />}{creating ? "Créer le compte" : "Enregistrer"}</button></div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

export function AccountsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  // "Suivre sur un compte réel" from the comparison lands here with the strategy preselected.
  const follow = new URLSearchParams(useLocation().search).get("follow");
  const [open, setOpen] = useState(!!follow);
  const q = useQuery({ queryKey: ["accounts"], queryFn: () => api<Account[]>("/accounts") });
  const create = useMutation({
    mutationFn: (s: SettingsState) => api<Account>("/accounts", { method: "POST", body: s }),
    onSuccess: (a) => nav(`/accounts/${a.id}?setup=1`),
  });
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Comptes réels" title="Ordres à passer"
        description="Vos vrais comptes titres. Une stratégie s'applique à ce que vous détenez réellement et propose les achats et ventes à passer chez votre courtier."
        actions={can("portfolio:write") && <button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} /> Nouveau compte</button>} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : !q.data?.length ? (
        <Empty icon={<Wallet size={22} />} title="Aucun compte réel"
          action={can("portfolio:write") && <button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} /> Créer mon premier compte</button>}>
          Indiquez vos liquidités et vos titres, choisissez une stratégie : My2cents calcule les ordres qui l'appliquent, chaque soir ou à la demande.
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {q.data.map((a) => (
            <Link key={a.id} to={`/accounts/${a.id}`} className="card card-pad block transition hover:border-accent/50">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-ink">{a.name}</h2>
                  <p className="truncate text-sm text-muted">{a.strategy_name ?? "Aucune stratégie"}</p>
                </div>
                {a.pending_orders > 0
                  ? <Badge className="border-accent/40 bg-accent/10 text-accent">{a.pending_orders} ordre{a.pending_orders > 1 ? "s" : ""} à passer</Badge>
                  : <Badge>À jour</Badge>}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <Stat label="Valeur" value={eur(a.total)} />
                <Stat label="Liquidités" value={eur(a.cash)} />
              </div>
              <p className="mt-3 text-xs text-muted">{a.latest_proposal_at ? `Dernier calcul : ${dateTime(a.latest_proposal_at)}` : "Jamais calculé"}</p>
            </Link>
          ))}
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Nouveau compte réel">
        <SettingsForm initial={{ ...blank, strategy_id: follow ?? "" }} creating onSubmit={(s) => create.mutate(s)} pending={create.isPending} error={create.error} />
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

function useReviewJob(account: Account | undefined, onDone: () => void) {
  const [jobId, setJobId] = useState<string | null>(null);
  const id = jobId ?? account?.review_job?.id ?? null;
  const job = useQuery({
    queryKey: ["job", id], enabled: !!id, queryFn: () => api<JobInfo>(`/jobs/${id}`),
    refetchInterval: (q) => (q.state.data && ["completed", "failed"].includes(q.state.data.status) ? false : 1000),
  });
  const status = job.data?.status;
  useEffect(() => {
    if (status === "completed" || status === "failed") {
      onDone();
      if (status === "completed") setJobId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  return { job: job.data, running: !!id && !!job.data && !["completed", "failed"].includes(job.data.status), setJobId };
}

export function AccountPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { can } = useAuth();
  const write = can("portfolio:write");
  const key = ["account", id];
  const q = useQuery({ queryKey: key, queryFn: () => api<Account>(`/accounts/${id}`) });
  const setData = (a: Account) => { qc.setQueryData(key, a); qc.invalidateQueries({ queryKey: ["accounts"] }); qc.invalidateQueries({ queryKey: ["movements", id] }); };
  const refresh = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ["proposals", id] }); qc.invalidateQueries({ queryKey: ["accounts"] }); };
  const { job, running, setJobId } = useReviewJob(q.data, refresh);
  const review = useMutation({
    mutationFn: () => api<JobInfo>(`/accounts/${id}/review`, { method: "POST" }),
    onSuccess: (j) => setJobId(j.id),
  });
  const [modal, setModal] = useState<null | "settings" | "positions" | "movement">(
    new URLSearchParams(location.search).get("setup") ? "positions" : null,
  );
  const patch = useMutation({
    mutationFn: (s: Partial<SettingsState>) => api<Account>(`/accounts/${id}`, { method: "PATCH", body: s }),
    onSuccess: (a) => { setData(a); setModal(null); toast("Compte enregistré"); },
  });
  const del = useMutation({
    mutationFn: () => api(`/accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["accounts"] }); nav("/accounts"); },
  });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorNote error={q.error} />;
  const a = q.data;
  const prop = a.latest_proposal;
  const pending = prop?.status === "open" ? prop.orders.filter((o) => o.status === "pending").length : 0;

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<Link to="/accounts" className="hover:text-ink">Ordres à passer</Link>} title={a.name}
        description={a.strategy_name
          ? <>Suit la stratégie <Link className="font-medium text-accent hover:underline" to={`/strategies/${a.strategy_id}`}>{a.strategy_name}</Link>
              {a.strategy_version ? ` (v${a.strategy_version})` : ""} · rééquilibrage {a.rebalance_label}</>
          : "Aucune stratégie choisie"}
        actions={write && (
          <div className="flex flex-wrap gap-2">
            <button className="btn-outline" onClick={() => setModal("settings")}><Settings2 size={15} /> Réglages</button>
            <button className="btn-primary" disabled={running || review.isPending || !a.strategy_id} onClick={() => review.mutate()}>
              {running || review.isPending ? <Spinner /> : <Play size={15} />} Calculer les ordres maintenant
            </button>
          </div>
        )} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat className="card card-pad" label="Valeur du compte" value={eur(a.total)} sub="au dernier cours connu" />
        <Stat className="card card-pad" label="Liquidités" value={eur(a.cash)} />
        <Stat className="card card-pad" label="Titres" value={eur(a.invested)} />
        <Stat className="card card-pad" label="Ordres à passer" value={String(pending)} valueClass={pending ? "text-accent" : undefined}
          sub={a.auto_review ? (a.notify_email && a.mail_enabled ? <span className="inline-flex items-center gap-1"><Bell size={12} /> Revue chaque soir + email</span> : "Revue chaque soir") : "Revue manuelle"} />
      </div>

      {a.auto_review && a.notify_email && a.mail_enabled === false && (
        <Notice tone="warn"><BellOff size={14} className="mr-1 inline" /> L'envoi d'emails n'est pas configuré sur le serveur : la revue du soir s'exécute, mais vous ne serez pas prévenu. Consultez cette page.</Notice>
      )}
      {running && job && (
        <Notice>
          <div className="flex items-center gap-2"><Spinner /> <span>{job.message ?? "Calcul en cours"}</span></div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.round(job.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent transition-all" style={{ width: `${Math.max(job.progress * 100, 3)}%` }} />
          </div>
        </Notice>
      )}
      {job?.status === "failed" && <ErrorNote error={new Error(job.error ?? "Le calcul a échoué.")} />}
      <ErrorNote error={review.error} />

      <OrdersCard account={a} proposal={prop ?? null} write={write} onChange={setData} />

      <PositionsCard account={a} write={write} onEdit={() => setModal("positions")} onMovement={() => setModal("movement")} />

      {prop && prop.mode === "full" && <StrategyViewCard proposal={prop} />}

      <HistoryCard account={a} />

      <p className="text-xs leading-relaxed text-muted">
        Les ordres proposés appliquent mécaniquement les règles de la stratégie que vous avez choisie, aux derniers cours connus.
        Ils ne constituent pas un conseil en investissement. Vérifiez chaque ordre, son cours et vos frais avant de le passer chez votre courtier.
      </p>

      <Modal open={modal === "settings"} onClose={() => setModal(null)} title="Réglages du compte">
        <SettingsForm creating={false} initial={{
          name: a.name, strategy_id: a.strategy_id ?? "", strategy_version: a.strategy_version, cash: a.cash, fee_pct: a.fee_pct, fee_min: a.fee_min,
          fractional: a.fractional, min_order_value: a.min_order_value, auto_review: a.auto_review, notify_email: a.notify_email,
        }} onSubmit={({ cash: _cash, ...s }) => patch.mutate(s)} pending={patch.isPending} error={patch.error} />
        <div className="mt-6 border-t border-line pt-4">
          <button className="btn-danger" disabled={del.isPending} onClick={() => { if (confirm(`Supprimer définitivement « ${a.name} » et son historique ?`)) del.mutate(); }}>
            <Trash2 size={15} /> Supprimer ce compte
          </button>
        </div>
      </Modal>
      <Modal open={modal === "positions"} onClose={() => setModal(null)} title="Mes titres et liquidités" wide>
        <PositionsEditor account={a} onSaved={(acc) => { setData(acc); setModal(null); toast("Positions enregistrées"); }} />
      </Modal>
      <Modal open={modal === "movement"} onClose={() => setModal(null)} title="Enregistrer un mouvement">
        <MovementForm account={a} onSaved={(acc) => { setData(acc); setModal(null); toast("Mouvement enregistré"); }} />
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------

function OrdersCard({ account, proposal, write, onChange }: { account: Account; proposal: Proposal | null; write: boolean; onChange: (a: Account) => void }) {
  const [fill, setFill] = useState<ProposedOrder | null>(null);
  const skip = useMutation({
    mutationFn: (o: ProposedOrder) => api<Account>(`/accounts/${account.id}/orders/${o.id}/skip`, { method: "POST" }),
    onSuccess: onChange,
  });
  if (!proposal) {
    return (
      <Card title="Ordres à passer">
        <Empty icon={<ClipboardList size={22} />} title="Pas encore de calcul">
          {account.strategy_id ? "Saisissez vos titres, puis lancez « Calculer les ordres maintenant »." : "Choisissez d'abord une stratégie dans les réglages."}
        </Empty>
      </Card>
    );
  }
  const names = proposal.names;
  const superseded = proposal.status === "superseded";
  return (
    <Card title="Ordres à passer"
      subtitle={<>Calculés {proposal.trigger === "scheduled" ? "automatiquement" : "à la demande"} le {dateTime(proposal.created_at)}, sur les derniers cours connus (séance du <b>{date(proposal.as_of)}</b>)
        {proposal.mode === "light" ? " · hors jour de rééquilibrage : seuls les stop-loss et l'investissement des liquidités sont vérifiés" : ""}</>}>
      {proposal.warnings.length > 0 && (
        <Notice tone="warn"><ul className="list-disc space-y-1 pl-4">{proposal.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></Notice>
      )}
      {proposal.orders.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl border border-line bg-raised px-4 py-4">
          <Check className="text-pos" size={20} aria-hidden="true" />
          <div>
            <p className="font-medium text-ink">Rien à faire</p>
            <p className="text-sm text-muted">Votre compte est conforme à la stratégie : aucun ordre ne dépasse les seuils de rééquilibrage.</p>
          </div>
        </div>
      ) : (
        <ol className="mt-1 space-y-3">
          {proposal.orders.map((o) => (
            <OrderRow key={o.id} o={o} name={names[o.symbol] ?? o.symbol} benchmark={account.benchmark ? names[account.benchmark] ?? account.benchmark : "l'indice"}
              actions={write && o.status === "pending" && !superseded && (
                <div className="flex gap-2">
                  <button className="btn-primary h-9" onClick={() => setFill(o)}><Check size={15} /> J'ai passé l'ordre</button>
                  <button className="btn-ghost h-9" disabled={skip.isPending} onClick={() => skip.mutate(o)}><X size={15} /> Ignorer</button>
                </div>
              )} />
          ))}
        </ol>
      )}
      {proposal.orders.length > 0 && (
        <p className="mt-4 text-sm text-ink2">
          Liquidités estimées après exécution : <span className="num font-medium text-ink">{eur(proposal.cash_after)}</span>
          {" · "}frais estimés : <span className="num">{eur(proposal.orders.reduce((s, o) => s + o.fee_estimate, 0), true)}</span>
        </p>
      )}
      <ErrorNote error={skip.error} />
      <Modal open={!!fill} onClose={() => setFill(null)} title="Enregistrer l'exécution">
        {fill && <FillForm account={account} order={fill} name={names[fill.symbol] ?? fill.symbol} onSaved={(a) => { onChange(a); setFill(null); toast("Ordre enregistré : vos positions sont à jour"); }} />}
      </Modal>
    </Card>
  );
}

const SIDE = { buy: "Acheter", sell: "Vendre" } as const;
const STATUS_LABEL = { executed: "Passé", skipped: "Ignoré", pending: "" } as const;

function OrderRow({ o, name, benchmark, actions }: { o: ProposedOrder; name: string; benchmark: string; actions: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const buy = o.side === "buy";
  return (
    <li className={clsx("rounded-xl border p-4", o.status === "pending" ? "border-line" : "border-line/60 opacity-70")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className={clsx("rounded-lg px-2.5 py-1 text-xs font-bold uppercase tracking-wide", buy ? "bg-pos/15 text-pos" : "bg-neg/15 text-neg")}>{SIDE[o.side]}</span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink"><span className="num">{qtyFmt(o.qty)}</span> × {name} <span className="text-sm font-normal text-muted">{o.symbol}</span></p>
          <p className="text-sm text-ink2">
            environ <span className="num font-medium text-ink">{eur(o.value)}</span> · cours indicatif <span className="num">{eur(o.price, true)}</span>
            {" · "}poids {pct(o.prev_weight)} → <span className="font-medium text-ink">{pct(o.target_weight)}</span>
          </p>
        </div>
        {o.status !== "pending" ? <Badge>{STATUS_LABEL[o.status]}</Badge> : actions}
      </div>
      <button className="mt-2 inline-flex items-center gap-1 text-sm text-accent hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
        Pourquoi ? <ChevronDown size={14} className={clsx("transition", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          <p className="text-sm leading-relaxed text-ink2">{o.reason}</p>
          {o.explain && <SignalCard action={o.action} explain={o.explain} reason={o.reason} asset={name} benchmark={benchmark} />}
        </div>
      )}
    </li>
  );
}

function FillForm({ account, order, name, onSaved }: { account: Account; order: ProposedOrder; name: string; onSaved: (a: Account) => void }) {
  const [f, setF] = useState({ qty: order.qty, price: Number(order.price.toFixed(2)), fees: Number(order.fee_estimate.toFixed(2)), date: today() });
  const m = useMutation({ mutationFn: () => api<Account>(`/accounts/${account.id}/orders/${order.id}/execute`, { method: "POST", body: f }), onSuccess: onSaved });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <p className="text-sm text-ink2">{SIDE[order.side]} {name} : indiquez ce que votre courtier a réellement exécuté. Vos positions et liquidités seront mises à jour.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Quantité exécutée"><input className="input num" type="number" min={0} step="any" required value={f.qty} onChange={(e) => setF({ ...f, qty: Number(e.target.value) })} /></Field>
        <Field label="Prix unitaire (€)"><input className="input num" type="number" min={0} step="any" required value={f.price} onChange={(e) => setF({ ...f, price: Number(e.target.value) })} /></Field>
        <Field label="Frais payés (€)"><input className="input num" type="number" min={0} step="0.01" value={f.fees} onChange={(e) => setF({ ...f, fees: Number(e.target.value) })} /></Field>
        <Field label="Date d'exécution"><input className="input" type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
      </div>
      <p className="text-sm text-muted">Montant : <span className="num text-ink">{eur(f.qty * f.price + (order.side === "buy" ? f.fees : -f.fees), true)}</span> {order.side === "buy" ? "débités" : "crédités"}</p>
      <ErrorNote error={m.error} />
      <div className="flex justify-end"><button className="btn-primary" disabled={m.isPending}>{m.isPending && <Spinner />}Enregistrer</button></div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------------------------

function PositionsCard({ account, write, onEdit, onMovement }: { account: Account; write: boolean; onEdit: () => void; onMovement: () => void }) {
  const rows = account.positions ?? [];
  return (
    <Card title="Mes positions" subtitle="Ce que vous détenez réellement, valorisé au dernier cours de clôture."
      actions={write && (
        <div className="flex flex-wrap gap-2">
          <button className="btn-outline h-9" onClick={onMovement}><Plus size={15} /> Mouvement</button>
          <button className="btn-outline h-9" onClick={onEdit}><Pencil size={15} /> Modifier</button>
        </div>
      )} pad={false}>
      {rows.length === 0 ? (
        <div className="card-pad"><Empty title="Aucun titre saisi">Ajoutez les titres que vous détenez déjà avec « Modifier », ou partez des liquidités : les premiers ordres d'achat les investiront.</Empty></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>Titre</th><th className="text-right">Quantité</th><th className="text-right">Prix de revient</th><th className="text-right">Cours</th><th className="text-right">Valeur</th><th className="text-right">Poids</th><th className="text-right">+/− value</th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.symbol}>
                  <td><span className="font-medium text-ink">{p.name}</span> <span className="text-xs text-muted">{p.symbol}</span>{p.locked && <Badge className="ml-2">Hors stratégie</Badge>}</td>
                  <td className="num text-right">{qtyFmt(p.qty)}</td>
                  <td className="num text-right">{p.avg_cost ? eur(p.avg_cost, true) : "—"}</td>
                  <td className="num text-right" title={p.price_date ? `Clôture du ${date(p.price_date)}` : undefined}>{eur(p.price, true)}</td>
                  <td className="num text-right">{eur(p.value)}</td>
                  <td className="num text-right">{pct(p.weight)}</td>
                  <td className={clsx("num text-right", tone(p.pnl))}>{p.pnl == null ? "—" : <>{eur(p.pnl)} <span className="text-xs">({spct(p.pnl_pct)})</span></>}</td>
                </tr>
              ))}
              <tr><td className="text-ink2">Liquidités</td><td /><td /><td /><td className="num text-right">{eur(account.cash)}</td><td className="num text-right">{pct(account.total ? account.cash / account.total : null)}</td><td /></tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

interface Row { symbol: string; name?: string; qty: string; avg_cost: string; locked: boolean }

function PositionsEditor({ account, onSaved }: { account: Account; onSaved: (a: Account) => void }) {
  const [rows, setRows] = useState<Row[]>(() => {
    const r = (account.positions ?? []).map((p) => ({ symbol: p.symbol, name: p.name, qty: String(p.qty), avg_cost: p.avg_cost ? String(Number(p.avg_cost.toFixed(4))) : "", locked: p.locked }));
    return r.length ? r : [{ symbol: "", qty: "", avg_cost: "", locked: false }];
  });
  const [cash, setCash] = useState(String(account.cash));
  const save = useMutation({
    mutationFn: async () => {
      const body = rows.filter((r) => r.symbol.trim() && Number(r.qty) > 0)
        .map((r) => ({ symbol: r.symbol.trim().toUpperCase(), qty: Number(r.qty), avg_cost: Number(r.avg_cost) || 0, locked: r.locked }));
      if (Number(cash) !== account.cash) await api(`/accounts/${account.id}`, { method: "PATCH", body: { cash: Number(cash) } });
      return api<Account>(`/accounts/${account.id}/positions`, { method: "PUT", body });
    },
    onSuccess: onSaved,
  });
  const upd = (i: number, patch: Partial<Row>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const universe = new Set(account.universe ?? []);
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <p className="text-sm text-ink2">
        Recopiez les lignes de votre compte chez le courtier. Le prix de revient sert au calcul des plus-values et des stop-loss.
        Cochez « hors stratégie » pour une ligne que la stratégie ne doit jamais vendre ni compter.
      </p>
      <div className="space-y-2">
        <div className="hidden grid-cols-[1.4fr_1fr_1fr_auto_auto] gap-2 text-xs font-medium text-muted sm:grid">
          <span>Titre (nom ou code)</span><span>Quantité</span><span>Prix de revient unitaire (€)</span><span>Hors stratégie</span><span />
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 rounded-xl border border-line p-2 sm:grid-cols-[1.4fr_1fr_1fr_auto_auto] sm:border-0 sm:p-0">
            <SymbolPicker className="col-span-2 sm:col-span-1" label="Titre" placeholder="Nom ou code" value={r.symbol} onChange={(sym, name) => upd(i, { symbol: sym, name })} />
            <input className="input num" type="number" min={0} step="any" aria-label="Quantité" placeholder="Quantité" value={r.qty} onChange={(e) => upd(i, { qty: e.target.value })} />
            <input className="input num" type="number" min={0} step="any" aria-label="Prix de revient unitaire" placeholder="PRU" value={r.avg_cost} onChange={(e) => upd(i, { avg_cost: e.target.value })} />
            <label className="flex items-center gap-2 text-sm text-ink2 sm:justify-center">
              <input type="checkbox" checked={r.locked} onChange={(e) => upd(i, { locked: e.target.checked })} /> <span className="sm:sr-only">Hors stratégie</span>
            </label>
            <button type="button" className="btn-ghost px-2" aria-label="Retirer la ligne" onClick={() => setRows(rows.filter((_, k) => k !== i))}><Trash2 size={15} /></button>
            {r.name && r.name !== r.symbol && <p className="col-span-full -mt-1 text-xs text-muted sm:hidden">{r.name}</p>}
            {r.symbol && universe.size > 0 && !universe.has(r.symbol.trim().toUpperCase()) && !r.locked && (
              <p className="col-span-full text-xs text-warn">Ce titre n'est pas dans l'univers de la stratégie : elle proposera de le vendre (cochez « hors stratégie » pour le garder).</p>
            )}
          </div>
        ))}
      </div>
      <button type="button" className="btn-outline h-9" onClick={() => setRows([...rows, { symbol: "", qty: "", avg_cost: "", locked: false }])}><Plus size={15} /> Ajouter une ligne</button>
      <Field label="Liquidités disponibles (€)" className="max-w-xs">
        <input className="input num" type="number" min={0} step="0.01" value={cash} onChange={(e) => setCash(e.target.value)} />
      </Field>
      <ErrorNote error={save.error} />
      <div className="flex justify-end"><button className="btn-primary" disabled={save.isPending}>{save.isPending && <Spinner />}Enregistrer</button></div>
    </form>
  );
}

const MOVE_LABEL = { buy: "Achat", sell: "Vente", deposit: "Versement", withdrawal: "Retrait" } as const;

function MovementForm({ account, onSaved }: { account: Account; onSaved: (a: Account) => void }) {
  const [f, setF] = useState({ kind: "deposit" as AccountMovement["kind"], date: today(), symbol: "", qty: "", price: "", fees: "0", amount: "", note: "" });
  const trade = f.kind === "buy" || f.kind === "sell";
  const m = useMutation({
    mutationFn: () => api<Account>(`/accounts/${account.id}/movements`, {
      method: "POST",
      body: trade
        ? { kind: f.kind, date: f.date, symbol: f.symbol, qty: Number(f.qty), price: Number(f.price), fees: Number(f.fees) || 0, note: f.note }
        : { kind: f.kind, date: f.date, amount: Number(f.amount), note: f.note },
    }),
    onSuccess: onSaved,
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <p className="text-sm text-ink2">Pour un versement d'argent, un retrait, ou un ordre passé en dehors des propositions.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type">
          <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as AccountMovement["kind"] })}>
            {Object.entries(MOVE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Date"><input className="input" type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        {trade ? (
          <>
            <Field label="Titre"><SymbolPicker label="Titre" value={f.symbol} onChange={(sym) => setF({ ...f, symbol: sym })} /></Field>
            <Field label="Quantité"><input className="input num" type="number" min={0} step="any" required value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
            <Field label="Prix unitaire (€)"><input className="input num" type="number" min={0} step="any" required value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
            <Field label="Frais (€)"><input className="input num" type="number" min={0} step="0.01" value={f.fees} onChange={(e) => setF({ ...f, fees: e.target.value })} /></Field>
          </>
        ) : (
          <Field label="Montant (€)"><input className="input num" type="number" min={0} step="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        )}
      </div>
      <Field label="Note"><input className="input" value={f.note} maxLength={500} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <ErrorNote error={m.error} />
      <div className="flex justify-end"><button className="btn-primary" disabled={m.isPending}>{m.isPending && <Spinner />}Enregistrer</button></div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Strategy view & history
// ---------------------------------------------------------------------------------------------

const ACTION_LABEL: Record<string, string> = { buy: "Acheter", sell: "Vendre", increase: "Renforcer", decrease: "Alléger", hold: "Conserver", skip: "Pas d'achat" };

function StrategyViewCard({ proposal }: { proposal: Proposal }) {
  const [open, setOpen] = useState(false);
  const rows = [...proposal.decisions].sort((x, y) => y.target_weight - x.target_weight || x.symbol.localeCompare(y.symbol));
  return (
    <Card title="L'avis de la stratégie, titre par titre" subtitle={`Tous les titres examinés lors du calcul du ${date(proposal.as_of)}, avec le poids visé.`}
      actions={<button className="btn-ghost h-9" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Masquer" : `Afficher (${rows.length})`}</button>}>
      {open && (
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>Titre</th><th>Avis</th><th className="text-right">Poids actuel</th><th className="text-right">Poids visé</th><th>Raison</th></tr></thead>
            <tbody>{rows.map((d) => (
              <tr key={d.symbol}>
                <td><span className="font-medium text-ink">{proposal.names[d.symbol] ?? d.symbol}</span> <span className="text-xs text-muted">{d.symbol}</span></td>
                <td className={clsx("whitespace-nowrap font-medium", d.action === "buy" || d.action === "increase" ? "text-pos" : d.action === "sell" || d.action === "decrease" ? "text-neg" : "text-ink2")}>{ACTION_LABEL[d.action]}</td>
                <td className="num text-right">{pct(d.prev_weight)}</td>
                <td className="num text-right">{pct(d.target_weight)}</td>
                <td className="min-w-[260px] text-sm text-ink2">{d.reason}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function HistoryCard({ account }: { account: Account }) {
  const [tab, setTab] = useState<"moves" | "proposals">("moves");
  const moves = useQuery({ queryKey: ["movements", account.id], queryFn: () => api<AccountMovement[]>(`/accounts/${account.id}/movements`) });
  const props = useQuery({ queryKey: ["proposals", account.id], queryFn: () => api<ProposalRow[]>(`/accounts/${account.id}/proposals`), enabled: tab === "proposals" });
  return (
    <Card title="Historique" pad={false}
      actions={<Tabs value={tab} onChange={setTab} tabs={[{ value: "moves", label: "Mouvements" }, { value: "proposals", label: "Calculs" }]} />}>
      <div className="overflow-x-auto">
        {tab === "moves" ? (
          moves.isLoading ? <Loading /> : !moves.data?.length ? <p className="card-pad text-sm text-muted">Aucun mouvement.</p> : (
            <table className="table-base">
              <thead><tr><th>Date</th><th>Type</th><th>Titre</th><th className="text-right">Quantité</th><th className="text-right">Prix</th><th className="text-right">Frais</th><th className="text-right">Montant</th><th className="text-right">Plus-value</th></tr></thead>
              <tbody>{moves.data.map((m) => (
                <tr key={m.id}>
                  <td className="whitespace-nowrap">{date(m.date)}</td>
                  <td>{MOVE_LABEL[m.kind]}{m.order_id && <span className="ml-1 text-xs text-muted">(proposé)</span>}</td>
                  <td>{m.symbol ?? "—"}</td>
                  <td className="num text-right">{m.qty == null ? "—" : qtyFmt(m.qty)}</td>
                  <td className="num text-right">{m.price == null ? "—" : eur(m.price, true)}</td>
                  <td className="num text-right">{m.fees ? eur(m.fees, true) : "—"}</td>
                  <td className={clsx("num text-right", tone(m.amount))}>{eur(m.amount, true)}</td>
                  <td className={clsx("num text-right", tone(m.realized_pnl))}>{m.realized_pnl == null ? "—" : eur(m.realized_pnl, true)}</td>
                </tr>
              ))}</tbody>
            </table>
          )
        ) : props.isLoading ? <Loading /> : !props.data?.length ? <p className="card-pad text-sm text-muted">Aucun calcul.</p> : (
          <table className="table-base">
            <thead><tr><th>Calculé le</th><th>Cours du</th><th>Déclenchement</th><th>Type</th><th className="text-right">Ordres</th><th className="text-right">Passés</th><th>Statut</th></tr></thead>
            <tbody>{props.data.map((p) => (
              <tr key={p.id}>
                <td className="whitespace-nowrap">{dateTime(p.created_at)}</td>
                <td className="whitespace-nowrap">{date(p.as_of)}</td>
                <td>{p.trigger === "scheduled" ? "Soir (auto)" : "À la demande"}{p.emailed_at && <Bell size={12} className="ml-1 inline text-muted" aria-label="email envoyé" />}</td>
                <td>{p.mode === "full" ? "Rééquilibrage" : "Contrôle"}</td>
                <td className="num text-right">{p.orders}</td>
                <td className="num text-right">{p.executed}</td>
                <td>{{ open: "En cours", closed: "Terminé", superseded: "Remplacé" }[p.status]}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </Card>
  );
}
