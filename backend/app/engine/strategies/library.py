from __future__ import annotations

from .base import (
    Context,
    Evaluation,
    Note,
    Param,
    Strategy,
    check,
    equal_weights,
    explain,
    fact,
    flag,
    pct,
    sma,
    tradable,
    trailing_return,
    zscore,
)

LOOKBACK_CHOICES = [21, 63, 126, 252]
LOOKBACK_HELP = "En jours de bourse : 21 ≈ 1 mois, 63 ≈ 3 mois, 126 ≈ 6 mois, 252 ≈ 12 mois."


class BuyAndHold(Strategy):
    kind = "buy_and_hold"
    name = "Buy & Hold"
    summary = "Acheter le panier d'actifs une fois, puis conserver."
    explanation = (
        "La stratégie investit à parts égales dans tous les actifs de l'univers dès qu'ils sont "
        "disponibles, puis ne vend jamais. Les versements programmés sont répartis selon les poids "
        "cibles. Si le rééquilibrage périodique est activé, les poids sont ramenés à l'équipondération "
        "à chaque échéance. C'est la référence passive contre laquelle toute stratégie active doit se mesurer."
    )
    default_rebalance = "never"
    params = [
        Param("rebalance_to_equal", "Rééquilibrer vers l'équipondération", "bool", False,
              "Si activé, chaque échéance de rééquilibrage ramène chaque ligne à 1/N."),
    ]

    def evaluate(self, ctx: Context) -> Evaluation:
        symbols = tradable(ctx.prices, 0)
        first = not ctx.state.get("initialised")
        ctx.state["initialised"] = True
        if first or self.p["rebalance_to_equal"]:
            label = "Allocation initiale équipondérée." if first else "Ramené à l'équipondération."
            w = equal_weights(symbols)
            ex = {s: explain([fact(f"Poids cible : 1/{len(symbols)} de l'univers", w[s])], [flag("Coté à cette date", True)]) for s in symbols}
            return Evaluation(w, {s: Note(label, explain=ex[s]) for s in symbols})
        return Evaluation(None, {s: Note("Conservé : stratégie passive.", explain=explain(checks=[flag("Stratégie passive : jamais de vente", True)]))
                                 for s in ctx.weights})


class Momentum(Strategy):
    kind = "momentum"
    name = "Momentum"
    summary = "Détenir les actifs ayant le mieux performé sur la période récente."
    explanation = (
        "À chaque rééquilibrage, la performance de chaque actif est mesurée sur la fenêtre choisie "
        "(en excluant éventuellement le dernier mois, pour neutraliser l'effet de retournement court terme). "
        "Les N meilleurs sont achetés à parts égales ; les autres sont vendus. Optionnellement, seuls les actifs "
        "à momentum absolu positif sont retenus (sinon la poche reste en liquidités)."
    )
    params = [
        Param("lookback_days", "Fenêtre de mesure", "choice", 126, LOOKBACK_HELP, choices=LOOKBACK_CHOICES, unit="jours"),
        Param("skip_days", "Jours récents ignorés", "int", 0, "Ex. 21 pour le momentum « 12-1 ».", min=0, max=63),
        Param("top_n", "Nombre de lignes", "int", 5, min=1, max=50),
        Param("require_positive", "Exiger un momentum positif", "bool", True,
              "Ne pas acheter un actif dont la performance sur la fenêtre est négative."),
    ]

    def warmup_days(self) -> int:
        return int(self.p["lookback_days"]) + int(self.p["skip_days"])

    def evaluate(self, ctx: Context) -> Evaluation:
        lb, skip, n = int(self.p["lookback_days"]), int(self.p["skip_days"]), int(self.p["top_n"])
        scores = {}
        for s in tradable(ctx.prices, lb + skip):
            r = trailing_return(ctx.prices[s], lb, skip)
            if r is not None:
                scores[s] = r
        ranked = sorted(scores, key=scores.get, reverse=True)
        notes: dict[str, Note] = {}
        chosen = []
        window = f"{lb} j" + (f", hors {skip} derniers j" if skip else "")
        for rank, s in enumerate(ranked, 1):
            m = {"momentum": scores[s], "rank": rank}
            checks = [check(f"Classé parmi les {n} meilleurs", rank, "<=", n, "int")]
            if self.p["require_positive"]:
                checks.append(check("Momentum positif", scores[s], ">", 0.0))
            ex = explain([fact(f"Performance de {{asset}} ({window})", scores[s], subject="asset", emphasis=True),
                          fact(f"Rang sur {len(ranked)} actifs", rank, "int")], checks)
            if rank > n:
                notes[s] = Note(f"Rang {rank} (momentum {pct(scores[s])}) : hors des {n} meilleurs.", m, ex)
            elif self.p["require_positive"] and scores[s] <= 0:
                notes[s] = Note(f"Rang {rank} mais momentum négatif ({pct(scores[s])}) : filtre absolu.", m, ex)
            else:
                chosen.append(s)
                notes[s] = Note(f"Rang {rank}/{len(ranked)} avec un momentum de {pct(scores[s])} sur {lb} j.", m, ex)
        weights = {s: 1.0 / n for s in chosen}  # unfilled slots stay in cash
        return Evaluation(weights, notes)


