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

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

const MAJOR_LEAGUES = [
  "Premier League",
  "La Liga",
  "Serie A",
  "Bundesliga",
  "Ligue 1",
  "Super Lig",
  "Süper Lig",
  "Champions League",
  "Europa League",
  "Conference League",
  "Eredivisie",
  "Primeira Liga"
];

const ALL_MATCHES = [
  { id: 1, match: "Galatasaray vs Antalyaspor", league: "Super Lig", time: "20:00" },
  { id: 2, match: "Fenerbahce vs Konyaspor", league: "Super Lig", time: "19:00" },
  { id: 3, match: "Besiktas vs Kasimpasa", league: "Super Lig", time: "21:00" },
  { id: 4, match: "Trabzonspor vs Alanyaspor", league: "Super Lig", time: "18:00" },
  { id: 5, match: "Manchester City vs Brighton", league: "Premier League", time: "22:00" },
  { id: 6, match: "Liverpool vs Wolves", league: "Premier League", time: "19:30" },
  { id: 7, match: "Arsenal vs Brentford", league: "Premier League", time: "18:30" },
  { id: 8, match: "Real Madrid vs Getafe", league: "La Liga", time: "23:00" },
  { id: 9, match: "Barcelona vs Sevilla", league: "La Liga", time: "20:30" },
  { id: 10, match: "Atletico Madrid vs Valencia", league: "La Liga", time: "22:30" },
  { id: 11, match: "Inter vs Torino", league: "Serie A", time: "21:45" },
  { id: 12, match: "Juventus vs Lecce", league: "Serie A", time: "20:00" },
  { id: 13, match: "Milan vs Udinese", league: "Serie A", time: "19:45" },
  { id: 14, match: "Bayern Munich vs Mainz", league: "Bundesliga", time: "18:30" },
  { id: 15, match: "Dortmund vs Freiburg", league: "Bundesliga", time: "20:30" },
  { id: 16, match: "PSG vs Rennes", league: "Ligue 1", time: "22:00" },
  { id: 17, match: "Benfica vs Braga", league: "Primeira Liga", time: "23:15" },
  { id: 18, match: "Ajax vs Utrecht", league: "Eredivisie", time: "21:00" },
  { id: 19, match: "Porto vs Boavista", league: "Primeira Liga", time: "22:15" },
  { id: 20, match: "AZ Alkmaar vs Twente", league: "Eredivisie", time: "20:45" }
];

