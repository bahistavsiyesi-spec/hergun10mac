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
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "";
const API_FOOTBALL_BASE_URL =
  process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io";

const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const LEAGUES = {
  "Premier League": { id: 39, country: "England" },
  "La Liga": { id: 140, country: "Spain" },
  "Bundesliga": { id: 78, country: "Germany" },
  "Serie A": { id: 135, country: "Italy" },
  "Ligue 1": { id: 61, country: "France" },
  "Türkiye Süper Lig": { id: 203, country: "Turkey" }
};

function seasonFromDate(dateStr) {
  const d = new Date(dateStr);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return m >= 7 ? y : y - 1;
}

function compactScore(fixture) {
  const home = fixture?.teams?.home?.name || "?";
  const away = fixture?.teams?.away?.name || "?";
  const gh = fixture?.goals?.home ?? "-";
  const ga = fixture?.goals?.away ?? "-";
  return `${home} ${gh}-${ga} ${away}`;
}

function calcRecentSummary(fixtures, teamId, venue = "all") {
  const normalized = (fixtures || []).filter((f) => {
    if (!f?.teams?.home?.id || !f?.teams?.away?.id) return false;
    if (venue === "home") return f.teams.home.id === teamId;
    if (venue === "away") return f.teams.away.id === teamId;
    return f.teams.home.id === teamId || f.teams.away.id === teamId;
  });

  let wins = 0, draws = 0, losses = 0, scored = 0, conceded = 0;
  const form = [];

  for (const f of normalized.slice(0, 10)) {
    const isHome = f.teams.home.id === teamId;
    const gf = isHome ? (f.goals.home ?? 0) : (f.goals.away ?? 0);
    const ga = isHome ? (f.goals.away ?? 0) : (f.goals.home ?? 0);
    scored += gf;
    conceded += ga;

    if (gf > ga) { wins += 1; form.push("G"); }
    else if (gf === ga) { draws += 1; form.push("B"); }
    else { losses += 1; form.push("M"); }
  }

  const count = normalized.slice(0, 10).length || 1;
  return {
    form: form.join("-") || "—",
    record: `${wins}/${draws}/${losses}`,
    goals_for_avg: (scored / count).toFixed(2),
    goals_against_avg: (conceded / count).toFixed(2),
  };
}

function buildH2HSummary(h2hFixtures, homeTeamId) {
  const lastFive = (h2hFixtures || []).slice(0, 5);
  let homeWins = 0, draws = 0, awayWins = 0, totalGoals = 0;

  for (const f of lastFive) {
    const hg = f?.goals?.home ?? 0;
    const ag = f?.goals?.away ?? 0;
    totalGoals += hg + ag;

    const homeIsListedHome = f?.teams?.home?.id === homeTeamId;
    const teamGoals = homeIsListedHome ? hg : ag;
    const oppGoals = homeIsListedHome ? ag : hg;

    if (teamGoals > oppGoals) homeWins += 1;
    else if (teamGoals === oppGoals) draws += 1;
    else awayWins += 1;
  }

  const avgGoals = lastFive.length ? (totalGoals / lastFive.length).toFixed(1) : "0.0";
  return `Son ${lastFive.length} H2H: ${homeWins}G ${draws}B ${awayWins}M, maç başı ${avgGoals} gol`;
}

async function apiFootballGet(path, params = {}) {
  const url = `${API_FOOTBALL_BASE_URL}${path}`;
  const res = await axios.get(url, {
    params,
    headers: {
      "x-apisports-key": API_FOOTBALL_KEY
    },
    timeout: 25000
  });
  return res.data?.response || [];
}

async function getDailyFixtures(dateStr, leagueMode, customLeagues) {
  const season = seasonFromDate(dateStr);
  const selected = leagueMode === "custom"
    ? Object.entries(LEAGUES).filter(([name]) => customLeagues.includes(name))
    : Object.entries(LEAGUES);

  const all = [];
  for (const [leagueName, info] of selected) {
    const items = await apiFootballGet("/fixtures", {
      league: info.id,
      season,
      date: dateStr,
      timezone: "Europe/Istanbul"
    });

    for (const f of items) {
      if (f?.fixture?.status?.short && ["PST", "CANC", "ABD"].includes(f.fixture.status.short)) continue;
      all.push({
        fixtureId: f.fixture.id,
        leagueName,
        leagueId: info.id,
        season,
        date: dateStr,
        time: new Date(f.fixture.date).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" }),
        homeTeam: {
          id: f.teams.home.id,
          name: f.teams.home.name
        },
        awayTeam: {
          id: f.teams.away.id,
          name: f.teams.away.name
        }
      });
    }
  }
  return all;
}

