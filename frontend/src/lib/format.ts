const nf = (opts: Intl.NumberFormatOptions) => new Intl.NumberFormat("fr-FR", opts);
const pctFmt = nf({ style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pctSigned = nf({ style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" });
const eur0 = nf({ style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const eur2 = nf({ style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dec2 = nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = nf({ notation: "compact", maximumFractionDigits: 1 });

const dash = "—";
export const pct = (v?: number | null) => (v == null || !isFinite(v) ? dash : pctFmt.format(v));
export const spct = (v?: number | null) => (v == null || !isFinite(v) ? dash : pctSigned.format(v));
export const eur = (v?: number | null, cents = false) => (v == null || !isFinite(v) ? dash : (cents ? eur2 : eur0).format(v));
export const money = (v: number | null | undefined, currency = "EUR") =>
  v == null ? dash : nf({ style: "currency", currency, maximumFractionDigits: 2 }).format(v);
export const num = (v?: number | null, digits = 2) =>
  v == null || !isFinite(v) ? dash : nf({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
export const ratio = (v?: number | null) => (v == null || !isFinite(v) ? dash : dec2.format(v));
export const short = (v?: number | null) => (v == null || !isFinite(v) ? dash : compact.format(v));
export const date = (s?: string | null) => (s ? new Date(s.length === 10 ? s + "T12:00:00" : s).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) : dash);
export const dateTime = (s?: string | null) =>
  s ? new Date(s).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : dash;
export const monthYear = (s: string) => new Date(s + "T12:00:00").toLocaleDateString("fr-FR", { month: "short", year: "2-digit" });
export const tone = (v?: number | null) => (v == null || v === 0 ? "text-ink" : v > 0 ? "text-pos" : "text-neg");
export const days = (n?: number | null) => (n == null ? dash : n >= 365 ? `${(n / 365).toFixed(1).replace(".", ",")} ans` : `${n} j`);
