// Applied before React renders to avoid a theme flash.
try {
  const t = localStorage.getItem("m2c-theme");
  const dark = t ? t === "dark" : true;
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
} catch {
  /* storage unavailable: keep default dark */
}