class MovingAverage(Strategy):
    kind = "moving_average"
    name = "Moyenne mobile"
    summary = "Être investi quand le prix est au-dessus de sa moyenne mobile, en liquidités sinon."
    explanation = (
        "Pour chaque actif, la stratégie compare le dernier cours de clôture à sa moyenne mobile simple. "
        "Au-dessus (au-delà d'une marge de tolérance), la ligne est détenue ; en dessous, elle est vendue "
        "et la poche correspondante passe en liquidités. La marge évite les allers-retours quand le prix "
        "oscille autour de la moyenne."
    )
    default_rebalance = "weekly"
    params = [
        Param("sma_period", "Période de la moyenne", "choice", 200, choices=[20, 50, 100, 150, 200], unit="jours"),
        Param("band_pct", "Marge de tolérance", "float", 1.0,
              "Achat si prix > SMA × (1 + marge), vente si prix < SMA × (1 − marge).", min=0, max=10, step=0.5, unit="%"),
    ]

    def warmup_days(self) -> int:
        return int(self.p["sma_period"])

    def evaluate(self, ctx: Context) -> Evaluation:
        period, band = int(self.p["sma_period"]), float(self.p["band_pct"]) / 100
        symbols = tradable(ctx.prices, period)
        notes: dict[str, Note] = {}
        held = []
        for s in symbols:
            price = float(ctx.prices[s].iloc[-1])
            avg = sma(ctx.prices[s], period)
            if avg is None:
                continue
            gap = price / avg - 1
            m = {"price": price, "sma": avg, "gap": gap}
            invested = ctx.weights.get(s, 0) > 0
            c = (check(f"Écart au-dessus de −{band * 100:g} % (maintien)", gap, ">=", -band) if invested
                 else check(f"Écart au-dessus de +{band * 100:g} % (entrée)", gap, ">", band))
            ex = explain([fact("Cours de {asset}", price, "num", subject="asset"), fact(f"Moyenne mobile {period} j", avg, "num"),
                          fact("Écart à la moyenne", gap, emphasis=True)], [c])
            if c["passed"]:
                held.append(s)
                notes[s] = Note(f"Cours {pct(gap)} par rapport à la SMA {period} : tendance haussière.", m, ex)
            else:
                notes[s] = Note(f"Cours {pct(gap)} par rapport à la SMA {period} : hors marché.", m, ex)
        n = max(len(symbols), 1)
        return Evaluation({s: 1.0 / n for s in held}, notes)