async function getStandingsMap(leagueId, season) {
  const rows = await apiFootballGet("/standings", { league: leagueId, season });
  const leagueRows = rows?.[0]?.league?.standings?.[0] || [];
  const map = new Map();
  for (const row of leagueRows) {
    map.set(row.team.id, {
      rank: row.rank,
      points: row.points,
      played: row.all?.played,
      goalsDiff: row.goalsDiff,
      description: row.description || ""
    });
  }
  return map;
}

async function enrichFixture(fixture, standingsMap) {
  const [homeRecent, awayRecent, h2h] = await Promise.all([
    apiFootballGet("/fixtures", { team: fixture.homeTeam.id, last: 10, status: "FT" }),
    apiFootballGet("/fixtures", { team: fixture.awayTeam.id, last: 10, status: "FT" }),
    apiFootballGet("/fixtures/headtohead", { h2h: `${fixture.homeTeam.id}-${fixture.awayTeam.id}`, last: 5 })
  ]);

  const homeSummary = calcRecentSummary(homeRecent, fixture.homeTeam.id, "all");
  const awaySummary = calcRecentSummary(awayRecent, fixture.awayTeam.id, "all");
  const homeVenue = calcRecentSummary(homeRecent, fixture.homeTeam.id, "home");
  const awayVenue = calcRecentSummary(awayRecent, fixture.awayTeam.id, "away");

  return {
    ...fixture,
    h2hSummary: buildH2HSummary(h2h, fixture.homeTeam.id),
    h2hResults: h2h.slice(0, 5).map(compactScore),
    homeRecentResults: homeRecent.slice(0, 10).map(compactScore),
    awayRecentResults: awayRecent.slice(0, 10).map(compactScore),
    homeSummary,
    awaySummary,
    homeVenue,
    awayVenue,
    standings: {
      home: standingsMap.get(fixture.homeTeam.id) || null,
      away: standingsMap.get(fixture.awayTeam.id) || null
    }
  };
}

function buildImportanceText(homeStanding, awayStanding) {
  const ranks = [homeStanding?.rank, awayStanding?.rank].filter(Boolean);
  if (!ranks.length) return "Lig bağlamı bilinmiyor";
  if (ranks.some((r) => r <= 3)) return "Şampiyonluk / üst sıra yarışı";
  if (ranks.some((r) => r <= 6)) return "Avrupa potası yarışı";
  if (ranks.some((r) => r >= 16)) return "Küme düşme hattı baskısı";
  return "Orta sıra puan mücadelesi";
}

