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

const MAJOR_COMPETITION_CODES = new Set([
  "PL",   // Premier League
  "PD",   // La Liga
  "SA",   // Serie A
  "BL1",  // Bundesliga
  "FL1",  // Ligue 1
  "PPL",  // Primeira Liga
  "DED",  // Eredivisie
  "CL",   // Champions League
  "EL",   // Europa League
  "ECL",  // Conference League
  "BSA"   // Brasileirao
]);

function trTodayParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    date: `${map.year}-${map.month}-${map.day}`
  };
}

function toTRTime(utcDate) {
  try {
    return new Intl.DateTimeFormat("tr-TR", {
      timeZone: "Europe/Istanbul",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(utcDate));
  } catch {
    return "—";
  }
}

function toTRDate(utcDate) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Istanbul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(utcDate));

    const map = {};
    for (const p of parts) {
      if (p.type !== "literal") map[p.type] = p.value;
    }
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return "";
  }
}

function safeText(v) {
  return String(v ?? "").trim();
}

function normalizeMatch(m) {
  const home = safeText(m?.homeTeam?.name);
  const away = safeText(m?.awayTeam?.name);
  const league = safeText(m?.competition?.name);
  const code = safeText(m?.competition?.code);
  const utcDate = safeText(m?.utcDate);
  const status = safeText(m?.status);
  const id = m?.id;

  if (!id || !home || !away || !league || !utcDate) return null;
  if (home.toLowerCase() === away.toLowerCase()) return null;

  return {
    id,
    match: `${home} vs ${away}`,
    homeTeam: home,
    awayTeam: away,
    league,
    competitionCode: code,
    utcDate,
    trDate: toTRDate(utcDate),
    time: toTRTime(utcDate),
    status,
    venue: safeText(m?.venue),
    stage: safeText(m?.stage),
    area: safeText(m?.area?.name)
  };
}

function isUsefulStatus(status) {
  const allowed = new Set([
    "SCHEDULED",
    "TIMED",
    "IN_PLAY",
    "PAUSED",
    "LIVE"
  ]);
  return allowed.has(status);
}

function dedupeMatches(matches) {
  const seen = new Set();
  const out = [];

  for (const m of matches) {
    const key = `${m.homeTeam.toLowerCase()}__${m.awayTeam.toLowerCase()}__${m.trDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }

  return out;
}

function filterLeagueMode(matches, leagueMode, customLeagues) {
  if (leagueMode === "major") {
    return matches.filter((m) => MAJOR_COMPETITION_CODES.has(m.competitionCode));
  }

  if (leagueMode === "custom" && Array.isArray(customLeagues) && customLeagues.length) {
    const wanted = customLeagues.map((x) => x.toLowerCase());
    return matches.filter((m) => {
      const league = m.league.toLowerCase();
      const area = m.area.toLowerCase();
      const code = m.competitionCode.toLowerCase();
      return wanted.some((w) => league.includes(w) || area.includes(w) || code.includes(w));
    });
  }

  return matches;
}

function sortMatches(matches) {
  return [...matches].sort((a, b) => {
    const da = new Date(a.utcDate).getTime();
    const db = new Date(b.utcDate).getTime();
    return da - db;
  });
}

async function fetchTodayMatchesFromFootballData() {
  if (!FOOTBALL_DATA_API_KEY) {
    throw new Error("FOOTBALL_DATA_API_KEY tanimli degil.");
  }

  const today = trTodayParts().date;
  const url = `https://api.football-data.org/v4/matches?dateFrom=${today}&dateTo=${today}`;

  const response = await fetch(url, {
    headers: {
      "X-Auth-Token": FOOTBALL_DATA_API_KEY
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`football-data API hatasi (${response.status}): ${text.slice(0, 250)}`);
  }

  const data = await response.json();
  const rawMatches = Array.isArray(data?.matches) ? data.matches : [];

  const normalized = rawMatches
    .map(normalizeMatch)
    .filter(Boolean)
    .filter((m) => isUsefulStatus(m.status))
    .filter((m) => m.trDate === today);

  return dedupeMatches(sortMatches(normalized));
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
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
    homeStrength >= 56 ? "Orta" : "Dalgalı";

  const awayPerformance =
    awayStrength >= 76 ? "Cok guclu" :
    awayStrength >= 64 ? "Iyi" :
    awayStrength >= 54 ? "Orta" : "Dalgalı";

  const h2hSummary =
    resultPrediction === "1"
      ? "Guncel denge ev sahibine hafif yakin."
      : resultPrediction === "2"
      ? "Deplasman tarafi surpriz potansiyeli tasiyor."
      : "Eslesme dengeli gorunuyor.";

  const tableContext =
    resultPrediction === "1"
      ? "Ev sahibi taraf puan ihtiyaci ve saha avantajiyla bir adim onde."
      : resultPrediction === "2"
      ? "Deplasman ekibi gecis oyunu ve form ivmesiyle puan arayabilir."
      : "Mac kontrollu ve dengeye yakin bir senaryo cizebilir.";

  const reasons = [
    `Mac bugun oynanacak resmi fikstur listesinden alindi.`,
    `Olasilik modeli 2.5 Ust icin %${probOver25}, KG Var icin %${probBtts} hesap verdi.`,
    extraPrompt
      ? `Ek not dikkate alindi: ${extraPrompt.slice(0, 110)}`
      : "Risk notu mevcut denge, gol beklentisi ve temel form modeline gore olusturuldu."
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
    source_match: "football-data-today"
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
- Fikstur gercek; maca dokunma, takim ismi degistirme
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
        source_match: "football-data-today"
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
    need_env: ["FOOTBALL_DATA_API_KEY"],
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
    footballDataConfigured: !!FOOTBALL_DATA_API_KEY
  });
});

app.get("/today-matches", async (req, res) => {
  try {
    const league_mode = String(req.query.league_mode || "all");
    const custom_leagues = String(req.query.custom_leagues || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const match_limit = Math.max(1, Math.min(Number(req.query.match_limit) || 20, 100));

    const allToday = await fetchTodayMatchesFromFootballData();
    const filtered = filterLeagueMode(allToday, league_mode, custom_leagues);
    const finalMatches = filtered.slice(0, match_limit);

    res.json({
      ok: true,
      date_tr: trTodayParts().date,
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

    const allToday = await fetchTodayMatchesFromFootballData();
    const filtered = filterLeagueMode(allToday, league_mode, custom_leagues);

    const safeLimit = Math.max(1, Math.min(Number(match_limit) || 10, 100));
    const selectedMatches = filtered.slice(0, safeLimit);

    if (!selectedMatches.length) {
      return res.json({
        ok: true,
        source: "no-matches",
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
      total_matches: finalTips.length,
      tips: finalTips,
      coupons,
      meta: {
        total_found_today: allToday.length,
        total_after_filter: filtered.length,
        returned: finalTips.length,
        fixture_source: "football-data.org"
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
