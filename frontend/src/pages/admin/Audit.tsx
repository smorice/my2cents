import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight, ShieldCheck, ShieldX } from "lucide-react";
import { Fragment, useState } from "react";
import { Badge, Card, Loading, PageHeader, Pagination } from "../../components/ui";
import { api } from "../../lib/api";
import { dateTime } from "../../lib/format";
import type { AuditEvent, Page } from "../../lib/types";

const OUTCOME: Record<string, string> = { success: "text-ink2", failure: "text-neg border-neg/40", denied: "text-warn border-warn/40" };

function Json({ label, v }: { label: string; v: unknown }) {
  if (v == null) return null;
  return (
    <div className="min-w-0">
      <div className="eyebrow mb-1">{label}</div>
      <pre className="num max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-raised p-3 text-[11px] text-ink2">{JSON.stringify(v, null, 2)}</pre>
    </div>
  );
}

export function AuditPage() {
  const [f, setF] = useState({ q: "", actor: "", action: "", resource_type: "", outcome: "", from: "", to: "" });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const facets = useQuery({ queryKey: ["audit-facets"], queryFn: () => api<{ actions: string[]; resource_types: string[]; outcomes: string[] }>("/audit/facets") });
  const q = useQuery({
    queryKey: ["audit", f, page],
    queryFn: () => api<Page<AuditEvent>>("/audit", { params: { ...f, from: f.from ? f.from + "T00:00:00Z" : "", to: f.to ? f.to + "T23:59:59Z" : "", page, page_size: 50 } }),
    placeholderData: (p) => p,
  });
  const verify = useMutation({ mutationFn: () => api<{ valid: boolean; checked: number; broken_at: number | null }>("/audit/verify") });
  const set = (k: keyof typeof f, v: string) => { setF({ ...f, [k]: v }); setPage(1); };
  return (
    <>
      <PageHeader eyebrow="Administration" title="Journal d'audit"
        description="Journal en ajout seul : la base de données interdit toute modification ou suppression, et chaque événement est chaîné au précédent par une empreinte SHA-256."
        actions={<button className="btn-outline" onClick={() => verify.mutate()} disabled={verify.isPending}><ShieldCheck size={15} /> Vérifier l'intégrité</button>} />
      {verify.data && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${verify.data.valid ? "border-pos/30 text-pos" : "border-neg/40 text-neg"}`}>
          {verify.data.valid ? <ShieldCheck size={16} /> : <ShieldX size={16} />}
          {verify.data.valid ? `Chaîne intègre : ${verify.data.checked} événements vérifiés.` : `Chaîne rompue à l'événement #${verify.data.broken_at} !`}
        </div>
      )}
      <Card pad={false}>
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <input className="input" placeholder="Recherche libre…" value={f.q} onChange={(e) => set("q", e.target.value)} />
          <input className="input" placeholder="Utilisateur" value={f.actor} onChange={(e) => set("actor", e.target.value)} />
          <select className="input" value={f.action} onChange={(e) => set("action", e.target.value)}>
            <option value="">Toutes actions</option>
            {facets.data?.actions.map((a) => <option key={a}>{a}</option>)}
          </select>
          <select className="input" value={f.resource_type} onChange={(e) => set("resource_type", e.target.value)}>
            <option value="">Toutes ressources</option>
            {facets.data?.resource_types.map((a) => <option key={a}>{a}</option>)}
          </select>
          <select className="input" value={f.outcome} onChange={(e) => set("outcome", e.target.value)}>
            <option value="">Tous résultats</option>
            <option value="success">Succès</option><option value="failure">Échec</option><option value="denied">Refusé</option>
          </select>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-1"><input type="date" className="input" value={f.from} onChange={(e) => set("from", e.target.value)} aria-label="Du" /><input type="date" className="input" value={f.to} onChange={(e) => set("to", e.target.value)} aria-label="Au" /></div>
        </div>
        {q.isLoading ? <Loading /> : (
          <div tabIndex={0} className="overflow-x-auto px-3 pb-3">
            <table className="table-base">
              <thead><tr><th>#</th><th>Date</th><th>Utilisateur</th><th>Action</th><th>Ressource</th><th>Résultat</th><th>IP</th></tr></thead>
              <tbody>
                {q.data!.items.map((e) => (
                  <Fragment key={e.id}>
                    <tr className="cursor-pointer hover:bg-raised/50" onClick={() => setOpen(open === e.id ? null : e.id)}>
                      <td className="num text-xs text-muted"><span className="flex items-center gap-1"><ChevronRight size={12} className={open === e.id ? "rotate-90" : ""} />{e.id}</span></td>
                      <td className="num whitespace-nowrap text-xs">{dateTime(e.occurred_at)}</td>
                      <td className="max-w-[200px] truncate text-sm">{e.actor_email ?? <span className="text-muted">système</span>}</td>
                      <td className="num text-xs font-medium">{e.action}</td>
                      <td className="num max-w-[200px] truncate text-xs text-ink2">{e.resource_type}{e.resource_id && ` · ${e.resource_id.slice(0, 8)}`}</td>
                      <td><Badge className={OUTCOME[e.outcome]}>{e.outcome}</Badge></td>
                      <td className="num text-xs text-muted">{e.ip}</td>
                    </tr>
                    {open === e.id && (
                      <tr><td colSpan={7} className="bg-surface">
                        <div className="grid gap-4 py-2 lg:grid-cols-3">
                          <Json label="Avant" v={e.before} /><Json label="Après" v={e.after} /><Json label="Détails" v={e.details} />
                        </div>
                        <div className="num mt-2 break-all text-[11px] text-muted">resource_id {e.resource_id} · user-agent {e.user_agent} · sha256 {e.hash}</div>
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            <Pagination page={q.data!.page} pages={q.data!.pages} total={q.data!.total} onPage={setPage} />
          </div>
        )}
      </Card>
    </>
  );
}
