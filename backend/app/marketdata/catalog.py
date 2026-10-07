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

# The other 79 members of the SBF 120 (CAC Next 20 + CAC Mid 60), composition of late January 2025
# taken from the published ISIN list and mapped to Yahoo symbols; members delisted since (Neoen) are left out.
SBF120_EXTRA = {
    "ADP.PA": ("Aéroports de Paris", "Industrie"), "AF.PA": ("Air France-KLM", "Industrie"), "ALO.PA": ("Alstom", "Industrie"),
    "ATE.PA": ("Alten", "Technologie"), "AMUN.PA": ("Amundi", "Finance"), "APAM.AS": ("Aperam", "Matériaux"),
    "ARG.PA": ("Argan", "Immobilier"), "AKE.PA": ("Arkema", "Matériaux"), "ATO.PA": ("Atos", "Technologie"),
    "AYV.PA": ("Ayvens", "Finance"), "BEN.PA": ("Bénéteau", "Consommation"), "BB.PA": ("Bic", "Consommation de base"),
    "BIM.PA": ("bioMérieux", "Santé"), "BOL.PA": ("Bolloré", "Industrie"), "CARM.PA": ("Carmila", "Immobilier"),
    "CLARI.PA": ("Clariane", "Santé"), "COFA.PA": ("Coface", "Finance"), "COV.PA": ("Covivio", "Immobilier"),
    "AM.PA": ("Dassault Aviation", "Industrie"), "DBG.PA": ("Derichebourg", "Industrie"), "FGR.PA": ("Eiffage", "Industrie"),
    "ELIOR.PA": ("Elior", "Consommation"), "ELIS.PA": ("Elis", "Industrie"), "EMEIS.PA": ("Emeis", "Santé"),
    "ERA.PA": ("Eramet", "Matériaux"), "NAE.PA": ("North Atlantic Energies (ex-Esso)", "Énergie"), "RF.PA": ("Eurazeo", "Finance"),
    "ENX.PA": ("Euronext", "Finance"), "FDJU.PA": ("FDJ United", "Consommation"), "FRVIA.PA": ("Forvia", "Automobile"),
    "GTT.PA": ("Gaztransport & Technigaz", "Énergie"), "GFC.PA": ("Gecina", "Immobilier"), "GET.PA": ("Getlink", "Industrie"),
    "ICAD.PA": ("Icade", "Immobilier"), "IDL.PA": ("ID Logistics", "Industrie"), "NK.PA": ("Imerys", "Matériaux"),
    "ITP.PA": ("Interparfums", "Consommation"), "IPN.PA": ("Ipsen", "Santé"), "IPS.PA": ("Ipsos", "Médias"),
    "DEC.PA": ("JCDecaux", "Médias"), "LI.PA": ("Klépierre", "Immobilier"), "MAU.PA": ("Maurel & Prom", "Énergie"),
    "MEDCL.PA": ("MedinCell", "Santé"), "MERY.PA": ("Mercialys", "Immobilier"), "MRN.PA": ("Mersen", "Industrie"),
    "MMT.PA": ("M6 Métropole Télévision", "Médias"), "NEX.PA": ("Nexans", "Industrie"), "NXI.PA": ("Nexity", "Immobilier"),
    "OPM.PA": ("OPmobility", "Automobile"), "PLNW.PA": ("Planisware", "Technologie"), "PLX.PA": ("Pluxee", "Industrie"),
    "RCO.PA": ("Rémy Cointreau", "Consommation de base"), "RXL.PA": ("Rexel", "Industrie"), "RBT.PA": ("Robertet", "Matériaux"),
    "RUI.PA": ("Rubis", "Énergie"), "SK.PA": ("SEB", "Consommation"), "DIM.PA": ("Sartorius Stedim Biotech", "Santé"),
    "SCR.PA": ("SCOR", "Finance"), "SESG.PA": ("SES", "Télécoms"), "SW.PA": ("Sodexo", "Consommation"),
    "SOI.PA": ("Soitec", "Technologie"), "SOLB.BR": ("Solvay", "Matériaux"), "SOP.PA": ("Sopra Steria", "Technologie"),
    "SPIE.PA": ("SPIE", "Industrie"), "TE.PA": ("Technip Energies", "Énergie"), "TFI.PA": ("TF1", "Médias"),
    "TRI.PA": ("Trigano", "Consommation"), "UBI.PA": ("Ubisoft", "Technologie"), "FR.PA": ("Valeo", "Automobile"),
    "VK.PA": ("Vallourec", "Énergie"), "VLA.PA": ("Valneva", "Santé"), "VRLA.PA": ("Verallia", "Matériaux"),
    "VCT.PA": ("Vicat", "Matériaux"), "VIRP.PA": ("Virbac", "Santé"), "VIRI.PA": ("Viridien", "Énergie"),
    "VIV.PA": ("Vivendi", "Médias"), "VU.PA": ("VusionGroup", "Technologie"), "MF.PA": ("Wendel", "Finance"),
    "WLN.PA": ("Worldline", "Technologie"),
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
    "sbf120": {"label": "SBF 120 (composition de janvier 2025)", "symbols": list(CAC40) + list(SBF120_EXTRA)},
    "mid60": {"label": "Valeurs moyennes : SBF 120 hors CAC 40", "symbols": list(SBF120_EXTRA)},
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
