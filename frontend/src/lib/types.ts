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
  family: string;
  complexity: 1 | 2 | 3;
  horizon: string;
  risk_level: 1 | 2 | 3;
  risks: string[];
}

export interface BenchmarkInfo {
  symbol: string;
  label: string;
  description: string;
  total_return: boolean;
  currency: string;
  kind: string;
  first_date: string | null;
  last_date: string | null;
  last_synced_at: string | null;
  available: boolean;
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
  job_id: string | null;
  progress: number | null;
  progress_message: string | null;
}

export interface Trade {
  seq: number;
  decision_seq: number | null;
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

export interface Fact {
  label: string;
  value: number | null;
  fmt: "pct" | "num" | "z" | "int";
  subject?: "asset" | "benchmark" | "universe";
  emphasis?: boolean;
}

export interface Check {
  label: string;
  passed: boolean;
  value?: number | null;
  op?: ">=" | ">" | "<=" | "<";
  threshold?: number;
  fmt?: Fact["fmt"];
}

export interface Explain {
  facts: Fact[];
  checks: Check[];
}

export interface Decision {
  seq: number;
  explain: Explain | null;
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
  contributions: { date: string; amount: number; cumulative: number; portfolio_value: number }[];
  allocation_history: { date: string; weights: Record<string, number>; cash: number }[];
  warnings: string[];
  assumptions: string[];
  names: Record<string, string>;
  effective_period: { start: string; end: string };
  counts: { decisions: number; trades: number; positions: number };
  data_as_of: string | null;
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
  currency: string;
  benchmark: string | null;
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

// ------------------------------------------------------------------ real accounts

export interface JobInfo {
  id: string;
  kind: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  message: string | null;
  error: string | null;
}

export interface AccountPosition {
  symbol: string;
  name: string;
  qty: number;
  avg_cost: number;
  locked: boolean;
  price: number | null;
  price_date: string | null;
  value: number | null;
  pnl: number | null;
  pnl_pct: number | null;
  weight: number | null;
}

export interface ProposedOrder {
  id: string;
  seq: number;
  side: "buy" | "sell";
  symbol: string;
  qty: number;
  price: number;
  value: number;
  fee_estimate: number;
  action: "buy" | "sell" | "increase" | "decrease";
  prev_weight: number;
  target_weight: number;
  reason: string;
  explain: Explain | null;
  status: "pending" | "executed" | "skipped";
  resolved_at: string | null;
}

export interface Proposal {
  id: string;
  created_at: string;
  as_of: string;
  trigger: "manual" | "scheduled";
  mode: "full" | "light";
  status: "open" | "closed" | "superseded";
  strategy_version: number | null;
  value: number;
  cash: number;
  cash_after: number;
  warnings: string[];
  emailed_at: string | null;
  names: Record<string, string>;
  decisions: Omit<Decision, "seq" | "date">[];
  orders: ProposedOrder[];
}

export interface Account {
  id: string;
  name: string;
  strategy_id: string | null;
  strategy_version: number | null;
  strategy_name: string | null;
  strategy_kind: string | null;
  strategy_current_version: number | null;
  rebalance: string | null;
  rebalance_label: string | null;
  benchmark: string | null;
  cash: number;
  currency: string;
  fee_pct: number;
  fee_min: number;
  fractional: boolean;
  min_order_value: number;
  auto_review: boolean;
  notify_email: boolean;
  archived: boolean;
  invested: number;
  total: number;
  pending_orders: number;
  latest_proposal_at: string | null;
  last_review_at: string | null;
  last_full_on: string | null;
  created_at: string;
  updated_at: string;
  // detail only
  positions?: AccountPosition[];
  latest_proposal?: Proposal | null;
  mail_enabled?: boolean;
  review_job?: JobInfo | null;
  universe?: string[];
}

export interface AccountMovement {
  id: number;
  date: string;
  kind: "buy" | "sell" | "deposit" | "withdrawal";
  symbol: string | null;
  qty: number | null;
  price: number | null;
  fees: number;
  amount: number;
  realized_pnl: number | null;
  order_id: string | null;
  note: string;
}

export interface ProposalRow {
  id: string;
  created_at: string;
  as_of: string;
  trigger: "manual" | "scheduled";
  mode: "full" | "light";
  status: "open" | "closed" | "superseded";
  orders: number;
  executed: number;
  emailed_at: string | null;
}
