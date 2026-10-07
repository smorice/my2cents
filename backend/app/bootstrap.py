"""Schema creation, DB-level guarantees and seed data. Idempotent."""

import logging
import threading
import time

from sqlalchemy import select, text

from . import audit
from .config import get_settings
from .db import Base, SessionLocal, engine
from .engine.data import CAC40, ETFS, INDICES, ensure_fresh, seed_instruments
from .models import Role, Strategy, StrategyVersion, User
from .rbac import DEFAULT_ROLES
from .security import hash_password

log = logging.getLogger(__name__)

APPEND_ONLY_SQL = """
CREATE OR REPLACE FUNCTION m2c_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_events', 'strategy_versions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_no_update ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_no_update BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION m2c_forbid_change()', t, t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I_no_truncate ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION m2c_forbid_change()', t, t);
  END LOOP;
END $$;
"""

_COST = {"fee_pct": 0.1, "fee_min": 0.0, "slippage_bps": 5.0}
_RISK = {"max_weight_pct": 100.0, "cash_buffer_pct": 0.0, "stop_loss_pct": 0.0}

TEMPLATES = [
    ("buy_and_hold", "Buy & Hold CAC 40", "Référence passive : le panier CAC 40 équipondéré, acheté une fois et conservé.",
     {}, "cac40", "CAC.PA", "never"),
    ("momentum", "Momentum 6 mois — Top 5 CAC 40", "Les 5 valeurs du CAC 40 les plus performantes sur 6 mois, revues chaque mois.",
     {"lookback_days": 126, "top_n": 5, "require_positive": True}, "cac40", "CAC.PA", "monthly"),
    ("moving_average", "Tendance SMA 200", "Chaque valeur du CAC 40 n'est détenue que si son cours est au-dessus de sa moyenne 200 jours.",
     {"sma_period": 200, "band_pct": 1.0}, "cac40", "CAC.PA", "weekly"),
    ("golden_cross", "Golden Cross 50/200", "Détenir une valeur tant que sa moyenne 50 jours est au-dessus de sa moyenne 200 jours.",
     {"fast": 50, "slow": 200}, "cac40", "CAC.PA", "weekly"),
    ("mean_reversion", "Retour à la moyenne 20 j", "Acheter les excès de baisse (z-score < −2) dans une tendance de fond haussière.",
     {"window": 20, "entry_z": -2.0, "exit_z": 0.0, "max_positions": 5, "trend_filter": True}, "cac40", "CAC.PA", "daily"),
    ("relative_strength", "Force relative 3 mois", "Les 5 valeurs qui battent le plus nettement la moyenne du CAC 40 sur 3 mois.",
     {"lookback_days": 63, "top_n": 5, "min_excess_pct": 0.0}, "cac40", "CAC.PA", "monthly"),
    ("benchmark_outperformance", "Surperformance CAC 40 : +5 % sur 3 mois",
     "Acheter une action du CAC 40 si elle bat l'indice de plus de 5 % sur les 63 derniers jours de bourse ; la vendre quand l'avance disparaît.",
     {"lookback_days": 63, "entry_threshold_pct": 5.0, "exit_threshold_pct": 0.0, "max_positions": 8, "weighting": "equal"},
     "cac40", "CAC.PA", "weekly"),
    ("fixed_allocation", "Allocation 80 % Monde / 20 % Nasdaq", "Portefeuille ETF PEA simple, rééquilibré chaque trimestre.",
     {"weights": {"CW8.PA": 80.0, "PUST.PA": 20.0}}, None, "CW8.PA", "quarterly"),
]


def init_db() -> None:
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text(APPEND_ONLY_SQL))


def seed() -> None:
    settings = get_settings()
    with SessionLocal() as db:
        for name, (desc, perms) in DEFAULT_ROLES.items():
            role = db.scalar(select(Role).where(Role.name == name))
            if role is None:
                db.add(Role(name=name, description=desc, permissions=sorted(str(p) for p in perms), is_system=True))
            elif name == "ADMIN":
                role.permissions = sorted(str(p) for p in perms)  # ADMIN always has everything
        db.commit()
        seed_instruments(db)

        from .engine.strategies.library import build

        for kind, name, desc, params, preset, bench, freq in TEMPLATES:
            if db.scalar(select(Strategy.id).where(Strategy.is_template, Strategy.kind == kind, Strategy.name == name)):
                continue
            s = Strategy(name=name, description=desc, kind=kind, status="active", is_template=True, current_version=1)
            db.add(s)
            db.flush()
            definition = {
                "parameters": build(kind, params).p,
                "universe": {"preset": preset, "symbols": [] if preset else sorted(params.get("weights", {}))},
                "benchmark": bench, "rebalance_frequency": freq,
                "transaction_cost_model": dict(_COST), "risk_model": dict(_RISK),
            }
            db.add(StrategyVersion(strategy_id=s.id, version=1, definition=definition, change_note="Modèle initial"))
            audit.record(db, "strategy.template_seed", resource_type="strategy", resource_id=s.id, after={"name": name, "kind": kind})
        db.commit()

        # v2 of the CAC 40 templates: compare against a dividends-reinvested benchmark,
        # since the strategies themselves trade on dividend-adjusted prices.
        for s in db.scalars(select(Strategy).where(Strategy.is_template, Strategy.current_version == 1)).unique().all():
            cur = next(v for v in s.versions if v.version == 1)
            if cur.definition.get("benchmark") == "^FCHI":
                s.current_version = 2
                db.add(StrategyVersion(strategy_id=s.id, version=2, definition={**cur.definition, "benchmark": "CAC.PA"},
                                       change_note="Indice de référence : CAC 40 dividendes réinvestis (ETF) au lieu de l'indice de prix"))
                audit.record(db, "strategy.update", resource_type="strategy", resource_id=s.id,
                             before={"benchmark": "^FCHI", "version": 1}, after={"benchmark": "CAC.PA", "version": 2})
        db.commit()

        if settings.bootstrap_admin_email and settings.bootstrap_admin_password:
            email = settings.bootstrap_admin_email.lower()
            user = db.scalar(select(User).where(User.email == email))
            admin_role = db.scalar(select(Role).where(Role.name == "ADMIN"))
            if user is None:
                user = User(email=email, display_name=email.split("@")[0], password_hash=hash_password(settings.bootstrap_admin_password),
                            email_verified=True)
                user.roles = [admin_role, db.scalar(select(Role).where(Role.name == "USER"))]
                db.add(user)
                db.flush()
                audit.record(db, "user.bootstrap_admin", resource_type="user", resource_id=user.id, after={"email": email, "roles": user.role_names})
                db.commit()
                log.info("bootstrap admin %s created", email)


def _refresh_loop() -> None:
    settings = get_settings()
    symbols = list(INDICES) + list(ETFS) + list(CAC40)
    while True:
        try:
            with SessionLocal() as db:
                warnings = ensure_fresh(db, symbols, settings.market_data_refresh_hours)
                for w in warnings:
                    log.warning(w)
        except Exception:  # noqa: BLE001
            log.exception("market data refresh failed")
        time.sleep(3600)


def start_market_refresher() -> None:
    threading.Thread(target=_refresh_loop, name="market-refresh", daemon=True).start()
