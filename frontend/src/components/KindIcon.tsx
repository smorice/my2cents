import { Anchor, BarChart3, GitMerge, Magnet, PieChart, Rocket, Target, Waves, type LucideIcon } from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  buy_and_hold: Anchor, momentum: Rocket, moving_average: Waves, golden_cross: GitMerge,
  mean_reversion: Magnet, relative_strength: BarChart3, benchmark_outperformance: Target, fixed_allocation: PieChart,
};

export function KindIcon({ kind, size = 18 }: { kind: string; size?: number }) {
  const I = ICONS[kind] ?? Target;
  return (
    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-raised text-accent">
      <I size={size} />
    </span>
  );
}
