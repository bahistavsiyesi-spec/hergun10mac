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

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  "free-api-live-football-data.p.rapidapi.com";

const RAPIDAPI_MATCHES_BY_DATE_PATH =
  process.env.RAPIDAPI_MATCHES_BY_DATE_PATH ||
  "/football-get-matches-by-date?date={date}";

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

/* -------------------------------------------------- */
/* UTILS */
/* -------------------------------------------------- */

function cleanText(v) {
  return String(v || "").trim();
}

function nowTs() {
  return Date.now();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function getTRDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function getDateShiftedYmd(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
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
    return "";
  }
}

function toTRYmd(dateStr) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Istanbul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(dateStr));
  } catch {
    return "";
  }
}

/* -------------------------------------------------- */
/* RAPIDAPI DATE FIX */
/* -------------------------------------------------- */

function ymdDashedToCompact(ymd) {
  return String(ymd).replace(/-/g, "");
}

/* -------------------------------------------------- */
/* FETCH */
/* -------------------------------------------------- */

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt}`);
  }

  return res.json();
}

/* -------------------------------------------------- */
/* RAPIDAPI MATCHES */
/* -------------------------------------------------- */

async function fetchMatchesRapid(dateYmd) {
  if (!RAPIDAPI_KEY) return [];

  const dateCompact = ymdDashedToCompact(dateYmd);

  const path = RAPIDAPI_MATCHES_BY_DATE_PATH.replace(
    "{date}",
    dateCompact
  );

  const url = `https://${RAPIDAPI_HOST}${path}`;

  try {
    const data = await fetchJson(url, {
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST
      }
    });

    const arr =
      data?.matches ||
      data?.data ||
      data?.response ||
      data?.events ||
      [];

    return arr.map((m) => {
      const home =
        m.homeTeam?.name ||
        m.home_name ||
        m.home ||
        m.homeTeamName;

      const away =
        m.awayTeam?.name ||
        m.away_name ||
        m.away ||
        m.awayTeamName;

      const date =
        m.utcDate ||
        m.date ||
        m.match_date ||
        m.startTime;

      if (!home || !away || !date) return null;

      return {
        id: `ra_${home}_${away}_${date}`,
        provider: "rapidapi",
        match: `${home} vs ${away}`,
        homeTeam: home,
        awayTeam: away,
        league:
          m.league?.name ||
          m.competition?.name ||
          m.league_name ||
          "",
        country:
          m.country?.name ||
          m.country_name ||
          "",
        utcDate: date,
        trDate: toTRYmd(date),
        time: toTRTime(date),
        status: "TIMED",
        stage: "Normal"
      };
    }).filter(Boolean);
  } catch (err) {
    console.log("RapidAPI error:", err.message);
    return [];
  }
}

/* -------------------------------------------------- */
/* FOOTBALL DATA */
/* -------------------------------------------------- */

async function fetchMatchesFootballData(dateFrom, dateTo) {
  if (!FOOTBALL_DATA_API_KEY) return [];

  const codes = [
    "PL",
    "PD",
    "SA",
    "BL1",
    "FL1",
    "PPL",
    "DED",
    "ELC",
    "BSA",
    "TSL"
  ];

  const all = [];

  for (const c of codes) {
    try {
      const url = `https://api.football-data.org/v4/competitions/${c}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;

      const data = await fetchJson(url, {
        headers: {
          "X-Auth-Token": FOOTBALL_DATA_API_KEY
        }
      });

      const matches = data.matches || [];

      matches.forEach((m) => {
        const home = m.homeTeam?.name;
        const away = m.awayTeam?.name;

        if (!home || !away) return;

        all.push({
          id: `fd_${m.id}`,
          provider: "football-data",
          match: `${home} vs ${away}`,
          homeTeam: home,
          awayTeam: away,
          league: m.competition?.name,
          country: m.area?.name,
          utcDate: m.utcDate,
          trDate: toTRYmd(m.utcDate),
          time: toTRTime(m.utcDate),
          status: m.status,
          stage: m.stage
        });
      });
    } catch (e) {}
  }

  return all;
}

/* -------------------------------------------------- */
/* MERGE */
/* -------------------------------------------------- */

function dedupe(matches) {
  const map = new Map();

  matches.forEach((m) => {
    const key =
      m.homeTeam +
      "_" +
      m.awayTeam +
      "_" +
      m.trDate +
      "_" +
      m.time;

    if (!map.has(key)) map.set(key, m);
  });

  return [...map.values()].sort(
    (a, b) => new Date(a.utcDate) - new Date(b.utcDate)
  );
}

/* -------------------------------------------------- */
/* CACHE */
/* -------------------------------------------------- */

const CACHE = {
  key: "",
  expires: 0,
  data: []
};

async function getMatches(date) {
  if (
    CACHE.key === date &&
    CACHE.expires > nowTs() &&
    CACHE.data.length
  ) {
    return {
      provider: "cache",
      matches: CACHE.data
    };
  }

  const rapid = await fetchMatchesRapid(date);
  const football = await fetchMatchesFootballData(date, date);

  const merged = dedupe([...rapid, ...football]);

  let provider = "none";

  if (rapid.length && football.length)
    provider = "rapidapi+football-data";
  else if (rapid.length)
    provider = "rapidapi";
  else if (football.length)
    provider = "football-data";

  CACHE.key = date;
  CACHE.expires = nowTs() + 5 * 60 * 1000;
  CACHE.data = merged;

  return {
    provider,
    matches: merged
  };
}

/* -------------------------------------------------- */
/* ROUTES */
/* -------------------------------------------------- */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Bahis Asistani Pro backend aktif"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "running",
    openai: !!openai,
    footballDataConfigured: !!FOOTBALL_DATA_API_KEY,
    rapidApiConfigured: !!RAPIDAPI_KEY,
    rapidApiHost: RAPIDAPI_HOST,
    rapidApiCustomPath: RAPIDAPI_MATCHES_BY_DATE_PATH
  });
});

/* -------------------------------------------------- */
/* TODAY MATCHES */
/* -------------------------------------------------- */

app.get("/today-matches", async (req, res) => {
  try {
    const day_offset = clamp(Number(req.query.day_offset) || 0, 0, 2);

    const match_limit = Math.max(
      1,
      Math.min(Number(req.query.match_limit) || 40, 150)
    );

    const date = getDateShiftedYmd(day_offset);

    const fixture = await getMatches(date);

    const all = fixture.matches;

    const finalMatches = all.slice(0, match_limit);

    res.json({
      ok: true,
      date_tr: date,
      fixture_source: fixture.provider,
      total_found: all.length,
      returned: finalMatches.length,
      matches: finalMatches
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* -------------------------------------------------- */
/* ANALYZE */
/* -------------------------------------------------- */

app.post("/analyze", async (req, res) => {
  try {
    const { match_limit = 10 } = req.body;

    const date = getTRDate();

    const fixture = await getMatches(date);

    const matches = fixture.matches.slice(0, match_limit);

    const tips = matches.map((m) => ({
      match: m.match,
      league: m.league,
      time: m.time,
      prediction: "Analiz bekleniyor",
      source_match: m.provider
    }));

    res.json({
      ok: true,
      source: "basic",
      fixture_source: fixture.provider,
      total_matches: tips.length,
      tips
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* -------------------------------------------------- */

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
