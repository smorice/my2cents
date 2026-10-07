from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

Frequency = Literal["daily", "weekly", "monthly", "quarterly", "yearly", "never"]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ----------------------------------------------------------------- auth


class RegisterIn(BaseModel):
    email: EmailStr
    display_name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=256)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(max_length=256)


class CodeIn(BaseModel):
    code: str = Field(min_length=6, max_length=8)


class MfaDisableIn(CodeIn):
    password: str = Field(max_length=256)


class PasswordChangeIn(BaseModel):
    current_password: str = Field(max_length=256)
    new_password: str = Field(max_length=256)


class ForgotIn(BaseModel):
    email: EmailStr


class ResetIn(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    password: str = Field(max_length=256)


class ProfileIn(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    preferences: dict[str, Any] | None = None


class UserOut(ORM):
    id: uuid.UUID
    email: str
    display_name: str
    is_active: bool
    email_verified: bool
    totp_enabled: bool
    created_at: datetime
    last_login_at: datetime | None
    role_names: list[str]
    permissions: list[str]
    preferences: dict[str, Any]

    @field_validator("permissions", mode="before")
    @classmethod
    def _sorted(cls, v: Any) -> list[str]:
        return sorted(v)


class SessionOut(ORM):
    id: uuid.UUID
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    ip: str | None
    user_agent: str | None
    current: bool = False


# ----------------------------------------------------------------- admin


class AdminUserPatch(BaseModel):
    is_active: bool | None = None
    roles: list[str] | None = None
    display_name: str | None = Field(default=None, min_length=1, max_length=80)


class RoleIn(BaseModel):
    description: str = Field(default="", max_length=400)
    permissions: list[str]


class RoleOut(ORM):
    id: int
    name: str
    description: str
    permissions: list[str]
    is_system: bool


class AuditOut(ORM):
    id: int
    occurred_at: datetime
    actor_id: uuid.UUID | None
    actor_email: str | None
    action: str
    resource_type: str | None
    resource_id: str | None
    outcome: str
    before: dict | None
    after: dict | None
    details: dict | None
    ip: str | None
    user_agent: str | None
    hash: str


# ----------------------------------------------------------------- strategies


class CostModelIn(BaseModel):
    fee_pct: float = Field(0.1, ge=0, le=5)
    fee_min: float = Field(0.0, ge=0, le=100)
    slippage_bps: float = Field(5.0, ge=0, le=200)


class RiskModelIn(BaseModel):
    max_weight_pct: float = Field(100.0, gt=0, le=100)
    cash_buffer_pct: float = Field(0.0, ge=0, lt=100)
    stop_loss_pct: float = Field(0.0, ge=0, le=90)


class UniverseIn(BaseModel):
    preset: str | None = "cac40"
    symbols: list[str] = Field(default_factory=list, max_length=200)

    @field_validator("symbols")
    @classmethod
    def _upper(cls, v: list[str]) -> list[str]:
        out = []
        for s in v:
            s = s.strip().upper()
            if not s or len(s) > 24 or not all(c.isalnum() or c in ".^-=" for c in s):
                raise ValueError(f"Symbole invalide : {s!r}")
            if s not in out:
                out.append(s)
        return out


class StrategyDefinition(BaseModel):
    parameters: dict[str, Any] = Field(default_factory=dict)
    universe: UniverseIn = Field(default_factory=UniverseIn)
    benchmark: str = "^FCHI"
    rebalance_frequency: Frequency = "monthly"
    transaction_cost_model: CostModelIn = Field(default_factory=CostModelIn)
    risk_model: RiskModelIn = Field(default_factory=RiskModelIn)


class StrategyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=4000)
    kind: str
    definition: StrategyDefinition = Field(default_factory=StrategyDefinition)


class StrategyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    definition: StrategyDefinition | None = None
    change_note: str = Field(default="", max_length=1000)
    expected_version: int | None = None


class StatusIn(BaseModel):
    status: Literal["draft", "active", "inactive", "archived"]


class CloneIn(BaseModel):
    name: str | None = Field(default=None, max_length=120)


class VersionOut(ORM):
    version: int
    definition: dict
    change_note: str
    created_by: uuid.UUID | None
    created_at: datetime


class StrategyOut(ORM):
    id: uuid.UUID
    name: str
    description: str
    kind: str
    status: str
    is_template: bool
    current_version: int
    cloned_from: uuid.UUID | None
    owner_id: uuid.UUID | None
    author: str | None = None
    created_at: datetime
    updated_at: datetime
    definition: dict | None = None
    rules: list[str] = Field(default_factory=list)
    can_edit: bool = False
    last_backtest: dict | None = None


# ----------------------------------------------------------------- backtests


class ContributionsIn(BaseModel):
    amount: float = Field(0.0, ge=0, le=1_000_000)
    frequency: Literal["none", "weekly", "monthly", "quarterly"] = "none"
    start: date | None = None
    end: date | None = None


class BacktestIn(BaseModel):
    strategy_id: uuid.UUID
    version: int | None = None
    name: str | None = Field(default=None, max_length=160)
    start: date
    end: date
    initial_capital: float = Field(10_000, ge=0, le=1_000_000_000)
    contributions: ContributionsIn = Field(default_factory=ContributionsIn)
    tax_mode: Literal["none", "pfu"] = "none"
    tax_rate_pct: float = Field(30.0, ge=0, le=60)
    fractional: bool = True
    risk_free_pct: float = Field(2.0, ge=-5, le=20)
    # Optional overrides of the strategy definition (the version itself is never modified)
    universe: UniverseIn | None = None
    benchmark: str | None = None
    rebalance_frequency: Frequency | None = None
    transaction_cost_model: CostModelIn | None = None
    risk_model: RiskModelIn | None = None

    @model_validator(mode="after")
    def _check(self) -> "BacktestIn":
        if self.end <= self.start:
            raise ValueError("La date de fin doit être postérieure à la date de début.")
        if self.start < date(1995, 1, 1):
            raise ValueError("Date de début trop ancienne (minimum 1995).")
        if self.initial_capital == 0 and (self.contributions.frequency == "none" or self.contributions.amount == 0):
            raise ValueError("Capital initial nul : définissez au moins des versements programmés.")
        return self


class BatchIn(BaseModel):
    strategy_ids: list[uuid.UUID] = Field(min_length=1, max_length=8)
    base: BacktestIn


class BacktestListOut(ORM):
    id: uuid.UUID
    name: str
    status: str
    strategy_id: uuid.UUID
    strategy_name: str | None = None
    strategy_kind: str | None = None
    strategy_version: int
    portfolio_id: uuid.UUID | None
    config: dict
    summary: dict | None
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    job_id: uuid.UUID | None = None
    progress: float | None = None
    progress_message: str | None = None


# ----------------------------------------------------------------- portfolios


class PortfolioSettings(BaseModel):
    start: date
    end: date | None = None
    initial_capital: float = Field(10_000, ge=0, le=1_000_000_000)
    contributions: ContributionsIn = Field(default_factory=ContributionsIn)
    tax_mode: Literal["none", "pfu"] = "none"
    fractional: bool = False


class PortfolioIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    strategy_id: uuid.UUID
    strategy_version: int | None = None
    settings: PortfolioSettings
    # Only EUR is simulated today: no FX conversion is applied anywhere.
    currency: Literal["EUR"] = "EUR"
    benchmark: str | None = Field(default=None, max_length=24)


class PortfolioPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    strategy_id: uuid.UUID | None = None
    strategy_version: int | None = None
    settings: PortfolioSettings | None = None
    archived: bool | None = None
    currency: Literal["EUR"] | None = None
    benchmark: str | None = Field(default=None, max_length=24)


class InstrumentIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=24)
    kind: Literal["equity", "etf", "index"] | None = None  # from a search hit; new symbols default to equity


