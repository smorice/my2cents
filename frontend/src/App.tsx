import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Shell } from "./components/Shell";
import { Loading } from "./components/ui";
import { useAuth } from "./lib/auth";
import { AuditPage } from "./pages/admin/Audit";
import { RolesPage } from "./pages/admin/Roles";
import { UsersPage } from "./pages/admin/Users";
import { ForgotPage, LoginPage, RegisterPage, ResetPage } from "./pages/Auth";
import { BacktestPage } from "./pages/Backtest";
import { BacktestsPage } from "./pages/Backtests";
import { ComparePage } from "./pages/Compare";
import { DashboardPage } from "./pages/Dashboard";
import { MarketsPage } from "./pages/Markets";
import { PortfolioPage, PortfoliosPage } from "./pages/Portfolios";
import { SettingsPage } from "./pages/Settings";
import { StrategiesPage } from "./pages/Strategies";
import { StrategyEditPage } from "./pages/StrategyEdit";
import { StrategyPage } from "./pages/Strategy";

function Protected() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <Shell />;
}

function Guard({ perm, children }: { perm: string; children: JSX.Element }) {
  const { can } = useAuth();
  return can(perm) ? children : <div className="card card-pad text-sm text-ink2">Vous n'avez pas la permission d'accéder à cette page.</div>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPage />} />
      <Route path="/reset-password" element={<ResetPage />} />
      <Route element={<Protected />}>
        <Route index element={<DashboardPage />} />
        <Route path="strategies" element={<Guard perm="strategy:read"><StrategiesPage /></Guard>} />
        <Route path="strategies/new" element={<Guard perm="strategy:create"><StrategyEditPage /></Guard>} />
        <Route path="strategies/:id" element={<Guard perm="strategy:read"><StrategyPage /></Guard>} />
        <Route path="strategies/:id/edit" element={<Guard perm="strategy:read"><StrategyEditPage /></Guard>} />
        <Route path="backtests" element={<Guard perm="backtest:read"><BacktestsPage /></Guard>} />
        <Route path="backtests/:id" element={<Guard perm="backtest:read"><BacktestPage /></Guard>} />
        <Route path="compare" element={<Guard perm="backtest:read"><ComparePage /></Guard>} />
        <Route path="portfolios" element={<Guard perm="portfolio:read"><PortfoliosPage /></Guard>} />
        <Route path="portfolios/:id" element={<Guard perm="portfolio:read"><PortfolioPage /></Guard>} />
        <Route path="markets" element={<Guard perm="market:read"><MarketsPage /></Guard>} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="admin/users" element={<Guard perm="user:admin"><UsersPage /></Guard>} />
        <Route path="admin/roles" element={<Guard perm="role:admin"><RolesPage /></Guard>} />
        <Route path="admin/audit" element={<Guard perm="audit:read"><AuditPage /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
