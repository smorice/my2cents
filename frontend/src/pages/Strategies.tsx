import { Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { KindIcon } from "../components/KindIcon";
import { Badge, Empty, Loading, PageHeader, Toggle } from "../components/ui";
import { useAuth } from "../lib/auth";
import { pct, spct, tone } from "../lib/format";
import { FREQ, STATUS } from "../lib/labels";
import { useCatalog, useStrategies } from "../lib/queries";
import type { Strategy } from "../lib/types";

function StrategyCard({ s, kindName }: { s: Strategy; kindName: string }) {
  const m = s.last_backtest?.summary;
  return (
    <Link to={`/strategies/${s.id}`} className="card group flex flex-col p-5 transition-colors hover:border-accent/40">
      <div className="flex items-start gap-3">
        <KindIcon kind={s.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-semibold tracking-tight group-hover:text-accent">{s.name}</h3>
          </div>
          <div className="mt-0.5 text-xs text-muted">{kindName} · v{s.current_version} · {FREQ[s.definition?.rebalance_frequency ?? ""] ?? ""}</div>
        </div>
        {s.status !== "active" && <Badge className={STATUS[s.status].cls}>{STATUS[s.status].label}</Badge>}
      </div>
      <p className="mt-3 line-clamp-2 flex-1 text-sm leading-relaxed text-ink2">{s.description || s.rules[0]}</p>
      <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-xs">
        {m ? (
          <span className="num flex gap-4">
            <span><span className="text-muted">CAGR </span><span className={tone(m.cagr)}>{pct(m.cagr)}</span></span>
            <span><span className="text-muted">Max DD </span>{pct(m.max_drawdown)}</span>
            <span><span className="text-muted">Total </span><span className={tone(m.total_return)}>{spct(m.total_return)}</span></span>
          </span>
        ) : <span className="text-muted">Pas encore testée</span>}
        <span className="text-muted">{s.author}</span>
      </div>
    </Link>
  );
}

export function StrategiesPage() {
  const [archived, setArchived] = useState(false);
  const q = useStrategies(archived);
  const cat = useCatalog();
  const { can } = useAuth();
  const kindName = (k: string) => cat.data?.find((c) => c.kind === k)?.name ?? k;
  if (q.isLoading) return <Loading />;
  const mine = q.data!.filter((s) => !s.is_template);
  const templates = q.data!.filter((s) => s.is_template);
  return (
    <>
      <PageHeader eyebrow="Stratégies" title="Bibliothèque de stratégies"
        description="Chaque stratégie est un objet versionné : ses paramètres, son univers, son indice de référence, ses frais et son modèle de risque. Partez d'un modèle, clonez-le, ajustez-le."
        actions={can("strategy:create") && <Link to="/strategies/new" className="btn-primary"><Plus size={16} /> Nouvelle stratégie</Link>} />

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Mes stratégies <span className="num ml-1 text-muted">{mine.length}</span></h2>
        <Toggle checked={archived} onChange={setArchived} label={<span className="text-xs text-ink2">Afficher les archivées</span>} />
      </div>
      {mine.length === 0 ? (
        <div className="card mb-10">
          <Empty title="Aucune stratégie personnelle" action={can("strategy:create") && <Link to="/strategies/new" className="btn-outline"><Plus size={15} /> Créer une stratégie</Link>}>
            Clonez un modèle ci-dessous ou créez une stratégie de zéro.
          </Empty>
        </div>
      ) : (
        <div className="mb-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{mine.map((s) => <StrategyCard key={s.id} s={s} kindName={kindName(s.kind)} />)}</div>
      )}

      <h2 className="mb-4 text-sm font-semibold">Modèles My2cents <span className="num ml-1 text-muted">{templates.length}</span></h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{templates.map((s) => <StrategyCard key={s.id} s={s} kindName={kindName(s.kind)} />)}</div>
    </>
  );
}
