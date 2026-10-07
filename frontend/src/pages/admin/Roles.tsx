import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
import { useState } from "react";
import { Badge, Card, ErrorNote, Field, Loading, Modal, PageHeader, toast } from "../../components/ui";
import { api } from "../../lib/api";

interface Role { id: number; name: string; description: string; permissions: string[]; is_system: boolean }

export function RolesPage() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api<Role[]>("/admin/roles") });
  const perms = useQuery({ queryKey: ["permissions"], queryFn: () => api<{ key: string; label: string }[]>("/admin/permissions") });
  const [edit, setEdit] = useState<{ name: string; description: string; permissions: string[]; isNew: boolean } | null>(null);
  const save = useMutation({
    mutationFn: () => api(`/admin/roles/${encodeURIComponent(edit!.name)}`, { method: "PUT", body: { description: edit!.description, permissions: edit!.permissions } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["roles"] }); setEdit(null); toast("Rôle enregistré"); },
  });
  if (roles.isLoading || perms.isLoading) return <Loading />;
  return (
    <>
      <PageHeader eyebrow="Administration" title="Rôles et permissions" description="Contrôle d'accès par rôles (RBAC). Les permissions sont explicites ; un utilisateur cumule celles de tous ses rôles."
        actions={<button className="btn-primary" onClick={() => setEdit({ name: "", description: "", permissions: [], isNew: true })}><Plus size={15} /> Nouveau rôle</button>} />
      <Card pad={false}>
        <div tabIndex={0} className="overflow-x-auto px-3 py-3">
          <table className="table-base">
            <thead>
              <tr><th>Permission</th>{roles.data!.map((r) => (
                <th key={r.name} className="text-center">
                  <button disabled={r.name === "ADMIN"} onClick={() => setEdit({ ...r, isNew: false })} className="hover:text-ink disabled:cursor-default">{r.name}</button>
                </th>
              ))}</tr>
            </thead>
            <tbody>
              {perms.data!.map((p) => (
                <tr key={p.key}>
                  <td><div className="text-sm">{p.label}</div><div className="num text-[11px] text-muted">{p.key}</div></td>
                  {roles.data!.map((r) => <td key={r.name} className="text-center">{r.permissions.includes(p.key) ? <Check size={15} className="inline text-accent" /> : <span className="text-line">·</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="mt-3 text-xs text-muted">Cliquez sur le nom d'un rôle pour le modifier. Le rôle ADMIN possède toujours toutes les permissions.</p>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.isNew ? "Nouveau rôle" : `Rôle ${edit?.name}`} wide>
        {edit && (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            {edit.isNew && <Field label="Nom (ex. ANALYST)"><input className="input uppercase" required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })} /></Field>}
            <Field label="Description"><input className="input" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <div className="grid gap-2 sm:grid-cols-2">
              {perms.data!.map((p) => (
                <label key={p.key} className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-2.5 text-sm hover:bg-raised">
                  <input type="checkbox" className="mt-0.5" checked={edit.permissions.includes(p.key)} onChange={() => setEdit({ ...edit, permissions: edit.permissions.includes(p.key) ? edit.permissions.filter((x) => x !== p.key) : [...edit.permissions, p.key] })} />
                  <span>{p.label}<span className="num block text-[11px] text-muted">{p.key}</span></span>
                </label>
              ))}
            </div>
            <ErrorNote error={save.error} />
            <div className="flex items-center justify-between">{!edit.isNew && <Badge>{edit.permissions.length} permission(s)</Badge>}<button className="btn-primary ml-auto" disabled={!edit.name}>Enregistrer</button></div>
          </form>
        )}
      </Modal>
    </>
  );
}