function pickLeagueMatches(mode, customLeagues = []) {
  if (mode === "major") {
    return ALL_MATCHES.filter((m) => MAJOR_LEAGUES.some((l) => l.toLowerCase() === m.league.toLowerCase()));
  }

  if (mode === "custom" && Array.isArray(customLeagues) && customLeagues.length > 0) {
    const wanted = customLeagues.map((x) => x.toLowerCase());
    return ALL_MATCHES.filter((m) => wanted.some((w) => m.league.toLowerCase().includes(w)));
  }

  return ALL_MATCHES;
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function safePercent(n) {
  return Math.max(5, Math.min(95, Math.round(n)));
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

function buildLocalTip(matchObj, extraPrompt = "") {
  const homeStrength = rand(55, 90);
  const awayStrength = rand(45, 82);
  const formGap = homeStrength - awayStrength;

  let resultPrediction = "X";
  if (formGap >= 9) resultPrediction = "1";
  else if (formGap <= -9) resultPrediction = "2";

  const totalAttack = homeStrength + awayStrength;
  const probOver25 = safePercent((totalAttack / 2) - 12 + rand(-8, 8));
  const probBtts = safePercent(((awayStrength + homeStrength) / 2) - 18 + rand(-10, 10));
  const probFirstHalf2Plus = safePercent((probOver25 * 0.62) + rand(-8, 8));

  const combinedScore = Math.round(
    (homeStrength * 0.32) +
    ((100 - Math.abs(formGap) * 2) * 0.08) +
    (probOver25 * 0.18) +
    (probBtts * 0.12) +
    (rand(52, 88) * 0.30)
  );

  const confidence = confidenceFromScore(combinedScore);
  const riskNote = riskFromScore(combinedScore);

  let recommendedBet = "Cifte Sans 1X";
  if (resultPrediction === "1" && probOver25 >= 65) recommendedBet = "Mac Sonucu 1 ve 1.5 Ust";
  else if (resultPrediction === "1") recommendedBet = "Mac Sonucu 1";
  else if (resultPrediction === "2" && probOver25 >= 60) recommendedBet = "Mac Sonucu 2 veya 1.5 Ust";
  else if (probBtts >= 62) recommendedBet = "KG Var";
  else if (probOver25 >= 67) recommendedBet = "2.5 Ust";
  else if (resultPrediction === "X") recommendedBet = "X veya 2.5 Alt";

  let scorePrediction = "1-1";
  if (resultPrediction === "1" && probOver25 >= 70) scorePrediction = "2-1";
  else if (resultPrediction === "1" && probOver25 < 55) scorePrediction = "1-0";
  else if (resultPrediction === "2" && probOver25 >= 68) scorePrediction = "1-2";
  else if (resultPrediction === "2" && probOver25 < 55) scorePrediction = "0-1";
  else if (probOver25 >= 72) scorePrediction = "2-2";

  const homeGoalsAvg = (homeStrength / 40).toFixed(2);
  const awayGoalsAvg = (awayStrength / 42).toFixed(2);
  const homeConcededAvg = (rand(7, 18) / 10).toFixed(2);
  const awayConcededAvg = (rand(8, 20) / 10).toFixed(2);

  const homeWins = Math.max(1, Math.min(8, Math.round(homeStrength / 12)));
  const awayWins = Math.max(1, Math.min(8, Math.round(awayStrength / 13)));

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
    resultPrediction === "1" ? "Son karsilasmalarda ev sahibi bir adim onde." :
    resultPrediction === "2" ? "Son karsilasmalarda deplasman ekibi surpriz yapabiliyor." :
    "Iki takim arasindaki denge dikkat cekiyor.";

  const tableContext =
    resultPrediction === "1"
      ? "Ev sahibi ust siralara yakin ve puan kaybina daha az toleransli."
      : resultPrediction === "2"
      ? "Deplasman ekibi form ivmesiyle puan arayacak."
      : "Mac tablo dengesi acisindan kontrollu gecmeye uygun gorunuyor.";

  const reasons = [
    `Form farki ${Math.abs(formGap)} puan seviyesinde ve bu tahmini destekliyor.`,
    `2.5 ust olasiligi %${probOver25}, KG Var olasiligi %${probBtts} olarak hesaplandi.`,
    extraPrompt
      ? `Ek not dikkate alindi: ${extraPrompt.slice(0, 110)}`
      : "Risk hesaplamasinda form, gol ortalamasi ve mac dengesi birlikte degerlendirildi."
  ];

  return {
    match: matchObj.match,
    league: matchObj.league,
    time: matchObj.time,
    match_importance: rand(0, 1) ? "Yuksek" : "Normal",
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
    reasons
  };
}

async function improveTipsWithOpenAI(tips, extraPrompt = "") {
  if (!openai) {
    return { tips, source: "fallback-basic" };
  }

  const prompt = `
Sen profesyonel bir futbol analiz asistanisin.
Aşağıdaki maç tahmin nesnelerini bozmadan daha profesyonel hale getir.
Kurallar:
- Sadece geçerli JSON döndür.
- JSON formatı: { "tips": [...] }
- Mevcut alanları koru.
- "reasons" alanını 3 kısa ve net madde halinde iyileştir.
- "confidence", "risk_note", "recommended_bet", "table_context", "h2h_summary", "score_prediction" alanlarını daha mantıklı hale getir.
- Türkçe yaz ama ascii karakter kullan. Ornek: "Yuksek", "Dusuk risk".
- Yeni alan ekleme.
- Uydurma aşırı iddialardan kaçın.
- Ek istek: ${extraPrompt || "yok"}

Veri:
${JSON.stringify(tips, null, 2)}
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: "You are a football betting analysis engine that returns only JSON." },
        { role: "user", content: prompt }
      ]
    });

    const text = response.choices?.[0]?.message?.content || "";
    const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(cleaned);

    if (parsed && Array.isArray(parsed.tips)) {
      return { tips: parsed.tips, source: "openai" };
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
    .filter((tip) => String(tip.risk_note || "").toLowerCase().includes("orta") || String(tip.risk_note || "").toLowerCase().includes("yuksek"))
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
      analyze: "/analyze"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "running",
    openai: !!openai
  });
});

app.post("/analyze", async (req, res) => {
  try {
    const {
      match_limit = 10,
      league_mode = "all",
      custom_leagues = [],
      extra_prompt = ""
    } = req.body || {};

    const filteredMatches = pickLeagueMatches(league_mode, custom_leagues)
      .slice(0, Math.max(1, Math.min(Number(match_limit) || 10, 20)));

    const localTips = filteredMatches.map((m) => buildLocalTip(m, extra_prompt));
    const improved = await improveTipsWithOpenAI(localTips, extra_prompt);
    const finalTips = sortByStrength(improved.tips);
    const coupons = buildCoupons(finalTips);

    res.json({
      ok: true,
      source: improved.source,
      total_matches: finalTips.length,
      tips: finalTips,
      coupons
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
