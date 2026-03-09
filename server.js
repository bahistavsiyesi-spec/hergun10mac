import express from "express";
import cors from "cors";
import axios from "axios";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY || "";

const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

async function footballDataGet(path, params = {}) {
  const url = `https://api.football-data.org/v4${path}`;
  const res = await axios.get(url, {
    params,
    headers: {
      "X-Auth-Token": FOOTBALL_DATA_API_KEY
    },
    timeout: 25000
  });
  return res.data;
}

function toTRTime(utcDate) {
  try {
    return new Date(utcDate).toLocaleTimeString("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Istanbul"
    });
  } catch {
    return "—";
  }
}

function normalizeMatches(matches = []) {
  return matches.map((m) => ({
    id: m.id,
    utcDate: m.utcDate,
    time: toTRTime(m.utcDate),
    status: m.status,
    league: m.competition?.name || "Bilinmeyen Lig",
    leagueCode: m.competition?.code || "",
    competitionId: m.competition?.id || null,
    stage: m.stage || "",
    matchday: m.matchday || null,
    homeTeam: m.homeTeam?.name || "Ev Sahibi",
    awayTeam: m.awayTeam?.name || "Deplasman",
    homeTeamId: m.homeTeam?.id || null,
    awayTeamId: m.awayTeam?.id || null
  }));
}

function filterByLeagueMode(matches, leagueMode, customLeagues) {
  if (leagueMode === "custom" && Array.isArray(customLeagues) && customLeagues.length) {
    const set = new Set(customLeagues.map((x) => x.trim().toLowerCase()));
    return matches.filter((m) => set.has((m.league || "").trim().toLowerCase()));
  }

  if (leagueMode === "major") {
    const majorCodes = new Set([
      "PL",
      "PD",
      "BL1",
      "SA",
      "FL1",
      "CL",
      "EL",
      "PPL",
      "DED"
    ]);
    return matches.filter((m) => majorCodes.has(m.leagueCode));
  }

  return matches;
}

function avg(nums = []) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function formString(results = []) {
  return results.map((r) => r.result).join("-") || "—";
}

function computeTeamRecentStats(matches = [], teamId) {
  const relevant = matches
    .filter((m) => m.homeTeam?.id === teamId || m.awayTeam?.id === teamId)
    .slice(0, 10);

  let wins = 0;
  let draws = 0;
  let losses = 0;
  const scored = [];
  const conceded = [];
  const homeMatches = [];
  const awayMatches = [];
  const recent = [];

  for (const m of relevant) {
    const isHome = m.homeTeam?.id === teamId;
    const gf = isHome ? (m.score?.fullTime?.home ?? 0) : (m.score?.fullTime?.away ?? 0);
    const ga = isHome ? (m.score?.fullTime?.away ?? 0) : (m.score?.fullTime?.home ?? 0);

    let result = "B";
    if (gf > ga) {
      wins += 1;
      result = "G";
    } else if (gf < ga) {
      losses += 1;
      result = "M";
    } else {
      draws += 1;
    }

    scored.push(gf);
    conceded.push(ga);
    recent.push({ result, gf, ga });

    if (isHome) homeMatches.push({ gf, ga, result });
    else awayMatches.push({ gf, ga, result });
  }

  const homeAvgFor = avg(homeMatches.map((x) => x.gf));
  const awayAvgFor = avg(awayMatches.map((x) => x.gf));
  const homeAvgAgainst = avg(homeMatches.map((x) => x.ga));
  const awayAvgAgainst = avg(awayMatches.map((x) => x.ga));

  return {
    played: relevant.length,
    wins,
    draws,
    losses,
    form: formString(recent),
    goalsForAvg: avg(scored).toFixed(2),
    goalsAgainstAvg: avg(conceded).toFixed(2),
    homeGoalsForAvg: homeAvgFor ? homeAvgFor.toFixed(2) : "0.00",
    awayGoalsForAvg: awayAvgFor ? awayAvgFor.toFixed(2) : "0.00",
    homeGoalsAgainstAvg: homeAvgAgainst ? homeAvgAgainst.toFixed(2) : "0.00",
    awayGoalsAgainstAvg: awayAvgAgainst ? awayAvgAgainst.toFixed(2) : "0.00",
    recent
  };
}

