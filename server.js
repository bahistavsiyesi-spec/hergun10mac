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
    stage: m.stage || "",
    matchday: m.matchday || null,
    homeTeam: m.homeTeam?.name || "Ev Sahibi",
    awayTeam: m.awayTeam?.name || "Deplasman"
  }));
}

function filterByLeagueMode(matches, leagueMode, customLeagues) {
  if (leagueMode === "custom" && Array.isArray(customLeagues) && customLeagues.length) {
    const set = new Set(customLeagues.map((x) => x.trim().toLowerCase()));
    return matches.filter((m) => set.has((m.league || "").trim().toLowerCase()));
  }

  if (leagueMode === "major") {
    const majorCodes = new Set([
      "PL",   // Premier League
      "PD",   // La Liga
      "BL1",  // Bundesliga
      "SA",   // Serie A
      "FL1",  // Ligue 1
      "CL",   // Champions League
      "EL",   // Europa League
      "PPL",  // Primeira Liga
      "DED"   // Eredivisie
    ]);
    return matches.filter((m) => majorCodes.has(m.leagueCode));
  }

  return matches;
}

function buildPrompt(payload, matches) {
  return `
Sen profesyonel bir futbol analiz asistanısın.

Tarih: ${payload.date}
İstenen maç sayısı: ${payload.match_limit}

KULLANILABİLİR VERİ:
- Günün maç listesi
- Lig bilgisi
- Saat bilgisi
- Organizasyon / maç günü bilgisi

GÖREV:
- Verilen maç listesinden en güçlü ${payload.match_limit} maçı seç.
- Seçim yaparken büyük ligler, organizasyon seviyesi ve genel risk dengesi gözet.
- ÇIKTIYI yalnızca JSON olarak ver.
- Uydurma maç ekleme.
- Verilmeyen H2H veya son 10 maç datasını kesin veri gibi yazma; temkinli analiz dili kullan.
- reasons alanı 2 veya 3 kısa madde olsun.
- confidence sadece: Düşük, Orta, Yüksek, Çok Yüksek
- result_prediction sadece: 1, X, 2

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
      "h2h_summary": "Veri sınırlı",
      "home_form": "—",
      "away_form": "—",
      "home_goals_avg": "—",
      "away_goals_avg": "—",
      "home_conceded_avg": "—",
      "away_conceded_avg": "—",
      "home_performance": "Veri sınırlı",
      "away_performance": "Veri sınırlı",
      "table_context": "Lig bağlamı sınırlı",
      "match_importance": "Normal",
      "risk_note": "Veri sınırlı olduğu için ekstra risk var"
    }
  ]
}

KULLANICI EK NOTU:
${payload.extra_prompt || "Yok"}

MAÇ LİSTESİ:
${JSON.stringify(matches, null, 2)}
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

function buildFallbackTips(matches, limit = 10) {
  return matches.slice(0, limit).map((m, i) => ({
    match: `${m.homeTeam} - ${m.awayTeam}`,
    league: m.league || "Bilinmeyen Lig",
    time: m.time || "—",
    result_prediction: i % 3 === 0 ? "1" : i % 3 === 1 ? "X" : "2",
    prob_over25: 55 + (i % 4) * 5,
    prob_first_half_2plus: 22 + (i % 4) * 4,
    prob_btts: 48 + (i % 5) * 5,
    score_prediction: i % 3 === 0 ? "2-1" : i % 3 === 1 ? "1-1" : "1-2",
    recommended_bet: "2.5 Üst",
    reasons: [
      "Maç programında öne çıkan resmi karşılaşmalardan seçildi.",
      "Lig seviyesi ve genel denge dikkate alınarak önceliklendirildi."
    ],
    confidence: i < 2 ? "Yüksek" : "Orta",
    h2h_summary: "Veri sınırlı",
    home_form: "—",
    away_form: "—",
    home_goals_avg: "—",
    away_goals_avg: "—",
    home_conceded_avg: "—",
    away_conceded_avg: "—",
    home_performance: "Veri sınırlı",
    away_performance: "Veri sınırlı",
    table_context: "Lig bağlamı sınırlı",
    match_importance: "Normal",
    risk_note: "Veri sınırlı olduğu için ek risk var"
  }));
}

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
      return res.json({ tips: [] });
    }

    if (!OPENAI_API_KEY || !client) {
      return res.json({ tips: buildFallbackTips(matches, payload.match_limit) });
    }

    const prompt = buildPrompt(payload, matches);

    let tips = [];

    try {
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

    if (!tips.length) {
      tips = buildFallbackTips(matches, payload.match_limit);
    }

    res.json({ tips });
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