class GoldenCross(Strategy):
    kind = "golden_cross"
    name = "Golden Cross"
    summary = "Investi quand la moyenne courte est au-dessus de la moyenne longue."
    explanation = (
        "Le « golden cross » survient quand la moyenne mobile courte (ex. 50 j) passe au-dessus de la longue "
        "(ex. 200 j) ; le « death cross » est le croisement inverse. Chaque actif est détenu tant que la "
        "moyenne courte reste au-dessus de la longue, à poids égal dans l'univers ; sinon sa poche est en liquidités."
    )
    default_rebalance = "weekly"
    params = [
        Param("fast", "Moyenne courte", "int", 50, min=5, max=150, unit="jours"),
        Param("slow", "Moyenne longue", "int", 200, min=20, max=300, unit="jours"),
    ]

    def validate(self) -> None:
        if self.p["fast"] >= self.p["slow"]:
            raise ValueError("La moyenne courte doit être plus courte que la longue.")

    def warmup_days(self) -> int:
        return int(self.p["slow"])

    def evaluate(self, ctx: Context) -> Evaluation:
        fast, slow = int(self.p["fast"]), int(self.p["slow"])
        symbols = tradable(ctx.prices, slow)
        notes: dict[str, Note] = {}
        held = []
        for s in symbols:
            f, sl = sma(ctx.prices[s], fast), sma(ctx.prices[s], slow)
            if f is None or sl is None:
                continue
            spread = f / sl - 1
            m = {"sma_fast": f, "sma_slow": sl, "spread": spread}
            ex = explain([fact(f"Moyenne {fast} j de {{asset}}", f, "num", subject="asset"), fact(f"Moyenne {slow} j", sl, "num"),
                          fact("Écart entre les moyennes", spread, emphasis=True)],
                         [check(f"Moyenne {fast} j au-dessus de la {slow} j", spread, ">", 0.0)])
            if spread > 0:
                held.append(s)
                notes[s] = Note(f"SMA {fast} au-dessus de la SMA {slow} ({pct(spread)}) : golden cross actif.", m, ex)
            else:
                notes[s] = Note(f"SMA {fast} sous la SMA {slow} ({pct(spread)}) : death cross, hors marché.", m, ex)
        n = max(len(symbols), 1)
        return Evaluation({s: 1.0 / n for s in held}, notes)


class MeanReversion(Strategy):
    kind = "mean_reversion"
    name = "Retour à la moyenne"
    summary = "Acheter les actifs anormalement sous leur moyenne récente, revendre au retour."
    explanation = (
        "Pour chaque actif, on calcule l'écart du cours à sa moyenne sur la fenêtre, exprimé en nombre "
        "d'écarts-types (z-score). Un z-score inférieur au seuil d'entrée signale une sous-performance "
        "inhabituelle : l'actif est acheté. Il est revendu quand le z-score remonte au-dessus du seuil de "
        "sortie. Un filtre de tendance optionnel évite d'acheter des actifs en chute durable (cours sous la SMA 200)."
    )
    default_rebalance = "daily"
    params = [
        Param("window", "Fenêtre", "int", 20, min=5, max=120, unit="jours"),
        Param("entry_z", "Seuil d'entrée (z-score)", "float", -2.0, min=-4, max=0, step=0.1),
        Param("exit_z", "Seuil de sortie (z-score)", "float", 0.0, min=-2, max=3, step=0.1),
        Param("max_positions", "Positions maximum", "int", 5, min=1, max=40),
        Param("trend_filter", "Filtre de tendance SMA 200", "bool", True),
    ]

    def validate(self) -> None:
        if self.p["exit_z"] <= self.p["entry_z"]:
            raise ValueError("Le seuil de sortie doit être supérieur au seuil d'entrée.")

    def warmup_days(self) -> int:
        return max(int(self.p["window"]), 200 if self.p["trend_filter"] else 0)

    def evaluate(self, ctx: Context) -> Evaluation:
        window, entry, exit_ = int(self.p["window"]), float(self.p["entry_z"]), float(self.p["exit_z"])
        n = int(self.p["max_positions"])
        notes: dict[str, Note] = {}
        keep, candidates = [], []
        for s in tradable(ctx.prices, self.warmup_days()):
            z = zscore(ctx.prices[s], window)
            if z is None:
                continue
            m = {"zscore": z}
            facts = [fact(f"Écart de {{asset}} à sa moyenne {window} j, en écarts-types (z-score)", z, "z", subject="asset", emphasis=True)]
            trend_ok = True
            trend = None
            if self.p["trend_filter"]:
                long = sma(ctx.prices[s], 200)
                trend_ok = long is not None and ctx.prices[s].iloc[-1] > long
                m["above_sma200"] = 1.0 if trend_ok else 0.0
                trend = flag("Tendance de fond haussière (cours au-dessus de la moyenne 200 j)", trend_ok)
            if ctx.weights.get(s, 0) > 0:
                ex = explain(facts, [check("Sortie quand le z-score remonte au seuil", z, ">=", exit_, "z")])
                if z >= exit_:
                    notes[s] = Note(f"Z-score {z:+.2f} ≥ {exit_:+.2f} : retour à la moyenne atteint, sortie.", m, ex)
                else:
                    keep.append(s)
                    notes[s] = Note(f"Z-score {z:+.2f} encore sous le seuil de sortie : position conservée.", m, ex)
                continue
            ex = explain(facts, [check("Z-score sous le seuil d'entrée", z, "<=", entry, "z")] + ([trend] if trend else []))
            if z <= entry and trend_ok:
                candidates.append((z, s))
                notes[s] = Note(f"Z-score {z:+.2f} ≤ {entry:+.2f} : sous-évaluation statistique, achat.", m, ex)
            elif z <= entry:
                notes[s] = Note(f"Z-score {z:+.2f} mais cours sous la SMA 200 : filtre de tendance.", m, ex)
            else:
                notes[s] = Note(f"Z-score {z:+.2f} : pas de signal.", m, ex)
        candidates.sort()
        room = max(n - len(keep), 0)
        for k, (_, s) in enumerate(candidates):
            notes[s].explain["checks"].append(flag(f"Place libre dans le portefeuille ({n} positions max)", k < room))
        for _, s in candidates[room:]:
            notes[s] = Note(notes[s].reason.replace("achat", "mais plus de place dans le portefeuille"), notes[s].metrics, notes[s].explain)
        chosen = keep + [s for _, s in candidates[:room]]
        return Evaluation({s: 1.0 / n for s in chosen}, notes)


