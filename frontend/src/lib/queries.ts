import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { BenchmarkInfo, Instrument, Strategy, StrategyKind } from "./types";

export const useCatalog = () =>
  useQuery({ queryKey: ["catalog"], queryFn: () => api<StrategyKind[]>("/strategies/catalog"), staleTime: Infinity });

export const useStrategies = (includeArchived = false) =>
  useQuery({ queryKey: ["strategies", includeArchived], queryFn: () => api<Strategy[]>("/strategies", { params: { include_archived: includeArchived } }) });

export const useInstruments = () =>
  useQuery({ queryKey: ["instruments"], queryFn: () => api<Instrument[]>("/market/instruments"), staleTime: 5 * 60_000 });

export const useUniverses = () =>
  useQuery({ queryKey: ["universes"], queryFn: () => api<{ key: string; label: string; symbols: string[] }[]>("/market/universes"), staleTime: Infinity });

export function useNames() {
  const q = useInstruments();
  const map: Record<string, string> = {};
  for (const i of q.data ?? []) map[i.symbol] = i.name;
  return map;
}

export const useBenchmarks = () =>
  useQuery({ queryKey: ["benchmarks"], queryFn: () => api<BenchmarkInfo[]>("/market/benchmarks"), staleTime: 10 * 60_000 });