function computeH2H(matches = [], homeTeamId, awayTeamId) {
  const relevant = matches
    .filter((m) => {
      const h = m.homeTeam?.id;
      const a = m.awayTeam?.id;
      return (
        (h === homeTeamId && a === awayTeamId) ||
        (h === awayTeamId && a === homeTeamId)
      );
    })
    .slice(0, 5);

  let homePerspectiveWins = 0;
  let draws = 0;
  let homePerspectiveLosses = 0;
  let totalGoals = 0;

  for (const m of relevant) {
    const hg = m.score?.fullTime?.home ?? 0;
    const ag = m.score?.fullTime?.away ?? 0;
    totalGoals += hg + ag;

    const listedHomeIsActualHome = m.homeTeam?.id === homeTeamId;
    const teamGoals = listedHomeIsActualHome ? hg : ag;
    const oppGoals = listedHomeIsActualHome ? ag : hg;

    if (teamGoals > oppGoals) homePerspectiveWins += 1;
    else if (teamGoals < oppGoals) homePerspectiveLosses += 1;
    else draws += 1;
  }

  const avgGoals = relevant.length ? (totalGoals / relevant.length).toFixed(1) : "0.0";

  return {
    count: relevant.length,
    summary: relevant.length
      ? `Son ${relevant.length} H2H: ${homePerspectiveWins}G ${draws}B ${homePerspectiveLosses}M, maç başı ${avgGoals} gol`
      : "H2H verisi sınırlı",
    avgGoals: Number(avgGoals)
  };
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function computeRiskAndProbabilities(homeStats, awayStats, h2h, standings = null) {
  const homeAttack = safeNum(homeStats.goalsForAvg);
  const awayAttack = safeNum(awayStats.goalsForAvg);
  const homeDefenseLeak = safeNum(homeStats.goalsAgainstAvg);
  const awayDefenseLeak = safeNum(awayStats.goalsAgainstAvg);
  const h2hGoals = safeNum(h2h.avgGoals);

  const over25 = clamp(
    Math.round(35 + homeAttack * 10 + awayAttack * 8 + h2hGoals * 4 + awayDefenseLeak * 5 + homeDefenseLeak * 4),
    25,
    88
  );

  const btts = clamp(
    Math.round(30 + homeAttack * 9 + awayAttack * 9 + homeDefenseLeak * 6 + awayDefenseLeak * 6),
    20,
    85
  );

  const firstHalf2 = clamp(
    Math.round((over25 * 0.42) + (btts * 0.12)),
    12,
    60
  );

  const homeStrength =
    safeNum(homeStats.goalsForAvg) -
    safeNum(homeStats.goalsAgainstAvg) +
    safeNum(homeStats.homeGoalsForAvg) * 0.4;

  const awayStrength =
    safeNum(awayStats.goalsForAvg) -
    safeNum(awayStats.goalsAgainstAvg) +
    safeNum(awayStats.awayGoalsForAvg) * 0.3;

  let resultPrediction = "X";
  if (homeStrength - awayStrength > 0.35) resultPrediction = "1";
  else if (awayStrength - homeStrength > 0.35) resultPrediction = "2";

  let confidence = "Orta";
  const diff = Math.abs(homeStrength - awayStrength);

  if (diff > 1.2) confidence = "Çok Yüksek";
  else if (diff > 0.7) confidence = "Yüksek";
  else if (diff < 0.2) confidence = "Düşük";

  let riskScore = 50;
  riskScore -= diff * 18;
  riskScore += Math.abs(over25 - 60) < 8 ? 8 : 0;
  riskScore += h2h.count < 2 ? 10 : 0;
  riskScore += homeStats.played < 5 || awayStats.played < 5 ? 12 : 0;

  if (standings?.homeRank && standings?.awayRank) {
    const rankGap = Math.abs(standings.homeRank - standings.awayRank);
    riskScore -= Math.min(rankGap, 10);
  }

  riskScore = clamp(Math.round(riskScore), 10, 90);

  const riskLabel =
    riskScore >= 70 ? "Yüksek Risk" :
    riskScore >= 45 ? "Orta Risk" :
    "Düşük Risk";

  return {
    over25,
    btts,
    firstHalf2,
    resultPrediction,
    confidence,
    riskScore,
    riskLabel
  };
}

function deriveScorePrediction(resultPrediction, over25, btts) {
  if (resultPrediction === "1") {
    if (over25 >= 65 && btts >= 55) return "2-1";
    if (over25 >= 65) return "3-1";
    return "1-0";
  }
  if (resultPrediction === "2") {
    if (over25 >= 65 && btts >= 55) return "1-2";
    if (over25 >= 65) return "1-3";
    return "0-1";
  }
  if (over25 >= 65) return "2-2";
  return "1-1";
}

function deriveBet(resultPrediction, over25, btts) {
  if (over25 >= 70) return "2.5 Üst";
  if (btts >= 65) return "KG Var";
  if (resultPrediction === "1") return "MS1";
  if (resultPrediction === "2") return "MS2";
  return "X Çifte Şans";
}

function computeCouponBuckets(tips = []) {
  const sorted = [...tips].sort((a, b) => {
    const aScore = (a.confidenceScore ?? 0) - (a.riskScore ?? 0);
    const bScore = (b.confidenceScore ?? 0) - (b.riskScore ?? 0);
    return bScore - aScore;
  });

  return {
    safest: sorted.slice(0, 3).map((t) => ({
      match: t.match,
      bet: t.recommended_bet,
      confidence: t.confidence,
      risk: t.risk_note
    })),
    balanced: sorted.slice(0, 5).map((t) => ({
      match: t.match,
      bet: t.recommended_bet,
      confidence: t.confidence
    })),
    surprise: [...tips]
      .sort((a, b) => (b.prob_btts + b.prob_over25) - (a.prob_btts + a.prob_over25))
      .slice(0, 3)
      .map((t) => ({
        match: t.match,
        bet: t.prob_btts >= t.prob_over25 ? "KG Var" : "2.5 Üst",
        confidence: t.confidence
      }))
  };
}

function buildFallbackTip(match, homeStats, awayStats, h2h, standings = null) {
  const calc = computeRiskAndProbabilities(homeStats, awayStats, h2h, standings);
  const scorePrediction = deriveScorePrediction(calc.resultPrediction, calc.over25, calc.btts);
  const recommendedBet = deriveBet(calc.resultPrediction, calc.over25, calc.btts);

  const homeRank = standings?.homeRank ? `Ev sıra ${standings.homeRank}` : "Ev sıra bilinmiyor";
  const awayRank = standings?.awayRank ? `Dep sıra ${standings.awayRank}` : "Dep sıra bilinmiyor";

  const confidenceScore =
    calc.confidence === "Çok Yüksek" ? 90 :
    calc.confidence === "Yüksek" ? 75 :
    calc.confidence === "Orta" ? 58 : 42;

  return {
    match: `${match.homeTeam} - ${match.awayTeam}`,
    league: match.league || "Bilinmeyen Lig",
    time: match.time || "—",
    result_prediction: calc.resultPrediction,
    prob_over25: calc.over25,
    prob_first_half_2plus: calc.firstHalf2,
    prob_btts: calc.btts,
    score_prediction: scorePrediction,
    recommended_bet: recommendedBet,
    reasons: [
      `Ev sahibi formu ${homeStats.form}, deplasman formu ${awayStats.form}.`,
      `Gol ortalamaları ${homeStats.goalsForAvg} / ${awayStats.goalsForAvg}; savunma ortalamaları ${homeStats.goalsAgainstAvg} / ${awayStats.goalsAgainstAvg}.`,
      `${h2h.summary}`
    ],
    confidence: calc.confidence,
    h2h_summary: h2h.summary,
    home_form: homeStats.form,
    away_form: awayStats.form,
    home_goals_avg: homeStats.goalsForAvg,
    away_goals_avg: awayStats.goalsForAvg,
    home_conceded_avg: homeStats.goalsAgainstAvg,
    away_conceded_avg: awayStats.goalsAgainstAvg,
    home_performance: `G/B/M: ${homeStats.wins}/${homeStats.draws}/${homeStats.losses} | İç saha gol ort: ${homeStats.homeGoalsForAvg}`,
    away_performance: `G/B/M: ${awayStats.wins}/${awayStats.draws}/${awayStats.losses} | Deplasman gol ort: ${awayStats.awayGoalsForAvg}`,
    table_context: `${homeRank} | ${awayRank}`,
    match_importance:
      standings?.homeRank && standings?.awayRank
        ? (Math.min(standings.homeRank, standings.awayRank) <= 4
            ? "Üst sıra yarışı"
            : Math.max(standings.homeRank, standings.awayRank) >= 16
              ? "Alt sıra baskısı"
              : "Orta sıra mücadelesi")
        : "Lig bağlamı sınırlı",
    risk_note: `${calc.riskLabel} (${calc.riskScore}/100)`,
    risk_score: calc.riskScore,
    confidenceScore
  };
}

async function getTeamMatches(teamId, limit = 10) {
  try {
    const data = await footballDataGet(`/teams/${teamId}/matches`, {
      status: "FINISHED",
      limit
    });
    return data.matches || [];
  } catch {
    return [];
  }
}

async function getHeadToHead(matchId) {
  try {
    const data = await footballDataGet(`/matches/${matchId}/head2head`, { limit: 5 });
    return data.matches || [];
  } catch {
    return [];
  }
}

async function getStandings(competitionId) {
  try {
    const data = await footballDataGet(`/competitions/${competitionId}/standings`);
    const table = data?.standings?.[0]?.table || [];
    return table;
  } catch {
    return [];
  }
}

function findTeamRank(table = [], teamId) {
  const row = table.find((r) => r.team?.id === teamId);
  return row?.position || null;
}

function buildPrompt(payload, enrichedMatches) {
  return `
Sen profesyonel bir futbol veri analisti ve bahis risk değerlendiricisisin.

Tarih: ${payload.date}
İstenen maç sayısı: ${payload.match_limit}

GÖREV:
- Verilen verilerden en güçlü ${payload.match_limit} maçı seç.
- Form, gol ortalaması, savunma kırılganlığı, H2H özeti, lig sırası ve risk notuna göre karar ver.
- reasons alanı 2 veya 3 kısa net madde olsun.
- confidence sadece: Düşük, Orta, Yüksek, Çok Yüksek
- result_prediction sadece: 1, X, 2
- JSON dışında hiçbir şey yazma.
- Verilerle çelişme.

VERİ:
${JSON.stringify(enrichedMatches, null, 2)}

JSON ŞEMASI:
{
  "tips": [
    {
      "match": "Ev Sahibi - Deplasman",
      "league": "Lig Adı",
      "time": "20:00",
      "result_prediction": "1",
      "prob_over25": 65,
      "prob_first_half_2plus": 31,
      "prob_btts": 57,
      "score_prediction": "2-1",
      "recommended_bet": "2.5 Üst",
      "reasons": ["...", "..."],
      "confidence": "Orta",
      "h2h_summary": "Özet",
      "home_form": "G-B-G-M-G",
      "away_form": "M-B-G-M-B",
      "home_goals_avg": "1.80",
      "away_goals_avg": "1.10",
      "home_conceded_avg": "0.90",
      "away_conceded_avg": "1.40",
      "home_performance": "Açıklama",
      "away_performance": "Açıklama",
      "table_context": "Açıklama",
      "match_importance": "Açıklama",
      "risk_note": "Açıklama"
    }
  ]
}
`.trim();
}

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    tips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          match: { type: "string" },
          league: { type: "string" },
          time: { type: "string" },
          result_prediction: { type: "string", enum: ["1", "X", "2"] },
          prob_over25: { type: "integer", minimum: 0, maximum: 100 },
          prob_first_half_2plus: { type: "integer", minimum: 0, maximum: 100 },
          prob_btts: { type: "integer", minimum: 0, maximum: 100 },
          score_prediction: { type: "string" },
          recommended_bet: { type: "string" },
          reasons: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 3
          },
          confidence: { type: "string", enum: ["Düşük", "Orta", "Yüksek", "Çok Yüksek"] },
          h2h_summary: { type: "string" },
          home_form: { type: "string" },
          away_form: { type: "string" },
          home_goals_avg: { type: "string" },
          away_goals_avg: { type: "string" },
          home_conceded_avg: { type: "string" },
          away_conceded_avg: { type: "string" },
          home_performance: { type: "string" },
          away_performance: { type: "string" },
          table_context: { type: "string" },
          match_importance: { type: "string" },
          risk_note: { type: "string" }
        },
        required: [
          "match",
          "league",
          "time",
          "result_prediction",
          "prob_over25",
          "prob_first_half_2plus",
          "prob_btts",
          "score_prediction",
          "recommended_bet",
          "reasons",
          "confidence",
          "h2h_summary",
          "home_form",
          "away_form",
          "home_goals_avg",
          "away_goals_avg",
          "home_conceded_avg",
          "away_conceded_avg",
          "home_performance",
          "away_performance",
          "table_context",
          "match_importance",
          "risk_note"
        ]
      }
    }
  },
  required: ["tips"]
};

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    hasOpenAI: Boolean(OPENAI_API_KEY),
    hasFootballData: Boolean(FOOTBALL_DATA_API_KEY),
    model: OPENAI_MODEL
  });
});