# ----------------------------------------------------------------- real accounts


class AccountIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    strategy_id: uuid.UUID | None = None
    strategy_version: int | None = None
    cash: float = Field(0, ge=0, le=1_000_000_000)
    fee_pct: float = Field(0.1, ge=0, le=5)
    fee_min: float = Field(0, ge=0, le=100)
    fractional: bool = False
    min_order_value: float = Field(50, ge=0, le=1_000_000)
    auto_review: bool = True
    notify_email: bool = True


class AccountPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    strategy_id: uuid.UUID | None = None
    strategy_version: int | None = None
    cash: float | None = Field(default=None, ge=0, le=1_000_000_000)
    fee_pct: float | None = Field(default=None, ge=0, le=5)
    fee_min: float | None = Field(default=None, ge=0, le=100)
    fractional: bool | None = None
    min_order_value: float | None = Field(default=None, ge=0, le=1_000_000)
    auto_review: bool | None = None
    notify_email: bool | None = None
    archived: bool | None = None


class PositionIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=24)
    qty: float = Field(gt=0, le=1_000_000_000)
    avg_cost: float = Field(0, ge=0, le=1_000_000_000)
    locked: bool = False

    @field_validator("symbol")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.strip().upper()


class MovementIn(BaseModel):
    kind: Literal["buy", "sell", "deposit", "withdrawal"]
    date: date
    symbol: str | None = Field(default=None, max_length=24)
    qty: float | None = Field(default=None, gt=0, le=1_000_000_000)
    price: float | None = Field(default=None, gt=0, le=1_000_000_000)
    fees: float = Field(0, ge=0, le=1_000_000)
    amount: float | None = Field(default=None, gt=0, le=1_000_000_000)  # deposits / withdrawals
    note: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def _shape(self) -> "MovementIn":
        if self.kind in ("buy", "sell"):
            if not (self.symbol and self.qty and self.price):
                raise ValueError("Un achat ou une vente demande un titre, une quantité et un prix.")
            self.symbol = self.symbol.strip().upper()
        elif not self.amount:
            raise ValueError("Indiquez le montant du versement ou du retrait.")
        return self


class FillIn(BaseModel):
    qty: float = Field(gt=0, le=1_000_000_000)
    price: float = Field(gt=0, le=1_000_000_000)
    fees: float = Field(0, ge=0, le=1_000_000)
    date: date
