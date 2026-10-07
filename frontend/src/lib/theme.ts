import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

function read(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function setTheme(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark");
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem("m2c-theme", t);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("m2c-theme"));
}

export function useTheme(): Theme {
  const [t, setT] = useState<Theme>(read);
  useEffect(() => {
    const h = () => setT(read());
    window.addEventListener("m2c-theme", h);
    return () => window.removeEventListener("m2c-theme", h);
  }, []);
  return t;
}

const KEYS = ["c-1", "c-2", "c-3", "c-4", "c-5", "c-6", "c-7", "c-8", "c-bench", "c-grid", "c-axis", "c-invested", "c-pos", "c-neg", "c-mid"] as const;
export type ChartColors = Record<(typeof KEYS)[number], string> & { series: string[] };

/** Resolved chart colours for the active theme (SVG attributes need concrete values). */
export function useChartColors(): ChartColors {
  const theme = useTheme();
  const [c, setC] = useState<ChartColors>(() => resolve());
  useEffect(() => setC(resolve()), [theme]);
  return c;
}

function resolve(): ChartColors {
  const cs = getComputedStyle(document.documentElement);
  const out = {} as ChartColors;
  for (const k of KEYS) out[k] = cs.getPropertyValue(`--${k}`).trim();
  out.series = [out["c-1"], out["c-2"], out["c-3"], out["c-4"], out["c-5"], out["c-6"], out["c-7"], out["c-8"]];
  return out;
}
