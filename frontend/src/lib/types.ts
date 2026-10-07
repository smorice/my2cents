export interface User {
  id: string;
  email: string;
  display_name: string;
  is_active: boolean;
  email_verified: boolean;
  totp_enabled: boolean;
  created_at: string;
  last_login_at: string | null;
  role_names: string[];
  permissions: string[];
  preferences: Record<string, unknown>;
}

export interface Param {
  key: string;
  label: string;
  type: "int" | "float" | "bool" | "choice" | "weights";
  default: unknown;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  choices?: (string | number)[];
  unit?: string;
}

export interface StrategyKind {
  kind: string;
  name: string;
  summary: string;
  explanation: string;
  params: Param[];
  default_rebalance: string;
  uses_benchmark: boolean;
}

export interface Definition {
  parameters: Record<string, unknown>;
  universe: { preset: string | null; symbols: string[] };
  benchmark: string;
  rebalance_frequency: string;
  transaction_cost_model: { fee_pct: number; fee_min: number; slippage_bps: number };
  risk_model: { max_weight_pct: number; cash_buffer_pct: number; stop_loss_pct: number };
}

export interface Metrics {
  total_return?: number | null;
  cagr?: number | null;
  volatility?: number | null;
  sharpe?: number | null;
  sortino?: number | null;
  max_drawdown?: number | null;
  max_drawdown_days?: number | null;
  calmar?: number | null;
  positive_months?: number | null;
  best_month?: number | null;
  worst_month?: number | null;
  irr?: number | null;
  beta?: number | null;
  alpha?: number | null;
  correlation?: number | null;
  tracking_error?: number | null;
  information_ratio?: number | null;
  fees?: number;
  slippage?: number;
  taxes?: number;
  trades?: number;
  annual_turnover?: number;
  avg_exposure?: number;
  total_invested?: number;
  final_value?: number;
  net_profit?: number;
  years?: number;
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
  kind: string;
  status: "draft" | "active" | "inactive" | "archived";
  is_template: boolean;
  current_version: number;
  cloned_from: string | null;
  owner_id: string | null;
  author: string | null;
  created_at: string;
  updated_at: string;
  definition: Definition | null;
  rules: string[];
  can_edit: boolean;
  last_backtest: { id: string; created_at: string; summary: Metrics | null } | null;
}

export interface Version {
  version: number;
  definition: Definition;
  change_note: string;
  created_by: string | null;
  created_at: string;
}

export interface BacktestConfig {
  start: string;
  end: string;
  initial_capital: number;
  contributions: { amount: number; frequency: string; start: string | null; end: string | null };
  tax_mode: string;
  tax_rate_pct: number;
  fractional: boolean;
  risk_free_pct: number;
  universe: string[];
  universe_preset: string | null;
  benchmark: string;
  rebalance: string;
  costs: Definition["transaction_cost_model"];
  risk: Definition["risk_model"];
  kind: string;
  parameters: Record<string, unknown>;
}

export interface BacktestRow {
  id: string;
  name: string;
  status: "queued" | "running" | "done" | "failed";
  strategy_id: string;
  strategy_name: string | null;
  strategy_kind: string | null;
  strategy_version: number;
  portfolio_id: string | null;
  config: BacktestConfig;
  summary: { strategy: Metrics; benchmark: Metrics } | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Trade {
  date: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  value: number;
  fees: number;
  tax: number;
  realized_pnl: number | null;
  reason: string;
}

export interface Decision {
  date: string;
  symbol: string;
  action: "buy" | "sell" | "increase" | "decrease" | "hold" | "skip";
  prev_weight: number;
  target_weight: number;
  reason: string;
  metrics: Record<string, number | null>;
}

export interface Results {
  summary: { strategy: Metrics; benchmark: Metrics };
  series: {
    dates: string[];
    equity: number[];
    invested: number[];
    benchmark_equity: number[];
    twr: number[];
    benchmark_twr: number[];
    drawdown: number[];
    benchmark_drawdown: number[];
    cash_weight: number[];
  };
  monthly_returns: { year: number; month: number; return: number | null }[];
  yearly: { year: number; strategy: number | null; benchmark: number | null }[];
  positions: { symbol: string; name: string; qty: number; avg_cost: number; price: number; value: number; weight: number; unrealized_pnl: number; unrealized_pct: number }[];
  attribution: { symbol: string; name: string; pnl: number }[];
  trades: Trade[];
  contributions: { date: string; amount: number; cumulative: number; portfolio_value: number }[];
  allocation_history: { date: string; weights: Record<string, number>; cash: number }[];
  warnings: string[];
  assumptions: string[];
  names: Record<string, string>;
  effective_period: { start: string; end: string };
  decision_count: number;
}

export interface BacktestFull extends BacktestRow {
  results?: Results;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface Instrument {
  symbol: string;
  name: string;
  kind: string;
  currency: string;
  sector: string | null;
  universes: string[];
  first_date: string | null;
  last_date: string | null;
  last_synced_at: string | null;
  sync_error: string | null;
}

export interface Portfolio {
  id: string;
  name: string;
  description: string;
  strategy_id: string | null;
  strategy_version: number | null;
  strategy_name: string | null;
  strategy_kind: string | null;
  strategy_current_version: number | null;
  settings: {
    start: string;
    end: string | null;
    initial_capital: number;
    contributions: { amount: number; frequency: string; start: string | null; end: string | null };
    tax_mode: string;
    fractional: boolean;
  };
  archived: boolean;
  created_at: string;
  updated_at: string;
  latest_simulation: { id: string; status: string; created_at: string; error: string | null; summary: Metrics | null; benchmark: Metrics | null } | null;
  history?: { id: string; status: string; created_at: string; strategy_version: number; summary: Metrics | null }[];
}

export interface AuditEvent {
  id: number;
  occurred_at: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  outcome: "success" | "failure" | "denied";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  hash: string;
}
