"""Static reference data: tradable universes and the benchmarks offered to users."""

from __future__ import annotations

# Indicative recent CAC 40 composition. Using today's members over the past is a
# survivorship bias, which the app states explicitly in every backtest's assumptions.
CAC40 = {
    "AC.PA": ("Accor", "Consommation"), "AI.PA": ("Air Liquide", "Matériaux"), "AIR.PA": ("Airbus", "Industrie"),
    "MT.AS": ("ArcelorMittal", "Matériaux"), "CS.PA": ("AXA", "Finance"), "BNP.PA": ("BNP Paribas", "Finance"),
    "EN.PA": ("Bouygues", "Industrie"), "BVI.PA": ("Bureau Veritas", "Industrie"), "CAP.PA": ("Capgemini", "Technologie"),
    "CA.PA": ("Carrefour", "Consommation de base"), "ACA.PA": ("Crédit Agricole", "Finance"),
    "BN.PA": ("Danone", "Consommation de base"), "DSY.PA": ("Dassault Systèmes", "Technologie"),
    "EDEN.PA": ("Edenred", "Industrie"), "ENGI.PA": ("Engie", "Services publics"),
    "EL.PA": ("EssilorLuxottica", "Santé"), "ERF.PA": ("Eurofins Scientific", "Santé"),
    "RMS.PA": ("Hermès", "Luxe"), "KER.PA": ("Kering", "Luxe"), "OR.PA": ("L'Oréal", "Consommation de base"),
    "LR.PA": ("Legrand", "Industrie"), "MC.PA": ("LVMH", "Luxe"), "ML.PA": ("Michelin", "Automobile"),
    "ORA.PA": ("Orange", "Télécoms"), "RI.PA": ("Pernod Ricard", "Consommation de base"),
    "PUB.PA": ("Publicis", "Médias"), "RNO.PA": ("Renault", "Automobile"), "SAF.PA": ("Safran", "Industrie"),
    "SGO.PA": ("Saint-Gobain", "Industrie"), "SAN.PA": ("Sanofi", "Santé"), "SU.PA": ("Schneider Electric", "Industrie"),
    "GLE.PA": ("Société Générale", "Finance"), "STLAP.PA": ("Stellantis", "Automobile"),
    "STMPA.PA": ("STMicroelectronics", "Technologie"), "TEP.PA": ("Teleperformance", "Industrie"),
    "HO.PA": ("Thales", "Industrie"), "TTE.PA": ("TotalEnergies", "Énergie"),
    "URW.PA": ("Unibail-Rodamco-Westfield", "Immobilier"), "VIE.PA": ("Veolia", "Services publics"),
    "DG.PA": ("Vinci", "Industrie"),
}

ETFS = {
    "CW8.PA": "Amundi MSCI World (EUR)",
    "ESE.PA": "BNP Paribas Easy S&P 500 (EUR)",
    "PUST.PA": "Amundi PEA Nasdaq-100",
    "CAC.PA": "CAC 40 dividendes réinvestis (ETF Amundi)",
    "C40.PA": "Amundi CAC 40 ESG (Acc)",
    "PAEEM.PA": "Amundi PEA MSCI Emerging",
}

INDICES = {
    "^FCHI": ("CAC 40", "EUR"),
    "^SBF120": ("SBF 120", "EUR"),
    "^STOXX50E": ("Euro Stoxx 50", "EUR"),
    "^GSPC": ("S&P 500", "USD"),
    "^NDX": ("Nasdaq-100", "USD"),
}

UNIVERSES = {
    "cac40": {"label": "CAC 40 (composition récente)", "symbols": list(CAC40)},
    "etf_pea": {"label": "ETF éligibles PEA / européens", "symbols": list(ETFS)},
}


# Benchmarks offered in the UI. `total_return` marks series that include reinvested
# dividends, i.e. a fair comparison against dividend-adjusted stock prices.
BENCHMARKS = [
    ("CAC.PA", "CAC 40 dividendes réinvestis", "ETF Amundi répliquant le CAC 40 Gross Return. Comparaison équitable avec des cours ajustés.", True),
    ("^FCHI", "CAC 40 (indice de prix)", "Indice officiel, hors dividendes : avantage mécaniquement une stratégie d'actions d'environ 2 à 3 % par an.", False),
    ("^SBF120", "SBF 120", "Indice de prix des 120 principales capitalisations françaises.", False),
    ("^STOXX50E", "Euro Stoxx 50", "Indice de prix des 50 plus grandes capitalisations de la zone euro.", False),
    ("CW8.PA", "MSCI World", "ETF Amundi MSCI World en euros, dividendes réinvestis (net).", True),
    ("ESE.PA", "S&P 500 (en euros)", "ETF BNP Paribas Easy S&P 500, dividendes réinvestis, coté en euros.", True),
    ("^GSPC", "S&P 500 (USD, indice de prix)", "Indice de prix en dollars : aucune conversion de change n'est appliquée.", False),
    ("PUST.PA", "Nasdaq-100 (en euros)", "ETF Amundi PEA Nasdaq-100, dividendes réinvestis, coté en euros.", True),
    ("^NDX", "Nasdaq-100 (USD, indice de prix)", "Indice de prix en dollars : aucune conversion de change n'est appliquée.", False),
]