class RelativeStrength(Strategy):
    kind = "relative_strength"
    name = "Force relative"
    summary = "Détenir les actifs qui battent le plus nettement la moyenne de leur univers."
    explanation = (
        "La force relative compare la performance d'un actif à celle de son univers (moyenne équipondérée "
        "des actifs disponibles) sur la même fenêtre. On retient les N actifs à la plus forte surperformance, "
        "à condition qu'elle dépasse le seuil minimum. Contrairement au momentum pur, la stratégie reste "
        "investie dans les meilleurs relatifs même dans un marché baissier, sauf si le filtre absolu est activé."
    )
    params = [
        Param("lookback_days", "Fenêtre de mesure", "choice", 126, LOOKBACK_HELP, choices=LOOKBACK_CHOICES, unit="jours"),
        Param("top_n", "Nombre de lignes", "int", 5, min=1, max=50),
        Param("min_excess_pct", "Surperformance minimum", "float", 0.0, min=-50, max=100, step=0.5, unit="%"),
        Param("require_positive", "Exiger une performance absolue positive", "bool", False),
    ]

    def warmup_days(self) -> int:
        return int(self.p["lookback_days"])

    def evaluate(self, ctx: Context) -> Evaluation:
        lb, n = int(self.p["lookback_days"]), int(self.p["top_n"])
        rets = {}
        for s in tradable(ctx.prices, lb):
            r = trailing_return(ctx.prices[s], lb)
            if r is not None:
                rets[s] = r
        if not rets:
            return Evaluation({}, {})
        avg = sum(rets.values()) / len(rets)
        excess = {s: (1 + r) / (1 + avg) - 1 for s, r in rets.items()}
        ranked = sorted(excess, key=excess.get, reverse=True)
        notes: dict[str, Note] = {}
        chosen = []
        for rank, s in enumerate(ranked, 1):
            m = {"return": rets[s], "universe_return": avg, "relative_strength": excess[s], "rank": rank}
            base = f"Perf. {pct(rets[s])} vs univers {pct(avg)} → force relative {pct(excess[s])}"
            checks = [check(f"Classé parmi les {n} meilleurs", rank, "<=", n, "int"),
                      check("Force relative au-dessus du minimum", excess[s], ">=", self.p["min_excess_pct"] / 100)]
            if self.p["require_positive"]:
                checks.append(check("Performance absolue positive", rets[s], ">", 0.0))
            ex = explain([fact(f"Performance de {{asset}} sur {lb} j", rets[s], subject="asset"),
                          fact(f"Performance moyenne de l'univers sur {lb} j", avg, subject="universe"),
                          fact("Force relative", excess[s], emphasis=True), fact(f"Rang sur {len(ranked)}", rank, "int")], checks)
            if rank > n:
                notes[s] = Note(f"{base} ; rang {rank}, hors sélection.", m, ex)
            elif excess[s] * 100 < self.p["min_excess_pct"]:
                notes[s] = Note(f"{base} ; sous le seuil de {self.p['min_excess_pct']:.1f} %.", m, ex)
            elif self.p["require_positive"] and rets[s] <= 0:
                notes[s] = Note(f"{base} ; performance absolue négative (filtre).", m, ex)
            else:
                chosen.append(s)
                notes[s] = Note(f"{base} ; rang {rank}, sélectionné.", m, ex)
        return Evaluation({s: 1.0 / n for s in chosen}, notes)


