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

## Parcours et écrans

Landing publique (avec une vraie simulation sur données historiques) → inscription → onboarding en 5 étapes →
tableau de bord (« Comment mes stratégies auraient-elles performé ? », périodes 1M→MAX). Ensuite : Research
(familles de stratégies), bibliothèque de stratégies (versions, fiche, risques), laboratoire `/backtests/new`,
rapport de backtest (performance, risque glissant, allocation, décisions expliquées, transactions, versements,
hypothèses), Strategy Lab `/compare`, portefeuilles simulés, transactions, activité personnelle `/audit`.
Administration `/admin` : vue d'ensemble, tâches (relance / annulation), erreurs, données de marché, stratégies,
utilisateurs, rôles, journal d'audit.

Chaque décision simulée porte une explication structurée (mesures, seuils de la règle, verdict) et chaque
transaction référence la décision qui l'a déclenchée.

## Qualité des données de marché

La source gratuite rate parfois une opération sur titres (restructuration avec dilution massive, regroupement, scission, fusion) : le cours ajusté fait alors un saut d'un jour que personne n'a vécu (Atos +8 528 % le 12/11/2024, Vivendi −78 % le jour de sa scission). `app/marketdata/quality.py` traite tout saut quotidien au-delà de +90 % / −65 % comme une opération non ajustée : l'historique antérieur est remis à l'échelle pour que ce jour compte 0 %, dans les backtests comme dans les calculs d'ordres, et chaque correction est affichée (avertissements du résultat, page Marchés). Les vrais krachs observés sur les grandes et moyennes valeurs parisiennes (Worldline −59 %, MedinCell +78 %) restent sous ces seuils.

## Comptes réels et ordres à passer

Un compte réel (`/accounts`) décrit ce que l'utilisateur détient vraiment : liquidités, titres (quantité, prix de revient), frais du courtier. Il suit une stratégie, et une revue en déduit les ordres à passer :

- **Même logique que le backtest** (`app/engine/live.py`) : évaluation de la stratégie sur les derniers cours, contraintes de risque, tolérance de dérive, ventes avant achats, frais estimés, quantités entières sauf si le courtier accepte les fractions, ordres sous le montant minimum ignorés.
- **Revue complète** au premier jour de bourse de chaque période de rééquilibrage (ou à la demande) ; sinon **contrôle** : stop-loss et investissement des liquidités vers les derniers poids cibles.
- **Revue automatique** chaque soir de semaine (`MY2CENTS_REVIEW_HOUR_UTC`, 22 h par défaut, après la clôture américaine), avec un email si des ordres sont à passer (nécessite `MY2CENTS_SMTP_HOST`).
- Les lignes « hors stratégie » ne sont jamais vendues ni comptées. Les titres détenus hors de l'univers de la stratégie sont proposés à la vente.
- Rien n'est exécuté automatiquement : l'utilisateur passe l'ordre chez son courtier puis saisit l'exécution réelle (quantité, prix, frais), ce qui met à jour positions, liquidités (prix de revient moyen) et le journal des mouvements.

## Sécurité et traçabilité

- Mots de passe Argon2, politique de robustesse, verrouillage après 5 échecs, limitation par IP.
- Sessions serveur (cookie HttpOnly, Secure, SameSite=Strict), expiration d'inactivité et absolue, révocables.
- MFA TOTP optionnelle. En-tête anti-CSRF obligatoire sur toute requête d'écriture. CSP stricte.
- RBAC : `USER`, `ADMIN`, `RESEARCHER`, `AUDITOR`, `READ_ONLY` ; rôles personnalisés via l'admin.
- Limitation de débit par IP sur toute l'API (lectures / écritures), quota de simulations actives par utilisateur.
- Erreurs inattendues : l'utilisateur reçoit une référence, l'administrateur la trace complète (`/admin/errors`).
- Accessibilité vérifiée avec axe-core (WCAG 2.2 AA) sur les pages principales, thèmes clair et sombre.
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
