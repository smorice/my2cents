# My2cents

Laboratoire personnel de stratégies d'investissement : explorer, backtester, comparer et simuler des
portefeuilles (DCA inclus) sur données historiques réelles. Servi sur **https://nayonne.ovh/my2cents**.

> Outil de recherche et de simulation. Aucun résultat ne constitue une garantie de performance future.

## Architecture

```
Fournisseur de données (Yahoo…) → Service de données de marché → cours normalisés, datés et sourcés (Postgres)
        → Moteur de backtest → Stratégie → Simulation de portefeuille → Analytics → API → UI
```

```
backend/app
├── main.py            FastAPI, monté sous /my2cents (API sous /my2cents/api, SPA servie à côté) ; logs JSON, X-Request-ID
├── worker.py          processus séparé (python -m app.worker) : exécute les jobs, relance les jobs abandonnés,
│                      planifie le rafraîchissement des cours
├── jobs.py            file de jobs Postgres (FOR UPDATE SKIP LOCKED), progression, heartbeat, reprise après crash
├── bootstrap.py       schéma + migrations (verrou consultatif partagé API/worker), triggers append-only, seed
├── migrations.py      migrations ordonnées et idempotentes (table schema_migrations)
├── models.py          utilisateurs, rôles, sessions, audit, stratégies + versions, backtests + décisions /
│                      transactions / positions, portefeuilles, jobs, instruments, cours, benchmarks, erreurs
├── rbac.py            catalogue explicite des permissions et rôles par défaut
├── audit.py           journal chaîné SHA-256 (+ vérification d'intégrité)
├── observability.py   logs structurés, corrélation requête/job, erreurs applicatives enregistrées (app_errors)
├── runner.py          service backtest : configuration figée, mise en file, exécution dans le worker, hypothèses
├── results.py         stockage ligne à ligne des décisions, transactions et positions finales
├── routers/           auth, admin+audit, strategies, backtests, portfolios, market+dashboard, jobs
├── marketdata/        providers.py (interface + Yahoo), service.py (synchro, fraîcheur, panels), catalog.py (univers, indices)
└── engine/            moteur pur, sans dépendance web ni base
    ├── backtester.py  boucle quotidienne : exécution à l'ouverture, versements, clôture, signaux ; chaque
    │                  transaction référence la décision qui l'a déclenchée
    ├── metrics.py     CAGR, TWR, TRI, volatilité, Sharpe, Sortino, drawdown, bêta/alpha, …
    └── strategies/    Buy & Hold, Momentum, Moyenne mobile, Golden Cross, Retour à la moyenne,
                       Force relative, Surperformance vs indice, Allocation fixe
frontend/              React + Vite + TypeScript + Tailwind + React Query + Recharts
```

## Garanties méthodologiques

- **Pas de biais d'anticipation** : la stratégie ne reçoit que l'historique tronqué à la date de décision
  (clôture J) ; les ordres s'exécutent à l'ouverture de J+1. Un test vérifie que les données futures sont inaccessibles.
- **Frais, slippage, fiscalité** (flat tax avec compensation annuelle et report des moins-values), fractions d'actions optionnelles.
- **Benchmark équitable** : les modèles CAC 40 se comparent au CAC 40 dividendes réinvestis (ETF CAC.PA), car
  les actions sont en cours ajustés. L'indice de prix ^FCHI reste disponible, avec un avertissement.
- **Biais du survivant** : l'univers CAC 40 est la composition récente ; c'est indiqué dans chaque backtest.
- Chaque backtest fige la version de stratégie et sa configuration complète → reproductible.

## Sécurité et traçabilité

- Mots de passe Argon2, politique de robustesse, verrouillage après 5 échecs, limitation par IP.
- Sessions serveur (cookie HttpOnly, Secure, SameSite=Strict), expiration d'inactivité et absolue, révocables.
- MFA TOTP optionnelle. En-tête anti-CSRF obligatoire sur toute requête d'écriture. CSP stricte.
- RBAC : `USER`, `ADMIN`, `RESEARCHER`, `AUDITOR`, `READ_ONLY` ; rôles personnalisés via l'admin.
- Audit : tables `audit_events` et `strategy_versions` protégées par triggers (UPDATE/DELETE/TRUNCATE interdits),
  événements chaînés par empreinte SHA-256 vérifiable depuis l'interface.

## Exploitation

```bash
cp .env.example .env    # puis renseigner les secrets
docker compose up -d --build
docker compose logs -f app worker
```

Deux services applicatifs partagent la même image : `app` (API + SPA) et `worker` (calculs). Un backtest lancé depuis
l'interface crée un job ; le worker le traite et publie sa progression (`GET /api/jobs/{id}`). Arrêter ou redéployer
le worker ne perd rien : un job sans heartbeat depuis 2 minutes est relancé une fois, puis marqué en échec.

Le conteneur `app` rejoint le réseau externe `nayonne_proxy_net` sous l'alias `my2cents-app` ; le Caddyfile
(`/home/ubuntu/robin/infra/caddy/Caddyfile`) route `/my2cents*` vers `my2cents-app:8000`.

Variables utiles (`MY2CENTS_*`) : `ALLOW_REGISTRATION`, `BOOTSTRAP_ADMIN_EMAIL/PASSWORD` (créé au premier
démarrage s'il n'existe pas), `SMTP_*` (sinon les liens de réinitialisation sont générés par un admin).

## Tests

```bash
docker network create m2c-test
docker run -d --name m2c-test-db --network m2c-test -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t -e POSTGRES_DB=t postgres:16-alpine
docker run --rm --network m2c-test -v "$PWD/backend":/src -w /src \
  -e MY2CENTS_DATABASE_URL=postgresql+psycopg://t:t@m2c-test-db:5432/t python:3.12-slim \
  sh -c "pip install -q -r requirements-dev.txt && python -m pytest -q tests"
```

Front : `cd frontend && npm run typecheck && npm run build` (dev : `npm run dev`, proxy vers l'API locale).