class BenchmarkOutperformance(Strategy):
    kind = "benchmark_outperformance"
    name = "Surperformance vs indice"
    summary = "Acheter une action si elle bat l'indice de référence (ex. CAC 40) de X % sur N jours."
    explanation = (
        "À chaque rééquilibrage, la performance de chaque action sur les N derniers jours de bourse est "
        "comparée à celle de l'indice de référence sur exactement la même période. Si l'écart dépasse le "
        "seuil d'entrée X, l'action est achetée. Elle est conservée tant que l'écart reste au-dessus du seuil "
        "de sortie (hystérésis, pour limiter les allers-retours), puis vendue. Si plus d'actions sont "
        "éligibles que de places disponibles, les plus fortes surperformances sont privilégiées."
    )
    uses_benchmark = True
    params = [
        Param("lookback_days", "Période N", "int", 63, LOOKBACK_HELP, min=5, max=504, unit="jours"),
        Param("entry_threshold_pct", "Seuil d'entrée X", "float", 5.0,
              "Surperformance minimale vs l'indice pour acheter.", min=-20, max=100, step=0.5, unit="%"),
        Param("exit_threshold_pct", "Seuil de sortie", "float", 0.0,
              "Vendre si la surperformance passe sous ce niveau.", min=-50, max=100, step=0.5, unit="%"),
        Param("max_positions", "Positions maximum", "int", 8, min=1, max=50),
        Param("weighting", "Pondération", "choice", "equal",
              "« equal » : 1/N par place ; « excess » : proportionnelle à la surperformance.",
              choices=["equal", "excess"]),
    ]

    def validate(self) -> None:
        if self.p["exit_threshold_pct"] > self.p["entry_threshold_pct"]:
            raise ValueError("Le seuil de sortie ne peut pas dépasser le seuil d'entrée.")

    def warmup_days(self) -> int:
        return int(self.p["lookback_days"])

    def evaluate(self, ctx: Context) -> Evaluation:
        lb, n = int(self.p["lookback_days"]), int(self.p["max_positions"])
        entry, exit_ = self.p["entry_threshold_pct"] / 100, self.p["exit_threshold_pct"] / 100
        bench = trailing_return(ctx.benchmark, lb)
        if bench is None:
            return Evaluation(None, {})
        notes: dict[str, Note] = {}
        keep, candidates = [], []
        for s in tradable(ctx.prices, lb):
            r = trailing_return(ctx.prices[s], lb)
            if r is None:
                continue
            excess = r - bench
            m = {"return": r, "benchmark_return": bench, "excess": excess}
            base = f"{pct(r)} sur {lb} j vs indice {pct(bench)} → écart {pct(excess)}"
            held = ctx.weights.get(s, 0) > 0
            facts = [fact(f"Performance de {{asset}} sur {lb} j", r, subject="asset"),
                     fact(f"Performance de {{benchmark}} sur {lb} j", bench, subject="benchmark"),
                     fact("Surperformance", excess, emphasis=True)]
            ex = explain(facts, [check("Seuil de sortie (position détenue)", excess, ">=", exit_) if held
                                 else check("Seuil d'entrée requis", excess, ">=", entry)])
            if held and excess >= exit_:
                keep.append((excess, s))
                notes[s] = Note(f"{base} ≥ seuil de sortie {pct(exit_)} : conservé.", m, ex)
            elif held:
                notes[s] = Note(f"{base} < seuil de sortie {pct(exit_)} : vendu.", m, ex)
            elif excess >= entry:
                candidates.append((excess, s))
                notes[s] = Note(f"{base} ≥ seuil d'entrée {pct(entry)} : acheté.", m, ex)
            else:
                notes[s] = Note(f"{base} < seuil d'entrée {pct(entry)} : non retenu.", m, ex)
        keep.sort(reverse=True)
        candidates.sort(reverse=True)
        selected = (keep + candidates)[:n]
        if len(keep) + len(candidates) > n:
            for k, (_, s) in enumerate(keep + candidates):
                notes[s].explain["checks"].append(flag(f"Parmi les {n} plus fortes surperformances (places disponibles)", k < n))
        for _, s in (keep + candidates)[n:]:
            notes[s] = Note(notes[s].reason.rsplit(":", 1)[0] + ": éligible mais portefeuille complet.", notes[s].metrics, notes[s].explain)
        if self.p["weighting"] == "excess" and selected:
            floor = min(e for e, _ in selected)
            raw = {s: (e - floor) + 0.01 for e, s in selected}
            total = sum(raw.values())
            share = len(selected) / n
            weights = {s: share * v / total for s, v in raw.items()}
        else:
            weights = {s: 1.0 / n for _, s in selected}
        return Evaluation(weights, notes)