app.get("/matches-today", async (_req, res) => {
  try {
    const data = await footballDataGet("/matches");
    const matches = normalizeMatches(data.matches || []);
    res.json({
      count: matches.length,
      matches
    });
  } catch (error) {
    res.status(500).json({
      error: error?.response?.data || error?.message || "Bilinmeyen hata"
    });
  }
});

app.post("/analyze", async (req, res) => {
  try {
    if (!FOOTBALL_DATA_API_KEY) {
      return res.status(400).json({ error: "FOOTBALL_DATA_API_KEY eksik." });
    }

    const payload = {
      date: req.body?.date || new Date().toISOString().slice(0, 10),
      match_limit: Number(req.body?.match_limit || 10),
      league_mode: req.body?.league_mode || "all",
      custom_leagues: Array.isArray(req.body?.custom_leagues) ? req.body.custom_leagues : [],
      extra_prompt: req.body?.extra_prompt || ""
    };

    const data = await footballDataGet("/matches");
    let matches = normalizeMatches(data.matches || []);

    matches = matches.filter((m) => m.status !== "FINISHED");
    matches = filterByLeagueMode(matches, payload.league_mode, payload.custom_leagues);

    if (!matches.length) {
      return res.json({
        tips: [],
        coupons: { safest: [], balanced: [], surprise: [] }
      });
    }

    const enrichedMatches = [];
    const standingsCache = new Map();

    for (const match of matches.slice(0, 12)) {
      const [homeRecent, awayRecent, h2hMatches] = await Promise.all([
        match.homeTeamId ? getTeamMatches(match.homeTeamId, 10) : Promise.resolve([]),
        match.awayTeamId ? getTeamMatches(match.awayTeamId, 10) : Promise.resolve([]),
        match.id ? getHeadToHead(match.id) : Promise.resolve([])
      ]);

      if (!standingsCache.has(match.competitionId)) {
        const table = match.competitionId ? await getStandings(match.competitionId) : [];
        standingsCache.set(match.competitionId, table);
      }

      const table = standingsCache.get(match.competitionId) || [];
      const standings = {
        homeRank: findTeamRank(table, match.homeTeamId),
        awayRank: findTeamRank(table, match.awayTeamId)
      };

      const homeStats = computeTeamRecentStats(homeRecent, match.homeTeamId);
      const awayStats = computeTeamRecentStats(awayRecent, match.awayTeamId);
      const h2h = computeH2H(h2hMatches, match.homeTeamId, match.awayTeamId);

      const fallback = buildFallbackTip(match, homeStats, awayStats, h2h, standings);

      enrichedMatches.push({
        ...match,
        derived: fallback
      });
    }

    let tips = [];

    if (OPENAI_API_KEY && client) {
      try {
        const prompt = buildPrompt(payload, enrichedMatches);

        const response = await client.responses.create({
          model: OPENAI_MODEL,
          input: prompt,
          text: {
            format: {
              type: "json_schema",
              name: "football_analysis",
              strict: true,
              schema: outputSchema
            }
          }
        });

        const parsed = JSON.parse(response.output_text || '{"tips":[]}');
        tips = Array.isArray(parsed.tips) ? parsed.tips.slice(0, payload.match_limit) : [];
      } catch (aiError) {
        console.error("AI analyze error:", aiError?.message || aiError);
      }
    }

    if (!tips.length) {
      tips = enrichedMatches
        .map((m) => m.derived)
        .slice(0, payload.match_limit);
    }

    tips = tips.map((tip) => {
      const riskMatch = enrichedMatches.find(
        (m) => `${m.homeTeam} - ${m.awayTeam}` === tip.match
      );
      if (!riskMatch) return tip;

      return {
        ...tip,
        risk_score: riskMatch.derived.risk_score,
        confidenceScore: riskMatch.derived.confidenceScore
      };
    });

    const coupons = computeCouponBuckets(tips);

    res.json({ tips, coupons });
  } catch (error) {
    const message =
      error?.response?.data?.message ||
      error?.response?.data?.error ||
      error?.message ||
      "Bilinmeyen hata";

    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
