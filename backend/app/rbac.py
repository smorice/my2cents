"""Explicit permission catalogue and default role definitions.

Roles live in the database (so new ones can be added without a deploy), but the
permission vocabulary is fixed in code: an endpoint can only ever check for a
permission listed here.
"""

from enum import StrEnum


class Perm(StrEnum):
    STRATEGY_READ = "strategy:read"
    STRATEGY_CREATE = "strategy:create"
    STRATEGY_UPDATE = "strategy:update"
    STRATEGY_DELETE = "strategy:delete"
    STRATEGY_MANAGE_TEMPLATES = "strategy:manage_templates"
    BACKTEST_READ = "backtest:read"
    BACKTEST_RUN = "backtest:run"
    BACKTEST_DELETE = "backtest:delete"
    PORTFOLIO_READ = "portfolio:read"
    PORTFOLIO_WRITE = "portfolio:write"
    MARKET_READ = "market:read"
    MARKET_REFRESH = "market:refresh"
    AUDIT_READ = "audit:read"
    USER_ADMIN = "user:admin"
    ROLE_ADMIN = "role:admin"


PERMISSION_LABELS: dict[str, str] = {
    Perm.STRATEGY_READ: "Consulter les stratégies",
    Perm.STRATEGY_CREATE: "Créer une stratégie",
    Perm.STRATEGY_UPDATE: "Modifier une stratégie",
    Perm.STRATEGY_DELETE: "Supprimer une stratégie",
    Perm.STRATEGY_MANAGE_TEMPLATES: "Gérer les stratégies modèles",
    Perm.BACKTEST_READ: "Consulter les backtests",
    Perm.BACKTEST_RUN: "Lancer un backtest",
    Perm.BACKTEST_DELETE: "Supprimer un backtest",
    Perm.PORTFOLIO_READ: "Consulter les portefeuilles",
    Perm.PORTFOLIO_WRITE: "Créer / modifier un portefeuille",
    Perm.MARKET_READ: "Consulter les données de marché",
    Perm.MARKET_REFRESH: "Rafraîchir les données de marché",
    Perm.AUDIT_READ: "Consulter le journal d'audit",
    Perm.USER_ADMIN: "Administrer les utilisateurs",
    Perm.ROLE_ADMIN: "Administrer les rôles",
}

_READ = [Perm.STRATEGY_READ, Perm.BACKTEST_READ, Perm.PORTFOLIO_READ, Perm.MARKET_READ]
_USER = _READ + [
    Perm.STRATEGY_CREATE,
    Perm.STRATEGY_UPDATE,
    Perm.STRATEGY_DELETE,
    Perm.BACKTEST_RUN,
    Perm.BACKTEST_DELETE,
    Perm.PORTFOLIO_WRITE,
]

DEFAULT_ROLES: dict[str, tuple[str, list[str]]] = {
    "USER": ("Utilisateur standard : stratégies, backtests et portefeuilles personnels.", _USER),
    "ADMIN": ("Administration complète de la plateforme.", list(Perm)),
    "RESEARCHER": (
        "Utilisateur avancé : peut aussi gérer les modèles et rafraîchir les données.",
        _USER + [Perm.STRATEGY_MANAGE_TEMPLATES, Perm.MARKET_REFRESH],
    ),
    "AUDITOR": ("Lecture seule + journal d'audit.", _READ + [Perm.AUDIT_READ]),
    "READ_ONLY": ("Lecture seule.", _READ),
}
