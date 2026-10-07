import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, LogOut, Search } from "lucide-react";
import { useState } from "react";
import { Badge, Card, ErrorNote, Loading, Modal, PageHeader, Pagination, toast } from "../../components/ui";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { dateTime } from "../../lib/format";
import type { Page, User } from "../../lib/types";

export function UsersPage() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<User | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const users = useQuery({ queryKey: ["admin-users", q, page], queryFn: () => api<Page<User>>("/admin/users", { params: { q, page } }), placeholderData: (p) => p });
  const roleList = useQuery({ queryKey: ["roles"], queryFn: () => api<{ name: string; description: string }[]>("/admin/roles") });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Record<string, unknown> }) => api<User>(`/admin/users/${v.id}`, { method: "PATCH", body: v.body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-users"] }); setEditing(null); toast("Utilisateur mis à jour"); },
    onError: (e) => toast((e as Error).message, "err"),
  });
  const reset = useMutation({ mutationFn: (id: string) => api<{ link: string }>(`/admin/users/${id}/reset-link`, { method: "POST" }), onSuccess: (r) => setLink(r.link) });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/admin/users/${id}/revoke-sessions`, { method: "POST" }), onSuccess: () => toast("Sessions révoquées") });
  return (
    <>
      <PageHeader eyebrow="Administration" title="Utilisateurs" description="Rôles, activation des comptes et réinitialisation. Chaque action est enregistrée dans le journal d'audit." />
      <Card pad={false}>
        <div className="p-4"><div className="relative max-w-sm"><Search size={15} className="absolute left-3 top-2.5 text-muted" /><input className="input pl-9" placeholder="Email ou nom…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div></div>
        {users.isLoading ? <Loading /> : (
          <div className="overflow-x-auto px-3 pb-3">
            <table className="table-base">
              <thead><tr><th>Utilisateur</th><th>Rôles</th><th>Statut</th><th>MFA</th><th>Dernière connexion</th><th /></tr></thead>
              <tbody>
                {users.data!.items.map((u) => (
                  <tr key={u.id}>
                    <td><div className="font-medium">{u.display_name}</div><div className="text-xs text-muted">{u.email}</div></td>
                    <td><div className="flex flex-wrap gap-1">{u.role_names.map((r) => <Badge key={r} className={r === "ADMIN" ? "border-accent/40 text-accent" : ""}>{r}</Badge>)}</div></td>
                    <td>{u.is_active ? <Badge className="border-pos/30 text-pos">Actif</Badge> : <Badge className="text-neg">Désactivé</Badge>}</td>
                    <td className="text-xs">{u.totp_enabled ? "Oui" : "—"}</td>
                    <td className="whitespace-nowrap text-xs text-ink2">{dateTime(u.last_login_at)}</td>
                    <td className="whitespace-nowrap text-right">
                      <button className="btn-ghost h-8 text-xs" onClick={() => { setEditing(u); setRoles(u.role_names); }}>Rôles</button>
                      {u.id !== me?.id && <button className="btn-ghost h-8 text-xs" onClick={() => patch.mutate({ id: u.id, body: { is_active: !u.is_active } })}>{u.is_active ? "Désactiver" : "Activer"}</button>}
                      <button className="btn-ghost h-8 px-2" title="Lien de réinitialisation" onClick={() => reset.mutate(u.id)}><KeyRound size={14} /></button>
                      <button className="btn-ghost h-8 px-2" title="Révoquer les sessions" onClick={() => revoke.mutate(u.id)}><LogOut size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={users.data!.page} pages={users.data!.pages} total={users.data!.total} onPage={setPage} />
          </div>
        )}
      </Card>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={`Rôles de ${editing?.display_name}`}>
        <div className="space-y-2">
          {roleList.data?.map((r) => (
            <label key={r.name} className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 hover:bg-raised">
              <input type="checkbox" className="mt-1" checked={roles.includes(r.name)} onChange={() => setRoles((x) => (x.includes(r.name) ? x.filter((y) => y !== r.name) : [...x, r.name]))} />
              <span><span className="text-sm font-medium">{r.name}</span><span className="block text-xs text-muted">{r.description}</span></span>
            </label>
          ))}
        </div>
        <ErrorNote error={patch.error} />
        <div className="mt-5 flex justify-end gap-2"><button className="btn-ghost" onClick={() => setEditing(null)}>Annuler</button><button className="btn-primary" onClick={() => editing && patch.mutate({ id: editing.id, body: { roles } })}>Enregistrer</button></div>
      </Modal>
      <Modal open={!!link} onClose={() => setLink(null)} title="Lien de réinitialisation">
        <p className="mb-3 text-sm text-ink2">Valable 1 heure, à usage unique. Transmettez-le à l'utilisateur par un canal sûr.</p>
        <div className="flex gap-2"><input className="input num text-xs" readOnly value={link ?? ""} onFocus={(e) => e.target.select()} />
          <button className="btn-outline" onClick={() => { navigator.clipboard.writeText(link ?? ""); toast("Copié"); }}><Copy size={14} /></button></div>
      </Modal>
    </>
  );
}
