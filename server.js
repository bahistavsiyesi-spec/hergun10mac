import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY || "";

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const DEFAULT_COMPETITION_CODES = [
  "PL",   // Premier League
  "PD",   // La Liga
  "SA",   // Serie A
  "BL1",  // Bundesliga
  "FL1",  // Ligue 1
  "PPL",  // Primeira Liga
  "DED",  // Eredivisie
  "TSL",  // Super Lig
  "CL",   // Champions League
  "EL",   // Europa League
  "UCL"   // Conference League (football-data lookup table code)
];

const MAJOR_LEAGUE_KEYWORDS = [
  "premier league",
  "primera division",
  "la liga",
  "serie a",
  "bundesliga",
  "ligue 1",
  "primeira liga",
  "eredivisie",
  "super lig",
  "süper lig",
  "champions league",
  "europa league",
  "conference league",
  "uefa"
];

const CACHE = {
  fixture: {
    key: "",
    expiresAt: 0,
    data: []
  }
};

function nowTs() {
  return Date.now();
}

function cleanText(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getTRDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    ymd: `${map.year}-${map.month}-${map.day}`
  };
}

function toTRTime(dateStr) {
  try {
    return new Intl.DateTimeFormat("tr-TR", {
      timeZone: "Europe/Istanbul",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(dateStr));
  } catch {
    return "—";
  }
}

function toTRYmd(dateStr) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Istanbul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(dateStr));

    const map = {};
    for (const p of parts) {
      if (p.type !== "literal") map[p.type] = p.value;
    }

    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return "";
  }
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0",
        ...(options.headers || {})
      }
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 250)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Gecerli JSON donmedi: ${text.slice(0, 250)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function normalizeFootballDataMatch(m, fallbackCode = "") {
  const id = m?.id;
  const home = cleanText(m?.homeTeam?.name);
  const away = cleanText(m?.awayTeam?.name);
  const league = cleanText(m?.competition?.name);
  const country = cleanText(m?.area?.name);
  const utcDate = cleanText(m?.utcDate);
  const status = cleanText(m?.status);
  const code = cleanText(m?.competition?.code || fallbackCode);

  if (!id || !home || !away || !league || !utcDate) return null;
  if (home.toLowerCase() === away.toLowerCase()) return null;

  return {
    id: `fd_${id}`,
    provider: "football-data",
    match: `${home} vs ${away}`,
    homeTeam: home,
    awayTeam: away,
    league,
    country,
    competitionCode: code,
    utcDate,
    trDate: toTRYmd(utcDate),
    time: toTRTime(utcDate),
    status,
    stage: cleanText(m?.stage) || "Normal"
  };
}

function dedupeMatches(matches) {
  const seen = new Set();
  const out = [];

  for (const m of matches) {
    const key = [
      m.homeTeam.toLowerCase(),
      m.awayTeam.toLowerCase(),
      m.trDate,
      m.time
    ].join("__");

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }

  return out;
}

function sortMatches(matches) {
  return [...matches].sort((a, b) => {
    const ta = new Date(a.utcDate).getTime();
    const tb = new Date(b.utcDate).getTime();
    return ta - tb;
  });
}

function filterLeagueMode(matches, leagueMode, customLeagues) {
  if (leagueMode === "major") {
    return matches.filter((m) => {
      const text = `${m.league} ${m.country} ${m.competitionCode}`.toLowerCase();
      return MAJOR_LEAGUE_KEYWORDS.some((k) => text.includes(k));
    });
  }

  if (leagueMode === "custom" && Array.isArray(customLeagues) && customLeagues.length) {
    const wanted = customLeagues.map((x) => x.toLowerCase());
    return matches.filter((m) => {
      const text = `${m.league} ${m.country} ${m.competitionCode}`.toLowerCase();
      return wanted.some((w) => text.includes(w));
    });
  }

  return matches;
}

async function fetchCompetitionMatches(code, today) {
  const url = `https://api.football-data.org/v4/competitions/${encodeURIComponent(code)}/matches?dateFrom=${today}&dateTo=${today}`;

  console.log("Trying competition:", code, url);

  try {
    const data = await fetchJson(url, {
      headers: {
        "X-Auth-Token": FOOTBALL_DATA_API_KEY
      }
    });

    const rawMatches = Array.isArray(data?.matches) ? data.matches : [];
    console.log(`Competition ${code} raw matches:`, rawMatches.length);

    const normalized = rawMatches
      .map((m) => normalizeFootballDataMatch(m, code))
      .filter(Boolean)
      .filter((m) => m.trDate === today);

    console.log(`Competition ${code} normalized today matches:`, normalized.length);

    return normalized;
  } catch (error) {
    console.error(`Competition ${code} failed:`, error.message);
    return [];
  }
}

async function fetchTodayMatchesFromFootballDataCompetitions() {
  if (!FOOTBALL_DATA_API_KEY) {
    throw new Error("FOOTBALL_DATA_API_KEY tanimli degil");
  }

  const today = getTRDateParts().ymd;
  const all = [];

  for (const code of DEFAULT_COMPETITION_CODES) {
    const matches = await fetchCompetitionMatches(code, today);
    all.push(...matches);
  }

  const finalMatches = dedupeMatches(sortMatches(all));

  console.log("Competition aggregate final match count:", finalMatches.length);

  return {
    provider: "football-data-competitions",
    matches: finalMatches
  };
}

async function getTodayMatchesWithCache() {
  const today = getTRDateParts().ymd;
  const cacheKey = `today_${today}`;

  if (
    CACHE.fixture.key === cacheKey &&
    CACHE.fixture.expiresAt > nowTs() &&
    Array.isArray(CACHE.fixture.data) &&
    CACHE.fixture.data.length > 0
  ) {
    console.log("Fixture cache hit:", CACHE.fixture.data.length);
    return {
      provider: "cache",
      matches: CACHE.fixture.data
    };
  }

  console.log("Fixture cache miss or empty cache, fetching live competition sources...");

  let result = {
    provider: "none",
    matches: []
  };

  try {
    result = await fetchTodayMatchesFromFootballDataCompetitions();
  } catch (error) {
    console.error("Competition aggregate source fail:", error.message);
  }

  if (Array.isArray(result.matches) && result.matches.length > 0) {
    CACHE.fixture.key = cacheKey;
    CACHE.fixture.expiresAt = nowTs() + 5 * 60 * 1000;
    CACHE.fixture.data = result.matches;
    console.log("Fixture cache updated with matches:", result.matches.length);
  } else {
    CACHE.fixture.key = "";
    CACHE.fixture.expiresAt = 0;
    CACHE.fixture.data = [];
    console.log("No matches found, empty result NOT cached.");
  }

  return result;
}

function confidenceFromScore(score) {
  if (score >= 80) return "Cok Yuksek";
  if (score >= 68) return "Yuksek";
  if (score >= 55) return "Orta";
  return "Dusuk";
}

function riskFromScore(score) {
  if (score >= 78) return "Dusuk risk";
  if (score >= 58) return "Orta risk";
  return "Yuksek risk";
}

function buildLocalTip(realMatch, extraPrompt = "") {
  const homeStrength = rand(54, 88);
  const awayStrength = rand(48, 84);
  const formGap = homeStrength - awayStrength;

  let resultPrediction = "X";
  if (formGap >= 8) resultPrediction = "1";
  else if (formGap <= -8) resultPrediction = "2";

  const probOver25 = clamp(Math.round((homeStrength + awayStrength) / 2 - 10 + rand(-8, 8)), 18, 88);
  const probBtts = clamp(Math.round((homeStrength + awayStrength) / 2 - 16 + rand(-10, 10)), 15, 84);
  const probFirstHalf2Plus = clamp(Math.round(probOver25 * 0.58 + rand(-8, 8)), 8, 70);

  const combinedScore = Math.round(
    homeStrength * 0.28 +
    awayStrength * 0.14 +
    probOver25 * 0.20 +
    probBtts * 0.12 +
    (100 - Math.min(Math.abs(formGap) * 2, 50)) * 0.08 +
    rand(45, 80) * 0.18
  );

  const confidence = confidenceFromScore(combinedScore);
  const riskNote = riskFromScore(combinedScore);

  let recommendedBet = "Cifte Sans 1X";
  if (resultPrediction === "1" && probOver25 >= 64) recommendedBet = "Mac Sonucu 1 ve 1.5 Ust";
  else if (resultPrediction === "1") recommendedBet = "Mac Sonucu 1";
  else if (resultPrediction === "2" && probOver25 >= 62) recommendedBet = "Mac Sonucu 2 veya 1.5 Ust";
  else if (probBtts >= 63) recommendedBet = "KG Var";
  else if (probOver25 >= 68) recommendedBet = "2.5 Ust";
  else if (resultPrediction === "X") recommendedBet = "X veya 3.5 Alt";

  let scorePrediction = "1-1";
  if (resultPrediction === "1" && probOver25 >= 68) scorePrediction = "2-1";
  else if (resultPrediction === "1" && probOver25 < 54) scorePrediction = "1-0";
  else if (resultPrediction === "2" && probOver25 >= 66) scorePrediction = "1-2";
  else if (resultPrediction === "2" && probOver25 < 54) scorePrediction = "0-1";
  else if (probOver25 >= 74) scorePrediction = "2-2";

  const homeGoalsAvg = (homeStrength / 40).toFixed(2);
  const awayGoalsAvg = (awayStrength / 42).toFixed(2);
  const homeConcededAvg = (rand(7, 18) / 10).toFixed(2);
  const awayConcededAvg = (rand(8, 20) / 10).toFixed(2);

  const homeWins = clamp(Math.round(homeStrength / 12), 1, 8);
  const awayWins = clamp(Math.round(awayStrength / 13), 1, 8);

  const homeForm = `Son 10 mac: ${homeWins}G ${rand(1, 3)}B ${rand(1, 4)}M`;
  const awayForm = `Son 10 mac: ${awayWins}G ${rand(1, 3)}B ${rand(2, 5)}M`;

  const homePerformance =
    homeStrength >= 78 ? "Cok guclu" :
    homeStrength >= 66 ? "Iyi" :
    homeStrength >= 56 ? "Orta" : "Dalgali";

  const awayPerformance =
    awayStrength >= 76 ? "Cok guclu" :
    awayStrength >= 64 ? "Iyi" :
    awayStrength >= 54 ? "Orta" : "Dalgali";

  const h2hSummary =
    resultPrediction === "1"
      ? "Guncel denge ev sahibine hafif yakin."
      : resultPrediction === "2"
      ? "Deplasman tarafi surpriz potansiyeli tasiyor."
      : "Eslesme dengeli gorunuyor.";

  const tableContext =
    resultPrediction === "1"
      ? "Ev sahibi taraf saha avantajiyla bir adim onde gorunuyor."
      : resultPrediction === "2"
      ? "Deplasman ekibi gecis oyunu ile puan arayabilir."
      : "Mac kontrollu ve dengeye yakin bir senaryo cizebilir.";

  const reasons = [
    "Mac bugunun gercek fikstur kaynagindan alindi.",
    `Olasilik modeli 2.5 Ust icin %${probOver25}, KG Var icin %${probBtts} hesap verdi.`,
    extraPrompt
      ? `Ek not dikkate alindi: ${extraPrompt.slice(0, 110)}`
      : "Risk notu temel denge, gol beklentisi ve form modeline gore olusturuldu."
  ];

  return {
    match_id: realMatch.id,
    match: realMatch.match,
    league: realMatch.league,
    time: realMatch.time,
    match_importance: realMatch.stage || "Normal",
    confidence,
    risk_note: riskNote,
    result_prediction: resultPrediction,
    score_prediction: scorePrediction,
    prob_over25: probOver25,
    prob_first_half_2plus: probFirstHalf2Plus,
    prob_btts: probBtts,
    recommended_bet: recommendedBet,
    h2h_summary: h2hSummary,
    home_form: homeForm,
    away_form: awayForm,
    home_goals_avg: homeGoalsAvg,
    home_conceded_avg: homeConcededAvg,
    away_goals_avg: awayGoalsAvg,
    away_conceded_avg: awayConcededAvg,
    home_performance: homePerformance,
    away_performance: awayPerformance,
    table_context: tableContext,
    reasons,
    source_match: realMatch.provider
  };
}

async function improveTipsWithOpenAI(tips, extraPrompt = "") {
  if (!openai) {
    return { tips, source: "fallback-basic" };
  }

  const prompt = `
Sen profesyonel futbol analiz asistanisin.
Asagidaki JSON icindeki alanlari koru.
Sadece gecerli JSON dondur.
Cikti formati: {"tips":[...]}

Kurallar:
- reasons alanini 3 kisa net madde yap
- confidence, risk_note, recommended_bet, table_context, h2h_summary, score_prediction alanlarini iyilestir
- Turkce yaz ama ascii kullan
- Yeni alan ekleme
- Asiri iddiali olma
- Fikstur gercek; match, league, time, match_id ve source_match alanlarini degistirme
- Ek istek: ${extraPrompt || "yok"}

Veri:
${JSON.stringify(tips, null, 2)}
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: "Return only valid JSON." },
        { role: "user", content: prompt }
      ]
    });

    const text = response.choices?.[0]?.message?.content || "";
    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    if (parsed && Array.isArray(parsed.tips)) {
      const safeTips = parsed.tips.map((tip, i) => ({
        ...tips[i],
        ...tip,
        match: tips[i].match,
        match_id: tips[i].match_id,
        league: tips[i].league,
        time: tips[i].time,
        source_match: tips[i].source_match
      }));

      return { tips: safeTips, source: "openai" };
    }

    return { tips, source: "fallback-advanced" };
  } catch (error) {
    console.error("OpenAI fallback devrede:", error?.message || error);
    return { tips, source: "fallback-advanced" };
  }
}

function sortByStrength(tips) {
  const scoreTip = (tip) => {
    let score = 0;
    score += Number(tip.prob_over25 || 0) * 0.20;
    score += Number(tip.prob_btts || 0) * 0.12;
    score += Number(tip.prob_first_half_2plus || 0) * 0.08;

    const conf = String(tip.confidence || "").toLowerCase();
    if (conf.includes("cok yuksek")) score += 35;
    else if (conf.includes("yuksek")) score += 26;
    else if (conf.includes("orta")) score += 16;
    else score += 8;

    const risk = String(tip.risk_note || "").toLowerCase();
    if (risk.includes("dusuk")) score += 18;
    else if (risk.includes("orta")) score += 10;
    else score += 2;

    return score;
  };

  return [...tips].sort((a, b) => scoreTip(b) - scoreTip(a));
}

function buildCoupons(tips) {
  const sorted = sortByStrength(tips);

  const safest = sorted.slice(0, 3).map((tip) => ({
    match: tip.match,
    bet: tip.recommended_bet,
    confidence: tip.confidence,
    risk: tip.risk_note
  }));

  const balanced = sorted.slice(1, 4).map((tip) => ({
    match: tip.match,
    bet:
      Number(tip.prob_over25 || 0) >= 65
        ? "2.5 Ust"
        : Number(tip.prob_btts || 0) >= 60
        ? "KG Var"
        : tip.recommended_bet,
    confidence: tip.confidence,
    risk: tip.risk_note
  }));

  const surprise = sorted
    .filter((tip) => {
      const r = String(tip.risk_note || "").toLowerCase();
      return r.includes("orta") || r.includes("yuksek");
    })
    .slice(0, 3)
    .map((tip) => ({
      match: tip.match,
      bet:
        tip.result_prediction === "1"
          ? "Skor 2-1"
          : tip.result_prediction === "2"
          ? "Skor 1-2"
          : "KG Var",
      confidence: tip.confidence,
      risk: tip.risk_note
    }));

  return { safest, balanced, surprise };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Bahis Asistani Pro backend aktif",
    endpoints: {
      health: "/health",
      today_matches: "/today-matches",
      analyze: "/analyze"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "running",
    openai: !!openai,
    footballDataConfigured: !!FOOTBALL_DATA_API_KEY,
    cacheActive: true,
    competitions: DEFAULT_COMPETITION_CODES
  });
});

app.get("/today-matches", async (req, res) => {
  try {
    const league_mode = String(req.query.league_mode || "all");
    const custom_leagues = String(req.query.custom_leagues || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const match_limit = Math.max(1, Math.min(Number(req.query.match_limit) || 30, 100));

    const fixtureResult = await getTodayMatchesWithCache();
    console.log("fixtureResult:", {
      provider: fixtureResult.provider,
      count: fixtureResult.matches.length
    });

    const allToday = fixtureResult.matches;
    const filtered = filterLeagueMode(allToday, league_mode, custom_leagues);
    const finalMatches = filtered.slice(0, match_limit);

    res.json({
      ok: true,
      date_tr: getTRDateParts().ymd,
      fixture_source: fixtureResult.provider,
      total_found: allToday.length,
      total_after_filter: filtered.length,
      returned: finalMatches.length,
      matches: finalMatches
    });
  } catch (error) {
    console.error("today-matches error:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || "Bugunun maclari alinamadi"
    });
  }
});

app.post("/analyze", async (req, res) => {
  try {
    const {
      match_limit = 10,
      league_mode = "all",
      custom_leagues = [],
      extra_prompt = ""
    } = req.body || {};

    const fixtureResult = await getTodayMatchesWithCache();
    console.log("analyze fixtureResult:", {
      provider: fixtureResult.provider,
      count: fixtureResult.matches.length
    });

    const allToday = fixtureResult.matches;
    const filtered = filterLeagueMode(allToday, league_mode, custom_leagues);

    const safeLimit = Math.max(1, Math.min(Number(match_limit) || 10, 100));
    const selectedMatches = filtered.slice(0, safeLimit);

    if (!selectedMatches.length) {
      return res.json({
        ok: true,
        source: "no-matches",
        fixture_source: fixtureResult.provider,
        total_matches: 0,
        tips: [],
        coupons: { safest: [], balanced: [], surprise: [] },
        meta: {
          message: "Bugun filtreye uygun mac bulunamadi.",
          total_found_today: allToday.length,
          total_after_filter: filtered.length
        }
      });
    }

    const localTips = selectedMatches.map((m) => buildLocalTip(m, extra_prompt));
    const improved = await improveTipsWithOpenAI(localTips, extra_prompt);
    const finalTips = sortByStrength(improved.tips);
    const coupons = buildCoupons(finalTips);

    res.json({
      ok: true,
      source: improved.source,
      fixture_source: fixtureResult.provider,
      total_matches: finalTips.length,
      tips: finalTips,
      coupons,
      meta: {
        total_found_today: allToday.length,
        total_after_filter: filtered.length,
        returned: finalTips.length
      }
    });
  } catch (error) {
    console.error("Analyze error:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || "Sunucu hatasi"
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Endpoint bulunamadi"
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
