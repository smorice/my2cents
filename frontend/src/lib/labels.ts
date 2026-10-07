export const FREQ: Record<string, string> = {
  daily: "Quotidien",
  weekly: "Hebdomadaire",
  monthly: "Mensuel",
  quarterly: "Trimestriel",
  yearly: "Annuel",
  never: "Jamais",
  none: "Aucun",
};

export const STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: "Active", cls: "text-pos border-pos/30 bg-pos/10" },
  inactive: { label: "Désactivée", cls: "text-muted" },
  draft: { label: "Brouillon", cls: "text-warn border-warn/30" },
  archived: { label: "Archivée", cls: "text-muted" },
  queued: { label: "En file", cls: "text-ink2" },
  running: { label: "En cours", cls: "text-accent border-accent/40" },
  done: { label: "Terminé", cls: "text-ink2" },
  failed: { label: "Échec", cls: "text-neg border-neg/40" },
};

export const ACTION: Record<string, { label: string; cls: string }> = {
  buy: { label: "Achat", cls: "text-pos border-pos/30 bg-pos/10" },
  increase: { label: "Renforcement", cls: "text-pos border-pos/30" },
  sell: { label: "Vente", cls: "text-neg border-neg/30 bg-neg/10" },
  decrease: { label: "Allègement", cls: "text-neg border-neg/30" },
  hold: { label: "Conservé", cls: "text-ink2" },
  skip: { label: "Non retenu", cls: "text-muted" },
};

export const KIND_ICON: Record<string, string> = {
  buy_and_hold: "Anchor",
  momentum: "Rocket",
  moving_average: "Waves",
  golden_cross: "GitMerge",
  mean_reversion: "Magnet",
  relative_strength: "BarChart3",
  benchmark_outperformance: "Target",
  fixed_allocation: "PieChart",
};

export const METRIC_HELP: Record<string, string> = {
  cagr: "Taux de croissance annuel composé, hors effet des versements (rendement pondéré par le temps).",
  irr: "Taux de rendement interne : la performance réellement vécue compte tenu du calendrier de vos versements.",
  volatility: "Écart-type annualisé des rendements quotidiens : l'amplitude des variations.",
  sharpe: "Rendement excédentaire par unité de volatilité. > 1 est très bon sur longue période.",
  sortino: "Comme Sharpe, mais ne pénalise que la volatilité à la baisse.",
  max_drawdown: "Pire perte entre un plus haut et le plus bas suivant.",
  calmar: "CAGR divisé par la perte maximale : rendement obtenu par unité de « pire scénario ».",
  beta: "Sensibilité aux mouvements de l'indice : 1 = bouge comme lui.",
  alpha: "Surperformance annualisée non expliquée par l'exposition au marché (bêta).",
  tracking_error: "Volatilité de l'écart de rendement avec l'indice.",
  information_ratio: "Surperformance moyenne divisée par la tracking error.",
  avg_exposure: "Part moyenne du portefeuille investie (le reste est en liquidités).",
  annual_turnover: "Volume annuel des transactions rapporté à la valeur moyenne du portefeuille.",
};
