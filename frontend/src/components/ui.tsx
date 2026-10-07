import clsx from "clsx";
import { AlertTriangle, Info, Loader2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Card({ title, subtitle, actions, children, className, pad = true }: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean;
}) {
  return (
    <section className={clsx("card", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx(pad && "card-pad", (title || actions) && pad && "pt-4 sm:pt-4")}>{children}</div>
    </section>
  );
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        {eyebrow && <div className="eyebrow mb-2">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">{title}</h1>
        {description && <p className="mt-2 text-sm leading-relaxed text-ink2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, help, className, valueClass }: { label: ReactNode; value: ReactNode; sub?: ReactNode; help?: string; className?: string; valueClass?: string }) {
  return (
    <div className={clsx("min-w-0", className)}>
      <div className="flex items-center gap-1 text-xs text-muted">
        {label}
        {help && <Help text={help} />}
      </div>
      <div className={clsx("num mt-1 truncate text-xl font-semibold tracking-tight", valueClass)}>{value}</div>
      {sub && <div className="num mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Help({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <Info size={12} className="cursor-help text-muted/70" aria-label={text} />
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-60 -translate-x-1/2 rounded-lg border border-line bg-raised px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-ink2 shadow-card group-hover:block">
        {text}
      </span>
    </span>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx("chip", className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx("animate-spin text-muted", className)} size={18} />;
}

export function Loading({ label = "Chargement…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Spinner /> {label}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-muted">{icon}</div>}
      <div className="font-medium">{title}</div>
      {children && <p className="mt-1 max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-neg/30 bg-neg/5 px-3 py-2.5 text-sm text-neg">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  );
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <div className={clsx("flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm",
      tone === "warn" ? "border-warn/30 bg-warn/5 text-ink2" : "border-line bg-raised text-ink2")}>
      {tone === "warn" ? <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" /> : <Info size={16} className="mt-0.5 shrink-0 text-muted" />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("block", className)}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint block">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={clsx("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-accent" : "bg-line")}>
        <span className={clsx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", checked ? "left-[18px]" : "left-0.5")} />
      </button>
      <span>
        <span className="text-sm">{label}</span>
        {hint && <span className="hint block">{hint}</span>}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = "md" }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; size?: "sm" | "md" }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-raised p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={clsx("rounded-md font-medium transition-colors", size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm",
            value === o.value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: ReactNode; count?: number }[]; onChange: (v: T) => void }) {
  return (
    <div className="-mx-1 mb-5 flex gap-1 overflow-x-auto border-b border-line px-1">
      {tabs.map((t) => (
        <button key={t.value} type="button" onClick={() => onChange(t.value)}
          className={clsx("relative whitespace-nowrap px-3 pb-2.5 pt-1 text-sm font-medium transition-colors",
            value === t.value ? "text-ink" : "text-muted hover:text-ink2")}>
          {t.label}
          {t.count != null && <span className="num ml-1.5 text-xs text-muted">{t.count}</span>}
          {value === t.value && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:items-center" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}
        className={clsx("card my-8 w-full shadow-2xl", wide ? "max-w-3xl" : "max-w-lg")}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="font-semibold">{title}</h2>
          <button className="btn-ghost h-8 px-2" onClick={onClose} aria-label="Fermer"><X size={16} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Pagination({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (pages <= 1) return <div className="px-1 pt-3 text-xs text-muted num">{total} élément(s)</div>;
  return (
    <div className="flex items-center justify-between px-1 pt-3 text-xs text-muted">
      <span className="num">{total} élément(s) · page {page}/{pages}</span>
      <div className="flex gap-1">
        <button className="btn-outline h-7 px-2.5 text-xs" disabled={page <= 1} onClick={() => onPage(page - 1)}>Précédent</button>
        <button className="btn-outline h-7 px-2.5 text-xs" disabled={page >= pages} onClick={() => onPage(page + 1)}>Suivant</button>
      </div>
    </div>
  );
}

let pushToast: ((t: { msg: string; tone?: "ok" | "err" }) => void) | null = null;
export const toast = (msg: string, tone: "ok" | "err" = "ok") => pushToast?.({ msg, tone });

export function Toaster() {
  const [items, setItems] = useState<{ id: number; msg: string; tone?: "ok" | "err" }[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      const id = Date.now() + Math.random();
      setItems((x) => [...x, { id, ...t }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4200);
    };
    return () => { pushToast = null; };
  }, []);
  return (
    <div aria-live="polite" className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
      {items.map((t) => (
        <div key={t.id} className={clsx("card px-4 py-3 text-sm shadow-card", t.tone === "err" && "border-neg/40 text-neg")}>{t.msg}</div>
      ))}
    </div>
  );
}