function buildPrompt(payload, enrichedFixtures) {
  return `
Sen uzman bir futbol veri analistisin.

Tarih: ${payload.date}
İstenen maç sayısı: ${payload.match_limit}

ANALİZ KURALLARI
- Takımların son 5 H2H maçını incele.
- Son 10 resmi maç performansını analiz et.
- G/B/M, attığı gol ortalaması, yediği gol ortalaması, iç saha/deplasman etkisi ve formu değerlendir.
- Lig sıralaması ve maç önemini yorumla.
- İstatistik uyumu, form gücü ve risk seviyesine göre en güçlü ${payload.match_limit} maçı seç.
- Her maç için şu alanları üret:
  match, league, time, result_prediction, prob_over25, prob_first_half_2plus, prob_btts, score_prediction,
  recommended_bet, reasons, confidence, h2h_summary, home_form, away_form, home_goals_avg, away_goals_avg,
  home_conceded_avg, away_conceded_avg, home_performance, away_performance, table_context, match_importance, risk_note

ÖNEMLİ:
- Yalnızca verilen verilere dayan.
- Uydurma takım, lig veya maç ekleme.
- reasons alanı 2 veya 3 kısa madde olsun.
- confidence yalnızca: Düşük, Orta, Yüksek, Çok Yüksek
- result_prediction yalnızca: 1, X, 2
- JSON dışında hiçbir şey yazma.

KULLANILACAK VERİ
${JSON.stringify(enrichedFixtures, null, 2)}

KULLANICI EK NOTU
${payload.extra_prompt || "Yok"}
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
          "match", "league", "time", "result_prediction", "prob_over25", "prob_first_half_2plus",
          "prob_btts", "score_prediction", "recommended_bet", "reasons", "confidence",
          "h2h_summary", "home_form", "away_form", "home_goals_avg", "away_goals_avg",
          "home_conceded_avg", "away_conceded_avg", "home_performance", "away_performance",
          "table_context", "match_importance", "risk_note"
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
    hasApiFootball: Boolean(API_FOOTBALL_KEY),
    model: OPENAI_MODEL
  });
});

app.post("/analyze", async (req, res) => {
  try {
    const payload = {
      date: req.body?.date || new Date().toISOString().slice(0, 10),
      match_limit: Number(req.body?.match_limit || 10),
      league_mode: req.body?.league_mode || "major",
      custom_leagues: Array.isArray(req.body?.custom_leagues) ? req.body.custom_leagues : [],
      extra_prompt: req.body?.extra_prompt || ""
    };

    if (!OPENAI_API_KEY) {
      return res.status(400).json({ error: "OPENAI_API_KEY eksik." });
    }

    if (!API_FOOTBALL_KEY) {
      return res.status(400).json({ error: "API_FOOTBALL_KEY eksik." });
    }

    const fixtures = await getDailyFixtures(payload.date, payload.league_mode, payload.custom_leagues);
    if (!fixtures.length) {
      return res.json({ tips: [] });
    }

    const standingsByLeague = new Map();
    for (const fx of fixtures) {
      if (!standingsByLeague.has(fx.leagueId)) {
        const map = await getStandingsMap(fx.leagueId, fx.season);
        standingsByLeague.set(fx.leagueId, map);
      }
    }

    const enriched = [];
    for (const fx of fixtures) {
      const standingsMap = standingsByLeague.get(fx.leagueId) || new Map();
      const detail = await enrichFixture(fx, standingsMap);
      detail.tableContext = [
        `${fx.homeTeam.name}: sıra ${detail.standings.home?.rank ?? "?"}`,
        `${fx.awayTeam.name}: sıra ${detail.standings.away?.rank ?? "?"}`
      ].join(" | ");
      detail.matchImportance = buildImportanceText(detail.standings.home, detail.standings.away);
      enriched.push(detail);
    }

    const prompt = buildPrompt(payload, enriched);

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

    const raw = response.output_text;
    const parsed = JSON.parse(raw);

    parsed.tips = (parsed.tips || [])
      .slice(0, payload.match_limit)
      .map((tip) => {
        const fx = enriched.find((x) => `${x.homeTeam.name} - ${x.awayTeam.name}` === tip.match);
        if (!fx) return tip;
        return {
          ...tip,
          h2h_summary: fx.h2hSummary || tip.h2h_summary,
          home_form: fx.homeSummary.form || tip.home_form,
          away_form: fx.awaySummary.form || tip.away_form,
          home_goals_avg: fx.homeSummary.goals_for_avg || tip.home_goals_avg,
          away_goals_avg: fx.awaySummary.goals_for_avg || tip.away_goals_avg,
          home_conceded_avg: fx.homeSummary.goals_against_avg || tip.home_conceded_avg,
          away_conceded_avg: fx.awaySummary.goals_against_avg || tip.away_conceded_avg,
          home_performance: `Genel ${fx.homeSummary.record} | İç saha ${fx.homeVenue.record}`,
          away_performance: `Genel ${fx.awaySummary.record} | Deplasman ${fx.awayVenue.record}`,
          table_context: fx.tableContext || tip.table_context,
          match_importance: fx.matchImportance || tip.match_importance
        };
      });

    res.json(parsed);
  } catch (error) {
    const message =
      error?.response?.data?.errors?.[0]?.message ||
      error?.response?.data?.message ||
      error?.message ||
      "Bilinmeyen hata";
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