class FixedAllocation(Strategy):
    kind = "fixed_allocation"
    name = "Allocation fixe"
    summary = "Maintenir des poids cibles choisis (ex. 80 % Monde / 20 % Nasdaq)."
    explanation = (
        "Le portefeuille est investi selon les poids que vous définissez ; la part non allouée reste en "
        "liquidités. À chaque échéance de rééquilibrage, les lignes qui ont dérivé sont ramenées à leur cible "
        "(on vend ce qui a monté, on achète ce qui a baissé). Les actifs listés doivent faire partie de l'univers."
    )
    params = [
        Param("weights", "Poids cibles", "weights", {"CW8.PA": 80.0, "PUST.PA": 20.0},
              "Pourcentage par symbole ; la somme doit être ≤ 100 %."),
    ]

    def evaluate(self, ctx: Context) -> Evaluation:
        available = set(tradable(ctx.prices, 0))
        targets, notes = {}, {}
        for s, w in self.p["weights"].items():
            if s in available:
                targets[s] = w / 100
                cur = ctx.weights.get(s, 0.0)
                notes[s] = Note(f"Cible {w:.1f} % (poids actuel {cur * 100:.1f} %).", {"target": w / 100, "current": cur},
                                explain([fact("Poids actuel de {asset}", cur, subject="asset"), fact("Poids cible", w / 100, emphasis=True),
                                         fact("Écart à la cible", w / 100 - cur)]))
            else:
                notes[s] = Note(f"Cible {w:.1f} % mais aucune cotation disponible à cette date : reste en liquidités.",
                                explain=explain(checks=[flag("Coté à cette date", False)]))
        return Evaluation(targets, notes)


REGISTRY: dict[str, type[Strategy]] = {
    cls.kind: cls
    for cls in (BuyAndHold, Momentum, MovingAverage, GoldenCross, MeanReversion, RelativeStrength, BenchmarkOutperformance, FixedAllocation)
}


def build(kind: str, params: dict | None) -> Strategy:
    if kind not in REGISTRY:
        raise ValueError(f"Type de stratégie inconnu : {kind}")
    return REGISTRY[kind](params)
