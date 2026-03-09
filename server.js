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
  process.env.RAPIDAPI_HOST || "free-api-live-football-data.p.rapidapi.com";
const RAPIDAPI_MATCHES_BY_DATE_PATH =
  process.env.RAPIDAPI_MATCHES_BY_DATE_PATH ||
  "/football-get-matches-by-date?date={date}";

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const DEFAULT_COMPETITION_CODES = [
  "PL",
  "PD",
  "SA",
  "BL1",
  "FL1",
  "PPL",
  "DED",
  "ELC",
  "BSA",
  "TSL",
  "CL",
  "EL",
  "ECL"
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
  "championship",
  "super lig",
  "süper lig",
  "champions league",
  "europa league",
  "conference league",
  "uefa",
  "brasileirao",
  "brazil"
];

const CACHE_TTL = {
  fixtureMs: 3 * 60 * 1000,
  standingsMs: 20 * 60 * 1000,
  teamMatchesMs: 20 * 60 * 1000,
  h2hMs: 30 * 60 * 1000
};

const MIN_CACHE_MATCHES = Number(process.env.MIN_CACHE_MATCHES || 8);

const CACHE = {
  fixture: {
    key: "",
    expiresAt: 0,
    data: []
  },
  standings: new Map(),
  teamMatches: new Map(),
  h2h: new Map()
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

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
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

function getDateShiftedYmd(daysOffset = 0) {
  const now = new Date();
  const shifted = new Date(now.getTime() + daysOffset * 24 * 60 * 60 * 1000);
  return getTRDateParts(shifted).ymd;
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

function ymdDashedToCompact(ymd) {
  return String(ymd || "").replace(/-/g, "");
}

function normalizeTextForKey(v = "") {
  return String(v)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeKey(match) {
  return [
    normalizeTextForKey(match.homeTeam),
    normalizeTextForKey(match.awayTeam),
    cleanText(match.trDate),
    cleanText(match.time)
  ].join("__");
}

function cacheGet(map, key) {
  const item = map.get(key);
  if (!item) return null;
  if (item.expiresAt <= nowTs()) {
    map.delete(key);
    return null;
  }
  return item.data;
}

function cacheSet(map, key, data, ttlMs) {
  map.set(key, {
    expiresAt: nowTs() + ttlMs,
    data
  });
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
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 350)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Gecerli JSON donmedi: ${text.slice(0, 350)}`);
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
    rawMatchId: id,
    provider: "football-data",
    match: `${home} vs ${away}`,
    homeTeam: home,
    awayTeam: away,
    homeTeamId: m?.homeTeam?.id || null,
    awayTeamId: m?.awayTeam?.id || null,
    league,
    country,
    competitionCode: code,
    competitionId: m?.competition?.id || null,
    utcDate,
    trDate: toTRYmd(utcDate),
    time: toTRTime(utcDate),
    status,
    stage: cleanText(m?.stage) || "Normal"
  };
}

function slugifyCompetitionCode(league = "", country = "") {
  const text = `${league} ${country}`.toLowerCase();

  if (text.includes("premier league")) return "PL";
  if (text.includes("la liga") || text.includes("primera division")) return "PD";
  if (text.includes("serie a")) return "SA";
  if (text.includes("bundesliga")) return "BL1";
  if (text.includes("ligue 1")) return "FL1";
  if (text.includes("primeira liga")) return "PPL";
  if (text.includes("eredivisie")) return "DED";
  if (text.includes("championship")) return "ELC";
  if (text.includes("super lig") || text.includes("süper lig")) return "TSL";
  if (text.includes("champions league")) return "CL";
  if (text.includes("europa league")) return "EL";
  if (text.includes("conference league")) return "ECL";
  if (text.includes("brasileirao")) return "BSA";

  return "";
}

function getObjectValueByPaths(obj, paths = []) {
  for (const path of paths) {
    let cur = obj;
    let ok = true;

    for (const part of path.split(".")) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, part)) {
        cur = cur[part];
      } else {
        ok = false;
        break;
      }
    }

    if (ok && cur != null) return cur;
  }

  return null;
}

function pickRapidApiItems(data) {
  const directCandidates = [
    data?.matches,
    data?.data,
    data?.response,
    data?.events,
    data?.fixtures,
    data?.results,
    data?.items,
    data?.events?.matches,
    data?.response?.matches,
    data?.response?.events,
    data?.data?.matches,
    data?.data?.events,
    data?.data?.response,
    data?.matchs
  ];

  for (const c of directCandidates) {
    if (Array.isArray(c) && c.length) {
      const looksLikeMatch = c.some(
        (x) =>
          x?.homeTeam ||
          x?.awayTeam ||
          x?.startTimestamp ||
          x?.tournament ||
          x?.status ||
          x?.teams ||
          x?.participants
      );

      if (looksLikeMatch) return c;

      const nestedEvents = [];
      for (const item of c) {
        if (Array.isArray(item?.events)) nestedEvents.push(...item.events);
        if (Array.isArray(item?.matches)) nestedEvents.push(...item.matches);
      }

      if (nestedEvents.length) return nestedEvents;
    }
  }

  if (data && typeof data === "object") {
    const nestedEvents = [];

    for (const v of Object.values(data)) {
      if (!Array.isArray(v)) continue;

      const looksLikeMatch = v.some(
        (x) =>
          x?.homeTeam ||
          x?.awayTeam ||
          x?.startTimestamp ||
          x?.tournament ||
          x?.status ||
          x?.teams ||
          x?.participants
      );

      if (looksLikeMatch) return v;

      for (const item of v) {
        if (Array.isArray(item?.events)) nestedEvents.push(...item.events);
        if (Array.isArray(item?.matches)) nestedEvents.push(...item.matches);
      }
    }

    if (nestedEvents.length) return nestedEvents;
  }

  return [];
}

function pickTeamFromArray(arr, idx) {
  if (!Array.isArray(arr) || !arr[idx]) return "";
  return cleanText(
    arr[idx]?.name ||
      arr[idx]?.team_name ||
      arr[idx]?.shortName ||
      arr[idx]?.short_name
  );
}

function pickTeamName(raw, side) {
  const s = side.toLowerCase();
  const index = side === "home" ? 0 : 1;

  return cleanText(
    getObjectValueByPaths(raw, [
      `${s}Team.name`,
      `${s}Team.team_name`,
      `${s}Team.shortName`,
      `${s}Team.short_name`,
      `${s}.name`,
      `${s}.team_name`,
      `${s}.shortName`,
      `${s}.short_name`,
      side === "home" ? "teams.home.name" : "teams.away.name",
      side === "home" ? "teams.home.team_name" : "teams.away.team_name",
      side === "home" ? "participant.home.name" : "participant.away.name",
      side === "home" ? "participants.home.name" : "participants.away.name",
      side === "home" ? "home_name" : "away_name",
      side === "home" ? "homeTeamName" : "awayTeamName",
      side === "home" ? "home_name_en" : "away_name_en",
      side === "home" ? "team_home.name" : "team_away.name",
      side === "home" ? "homeCompetitor.name" : "awayCompetitor.name"
    ]) || pickTeamFromArray(raw?.teams, index) || pickTeamFromArray(raw?.participants, index)
  );
}

function pickTeamId(raw, side) {
  const s = side.toLowerCase();
  const index = side === "home" ? 0 : 1;

  return (
    getObjectValueByPaths(raw, [
      `${s}Team.id`,
      `${s}.id`,
      side === "home" ? "teams.home.id" : "teams.away.id",
      side === "home" ? "participant.home.id" : "participant.away.id",
      side === "home" ? "participants.home.id" : "participants.away.id",
      side === "home" ? "homeTeamId" : "awayTeamId",
      side === "home" ? "team_home.id" : "team_away.id",
      side === "home" ? "homeCompetitor.id" : "awayCompetitor.id"
    ]) ||
    (Array.isArray(raw?.teams) ? raw.teams[index]?.id : null) ||
    (Array.isArray(raw?.participants) ? raw.participants[index]?.id : null) ||
    null
  );
}

function pickLeagueName(raw) {
  return cleanText(
    getObjectValueByPaths(raw, [
      "competition.name",
      "league.name",
      "tournament.name",
      "tournament.uniqueTournament.name",
      "uniqueTournament.name",
      "league_name",
      "competition_name",
      "league",
      "tournament",
      "category.name",
      "sport_event.tournament.name",
      "season.name"
    ])
  );
}

function pickCountryName(raw) {
  return cleanText(
    getObjectValueByPaths(raw, [
      "country.name",
      "area.name",
      "competition.area.name",
      "league.country",
      "country_name",
      "category.country_name",
      "tournament.category.name",
      "category.name",
      "sport_event.sport_event_context.category.name"
    ])
  );
}

function pickUtcDate(raw) {
  const directVal = cleanText(
    getObjectValueByPaths(raw, [
      "utcDate",
      "date",
      "match_date",
      "event_date",
      "kickoff",
      "kickoffTime",
      "kick_off",
      "startTime",
      "start_time",
      "startsAt",
      "starts_at",
      "scheduled_at",
      "fixture.date",
      "sport_event.start_time"
    ])
  );

  if (directVal) {
    const d = new Date(directVal);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  const timestampVal = getObjectValueByPaths(raw, [
    "startTimestamp",
    "start_timestamp",
    "fixture.timestamp",
    "sport_event.start_timestamp"
  ]);

  if (timestampVal != null) {
    const num = Number(timestampVal);
    if (!Number.isNaN(num) && num > 0) {
      const ms = num < 1000000000000 ? num * 1000 : num;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }

  return "";
}

function normalizeRapidApiStatus(rawStatus = "") {
  const s = cleanText(rawStatus).toLowerCase();

  if (!s) return "SCHEDULED";
  if (s.includes("not started")) return "SCHEDULED";
  if (s.includes("scheduled")) return "SCHEDULED";
  if (s.includes("postpon")) return "POSTPONED";
  if (s.includes("cancel")) return "CANCELLED";
  if (s.includes("finish")) return "FINISHED";
  if (s.includes("ft")) return "FINISHED";
  if (s.includes("live")) return "LIVE";
  if (s.includes("in progress")) return "LIVE";

  return rawStatus || "SCHEDULED";
}

function normalizeRapidApiMatch(raw) {
  const rawId =
    getObjectValueByPaths(raw, [
      "id",
      "event_id",
      "match_id",
      "fixture.id",
      "event.id",
      "sport_event.id",
      "customId"
    ]) || null;

  const home = pickTeamName(raw, "home");
  const away = pickTeamName(raw, "away");
  const league = pickLeagueName(raw);
  const country = pickCountryName(raw);
  const utcDate = pickUtcDate(raw);
  const status = normalizeRapidApiStatus(
    cleanText(
      getObjectValueByPaths(raw, [
        "status",
        "status.description",
        "status.type",
        "status.name",
        "match_status",
        "event_status",
        "fixture.status.long",
        "fixture.status.short",
        "sport_event_status.status"
      ])
    )
  );

  if (!home || !away || !utcDate) return null;
  if (home.toLowerCase() === away.toLowerCase()) return null;

  const safeLeague = league || "Unknown League";
  const competitionCode = slugifyCompetitionCode(safeLeague, country);

  return {
    id: `ra_${rawId || `${normalizeTextForKey(home)}_${normalizeTextForKey(away)}_${utcDate}`}`,
    rawMatchId: null,
    provider: "rapidapi",
    match: `${home} vs ${away}`,
    homeTeam: home,
    awayTeam: away,
    homeTeamId: pickTeamId(raw, "home"),
    awayTeamId: pickTeamId(raw, "away"),
    league: safeLeague,
    country,
    competitionCode,
    competitionId:
      getObjectValueByPaths(raw, [
        "competition.id",
        "league.id",
        "tournament.id",
        "tournament.uniqueTournament.id",
        "season.id"
      ]) || null,
    utcDate,
    trDate: toTRYmd(utcDate),
    time: toTRTime(utcDate),
    status,
    stage:
      cleanText(
        getObjectValueByPaths(raw, [
          "stage",
          "round",
          "roundInfo.round",
          "fixture.round",
          "sport_event.sport_event_context.round.name"
        ])
      ) || "Normal"
  };
}

function buildRapidApiCandidateUrls(dateYmd) {
  const base = `https://${RAPIDAPI_HOST}`;
  const rapidDate = ymdDashedToCompact(dateYmd);

  const paths = [
    RAPIDAPI_MATCHES_BY_DATE_PATH,
    `/football-get-matches-by-date?date=${rapidDate}`,
    `/matches-by-date?date=${rapidDate}`,
    `/events-by-date?date=${rapidDate}`,
    `/matches?date=${rapidDate}`,
    `/football/matches-by-date?date=${rapidDate}`,
    `/football/events-by-date?date=${rapidDate}`
  ]
    .map((x) => cleanText(x))
    .filter(Boolean)
    .map((p) => {
      const normalized = p.includes("{date}")
        ? p.replaceAll("{date}", rapidDate)
        : p;

      return normalized.startsWith("http")
        ? normalized
        : `${base}${normalized.startsWith("/") ? "" : "/"}${normalized}`;
    });

  return [...new Set(paths)];
}

async function fetchMatchesForDateFromRapidApi(dateYmd) {
  if (!RAPIDAPI_KEY || !RAPIDAPI_HOST) {
    throw new Error("RapidAPI env eksik");
  }

  const urls = buildRapidApiCandidateUrls(dateYmd);
  let lastError = null;

  for (const url of urls) {
    try {
      console.log("Trying RapidAPI URL:", url);

      const data = await fetchJson(
        url,
        {
          headers: {
            "x-rapidapi-key": RAPIDAPI_KEY,
            "x-rapidapi-host": RAPIDAPI_HOST
          }
        },
        20000
      );

      const items = pickRapidApiItems(data);
      console.log("RapidAPI raw item count:", items.length);

      const normalized = items
        .map((m) => normalizeRapidApiMatch(m))
        .filter(Boolean)
        .filter((m) => m.trDate === dateYmd);

      console.log("RapidAPI normalized count:", normalized.length);

      if (normalized.length > 0) {
        return {
          provider: "rapidapi",
          matches: dedupeMatches(normalized),
          debugUrl: url
        };
      }

      lastError = new Error(`RapidAPI 200 dondu ama parse edilen mac yok: ${url}`);
    } catch (error) {
      console.error("RapidAPI source failed:", error.message);
      lastError = error;
    }
  }

  throw lastError || new Error("RapidAPI kaynagi basarisiz");
}

function dedupeMatches(matches) {
  const seen = new Set();
  const out = [];

  for (const m of matches) {
    const key = dedupeKey(m);
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

function isFootballDataLike(match) {
  return String(match?.provider || "").includes("football-data");
}

function mergeTwoMatches(existing, incoming) {
  const existingIsFD = isFootballDataLike(existing);
  const incomingIsFD = isFootballDataLike(incoming);

  const preferredBase =
    incomingIsFD && !existingIsFD ? incoming : existing;

  const secondary =
    preferredBase === existing ? incoming : existing;

  const merged = {
    ...preferredBase,
    ...secondary
  };

  merged.id = preferredBase.id || secondary.id;
  merged.match = preferredBase.match || secondary.match;
  merged.homeTeam = preferredBase.homeTeam || secondary.homeTeam;
  merged.awayTeam = preferredBase.awayTeam || secondary.awayTeam;
  merged.utcDate = preferredBase.utcDate || secondary.utcDate;
  merged.trDate = preferredBase.trDate || secondary.trDate;
  merged.time = preferredBase.time || secondary.time;
  merged.status = preferredBase.status || secondary.status;
  merged.stage = preferredBase.stage || secondary.stage || "Normal";
  merged.country = preferredBase.country || secondary.country || "";
  merged.league = preferredBase.league || secondary.league || "Unknown League";

  merged.rawMatchId =
    (incomingIsFD ? incoming.rawMatchId : null) ||
    (existingIsFD ? existing.rawMatchId : null) ||
    preferredBase.rawMatchId ||
    secondary.rawMatchId ||
    null;

  merged.homeTeamId =
    (incomingIsFD ? incoming.homeTeamId : null) ||
    (existingIsFD ? existing.homeTeamId : null) ||
    preferredBase.homeTeamId ||
    secondary.homeTeamId ||
    null;

  merged.awayTeamId =
    (incomingIsFD ? incoming.awayTeamId : null) ||
    (existingIsFD ? existing.awayTeamId : null) ||
    preferredBase.awayTeamId ||
    secondary.awayTeamId ||
    null;

  merged.competitionCode =
    (incomingIsFD ? incoming.competitionCode : "") ||
    (existingIsFD ? existing.competitionCode : "") ||
    preferredBase.competitionCode ||
    secondary.competitionCode ||
    slugifyCompetitionCode(merged.league, merged.country);

  merged.competitionId =
    (incomingIsFD ? incoming.competitionId : null) ||
    (existingIsFD ? existing.competitionId : null) ||
    preferredBase.competitionId ||
    secondary.competitionId ||
    null;

  merged.provider =
    merged.rawMatchId && merged.homeTeamId && merged.awayTeamId
      ? "football-data+rapidapi"
      : (incomingIsFD || existingIsFD)
      ? "football-data-partial"
      : preferredBase.provider || secondary.provider || "unknown";

  return merged;
}

function mergeMatchSources(primary, secondary) {
  const map = new Map();

  for (const m of [...primary, ...secondary]) {
    const key = dedupeKey(m);

    if (!map.has(key)) {
      map.set(key, m);
      continue;
    }

    const existing = map.get(key);
    map.set(key, mergeTwoMatches(existing, m));
  }

  return sortMatches([...map.values()]);
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

async function fetchCompetitionMatches(code, dateFrom, dateTo) {
  const url = `https://api.football-data.org/v4/competitions/${encodeURIComponent(code)}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;
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
      .filter((m) => m.trDate >= dateFrom && m.trDate <= dateTo);

    console.log(`Competition ${code} normalized matches:`, normalized.length);

    return normalized;
  } catch (error) {
    console.error(`Competition ${code} failed:`, error.message);
    return [];
  }
}

async function fetchMatchesForDateRangeFromFootballDataCompetitions(dateFrom, dateTo) {
  if (!FOOTBALL_DATA_API_KEY) {
    throw new Error("FOOTBALL_DATA_API_KEY tanimli degil");
  }

  const all = [];

  for (const code of DEFAULT_COMPETITION_CODES) {
    const matches = await fetchCompetitionMatches(code, dateFrom, dateTo);
    all.push(...matches);
  }

  const finalMatches = dedupeMatches(sortMatches(all));
  console.log("Competition aggregate final match count:", finalMatches.length);

  return {
    provider: "football-data-competitions",
    matches: finalMatches
  };
}

async function getMatchesWithCache(
  dateFrom,
  dateTo,
  options = {}
) {
  const { forceRefresh = false, minNeeded = MIN_CACHE_MATCHES } = options;
  const cacheKey = `range_${dateFrom}_${dateTo}`;

  if (
    !forceRefresh &&
    CACHE.fixture.key === cacheKey &&
    CACHE.fixture.expiresAt > nowTs() &&
    Array.isArray(CACHE.fixture.data) &&
    CACHE.fixture.data.length >= minNeeded
  ) {
    console.log("Fixture cache hit:", CACHE.fixture.data.length);
    return {
      provider: "cache",
      matches: CACHE.fixture.data
    };
  }

  if (
    !forceRefresh &&
    CACHE.fixture.key === cacheKey &&
    CACHE.fixture.expiresAt > nowTs() &&
    Array.isArray(CACHE.fixture.data) &&
    CACHE.fixture.data.length > 0 &&
    CACHE.fixture.data.length < minNeeded
  ) {
    console.log(
      "Fixture cache bypassed due to low count:",
      CACHE.fixture.data.length,
      "minNeeded:",
      minNeeded
    );
  } else {
    console.log("Fixture cache miss, fetching RapidAPI + football-data...");
  }

  let rapidResult = { provider: "rapidapi-failed", matches: [] };
  let footballResult = { provider: "football-data-failed", matches: [] };

  try {
    rapidResult = await fetchMatchesForDateFromRapidApi(dateFrom);
  } catch (error) {
    console.error("RapidAPI main source fail:", error.message);
  }

  try {
    footballResult = await fetchMatchesForDateRangeFromFootballDataCompetitions(dateFrom, dateTo);
  } catch (error) {
    console.error("Football-data backup fail:", error.message);
  }

  const merged = mergeMatchSources(
    Array.isArray(rapidResult.matches) ? rapidResult.matches : [],
    Array.isArray(footballResult.matches) ? footballResult.matches : []
  );

  let provider = "none";
  if (rapidResult.matches.length && footballResult.matches.length) provider = "rapidapi+football-data";
  else if (rapidResult.matches.length) provider = "rapidapi";
  else if (footballResult.matches.length) provider = "football-data-competitions";

  if (Array.isArray(merged) && merged.length > 0) {
    CACHE.fixture.key = cacheKey;
    CACHE.fixture.expiresAt = nowTs() + CACHE_TTL.fixtureMs;
    CACHE.fixture.data = merged;
    console.log("Fixture cache updated with matches:", merged.length);
  } else {
    CACHE.fixture.key = "";
    CACHE.fixture.expiresAt = 0;
    CACHE.fixture.data = [];
    console.log("No matches found, empty result NOT cached.");
  }

  return {
    provider,
    matches: merged
  };
}

async function fetchCompetitionStandings(code) {
  const cacheKey = `standings_${code}`;
  const cached = cacheGet(CACHE.standings, cacheKey);
  if (cached) return cached;

  if (!code || !FOOTBALL_DATA_API_KEY) {
    const empty = {};
    cacheSet(CACHE.standings, cacheKey, empty, 2 * 60 * 1000);
    return empty;
  }

  const url = `https://api.football-data.org/v4/competitions/${encodeURIComponent(code)}/standings`;
  try {
    const data = await fetchJson(url, {
      headers: {
        "X-Auth-Token": FOOTBALL_DATA_API_KEY
      }
    });

    const standingsList = Array.isArray(data?.standings) ? data.standings : [];
    const preferred =
      standingsList.find((s) => cleanText(s?.type).toUpperCase() === "TOTAL") ||
      standingsList[0] ||
      null;

    const table = Array.isArray(preferred?.table) ? preferred.table : [];
    const mapped = {};

    for (const row of table) {
      const teamId = row?.team?.id;
      if (!teamId) continue;

      mapped[teamId] = {
        position: row?.position ?? null,
        points: row?.points ?? null,
        playedGames: row?.playedGames ?? null,
        won: row?.won ?? null,
        draw: row?.draw ?? null,
        lost: row?.lost ?? null,
        goalsFor: row?.goalsFor ?? null,
        goalsAgainst: row?.goalsAgainst ?? null,
        goalDifference: row?.goalDifference ?? null,
        form: cleanText(row?.form || "")
      };
    }

    cacheSet(CACHE.standings, cacheKey, mapped, CACHE_TTL.standingsMs);
    return mapped;
  } catch (error) {
    console.error(`Standings fetch failed for ${code}:`, error.message);
    const empty = {};
    cacheSet(CACHE.standings, cacheKey, empty, 2 * 60 * 1000);
    return empty;
  }
}

function parseFormString(formStr) {
  const raw = cleanText(formStr);
  if (!raw) {
    return {
      form5: "",
      form10: "",
      formScore5: 0,
      formScore10: 0
    };
  }

  const parts = raw
    .split(/[,\s-]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);

  const calc = (arr) => {
    if (!arr.length) return 0;
    let pts = 0;
    for (const r of arr) {
      if (r === "W") pts += 3;
      else if (r === "D") pts += 1;
    }
    return round2((pts / (arr.length * 3)) * 100);
  };

  const last5 = parts.slice(-5);
  const last10 = parts.slice(-10);

  return {
    form5: last5.join("-"),
    form10: last10.join("-"),
    formScore5: calc(last5),
    formScore10: calc(last10)
  };
}

function extractResultFromTeamPerspective(match, teamId) {
  const homeId = match?.homeTeam?.id;
  const awayId = match?.awayTeam?.id;
  const homeScore = match?.score?.fullTime?.home;
  const awayScore = match?.score?.fullTime?.away;

  if (homeScore == null || awayScore == null) return null;
  if (teamId !== homeId && teamId !== awayId) return null;

  const isHome = teamId === homeId;
  const gf = isHome ? homeScore : awayScore;
  const ga = isHome ? awayScore : homeScore;

  let result = "D";
  if (gf > ga) result = "W";
  else if (gf < ga) result = "L";

  return {
    gf,
    ga,
    result,
    btts: gf > 0 && ga > 0,
    over25: gf + ga >= 3,
    firstHalf2Plus: ((match?.score?.halfTime?.home || 0) + (match?.score?.halfTime?.away || 0)) >= 2
  };
}

async function fetchTeamRecentMatches(teamId, dateTo, limit = 10) {
  if (!teamId || !FOOTBALL_DATA_API_KEY) return [];

  const cacheKey = `team_${teamId}_${dateTo}_${limit}`;
  const cached = cacheGet(CACHE.teamMatches, cacheKey);
  if (cached) return cached;

  const dateFrom = getDateShiftedYmd(-120);
  const url = `https://api.football-data.org/v4/teams/${encodeURIComponent(teamId)}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&status=FINISHED&limit=${limit + 6}`;

  try {
    const data = await fetchJson(url, {
      headers: {
        "X-Auth-Token": FOOTBALL_DATA_API_KEY
      }
    });

    const matches = Array.isArray(data?.matches) ? data.matches : [];
    const sliced = matches
      .filter((m) => cleanText(m?.status).toUpperCase() === "FINISHED")
      .sort((a, b) => new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime())
      .slice(0, limit);

    cacheSet(CACHE.teamMatches, cacheKey, sliced, CACHE_TTL.teamMatchesMs);
    return sliced;
  } catch (error) {
    console.error(`Team matches fetch failed for team ${teamId}:`, error.message);
    cacheSet(CACHE.teamMatches, cacheKey, [], 2 * 60 * 1000);
    return [];
  }
}

function buildRecentTeamStats(teamMatches, teamId) {
  const stats = {
    matches: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    bttsCount: 0,
    over25Count: 0,
    firstHalf2PlusCount: 0,
    results: []
  };

  for (const m of teamMatches) {
    const r = extractResultFromTeamPerspective(m, teamId);
    if (!r) continue;

    stats.matches += 1;
    stats.goalsFor += r.gf;
    stats.goalsAgainst += r.ga;
    if (r.result === "W") stats.wins += 1;
    else if (r.result === "D") stats.draws += 1;
    else stats.losses += 1;

    if (r.btts) stats.bttsCount += 1;
    if (r.over25) stats.over25Count += 1;
    if (r.firstHalf2Plus) stats.firstHalf2PlusCount += 1;
    stats.results.push(r.result);
  }

  const played = Math.max(stats.matches, 1);
  const formScore = round2(((stats.wins * 3 + stats.draws) / (played * 3)) * 100);

  return {
    played: stats.matches,
    wins: stats.wins,
    draws: stats.draws,
    losses: stats.losses,
    goalsForAvg: round2(stats.goalsFor / played),
    goalsAgainstAvg: round2(stats.goalsAgainst / played),
    bttsRate: round2((stats.bttsCount / played) * 100),
    over25Rate: round2((stats.over25Count / played) * 100),
    firstHalf2PlusRate: round2((stats.firstHalf2PlusCount / played) * 100),
    form5: stats.results.slice(0, 5).reverse().join("-"),
    form10: stats.results.slice(0, 10).reverse().join("-"),
    formScore
  };
}

async function fetchMatchH2H(matchId) {
  if (!matchId || !FOOTBALL_DATA_API_KEY) return null;

  const cacheKey = `h2h_${matchId}`;
  const cached = cacheGet(CACHE.h2h, cacheKey);
  if (cached) return cached;

  const url = `https://api.football-data.org/v4/matches/${encodeURIComponent(matchId)}/head2head?limit=5`;

  try {
    const data = await fetchJson(url, {
      headers: {
        "X-Auth-Token": FOOTBALL_DATA_API_KEY
      }
    });

    cacheSet(CACHE.h2h, cacheKey, data, CACHE_TTL.h2hMs);
    return data;
  } catch (error) {
    console.error(`H2H fetch failed for match ${matchId}:`, error.message);
    cacheSet(CACHE.h2h, cacheKey, null, 2 * 60 * 1000);
    return null;
  }
}

function summarizeH2H(h2hData, homeTeamId, awayTeamId) {
  const matches = Array.isArray(h2hData?.matches) ? h2hData.matches : [];
  if (!matches.length) {
    return {
      matches: 0,
      homeWins: 0,
      draws: 0,
      awayWins: 0,
      avgGoals: 0,
      bttsRate: 0,
      over25Rate: 0,
      firstHalf2PlusRate: 0,
      summary: "Yeterli H2H verisi yok."
    };
  }

  let homeWins = 0;
  let awayWins = 0;
  let draws = 0;
  let totalGoals = 0;
  let bttsCount = 0;
  let over25Count = 0;
  let firstHalf2PlusCount = 0;

  for (const m of matches) {
    const homeId = m?.homeTeam?.id;
    const awayId = m?.awayTeam?.id;
    const homeScore = m?.score?.fullTime?.home;
    const awayScore = m?.score?.fullTime?.away;

    if (homeScore == null || awayScore == null) continue;

    totalGoals += homeScore + awayScore;
    if (homeScore > 0 && awayScore > 0) bttsCount += 1;
    if (homeScore + awayScore >= 3) over25Count += 1;
    if (((m?.score?.halfTime?.home || 0) + (m?.score?.halfTime?.away || 0)) >= 2) {
      firstHalf2PlusCount += 1;
    }

    if (homeScore === awayScore) {
      draws += 1;
      continue;
    }

    const winnerId = homeScore > awayScore ? homeId : awayId;
    if (winnerId === homeTeamId) homeWins += 1;
    else if (winnerId === awayTeamId) awayWins += 1;
  }

  let summary = "H2H dengeli gorunuyor.";
  if (homeWins >= awayWins + 2) summary = "Son H2H serisi ev sahibi lehine.";
  else if (awayWins >= homeWins + 2) summary = "Son H2H serisi deplasman lehine.";
  else if (over25Count >= Math.ceil(matches.length * 0.6)) summary = "H2H tarafinda gollu mac egilimi var.";

  return {
    matches: matches.length,
    homeWins,
    draws,
    awayWins,
    avgGoals: round2(totalGoals / matches.length),
    bttsRate: round2((bttsCount / matches.length) * 100),
    over25Rate: round2((over25Count / matches.length) * 100),
    firstHalf2PlusRate: round2((firstHalf2PlusCount / matches.length) * 100),
    summary
  };
}

async function enrichMatch(match) {
  const standings = await fetchCompetitionStandings(match.competitionCode);

  const homeStanding = match.homeTeamId ? standings[match.homeTeamId] || null : null;
  const awayStanding = match.awayTeamId ? standings[match.awayTeamId] || null : null;

  const dateTo = getTRDateParts(new Date(new Date(match.utcDate).getTime() - 60 * 1000)).ymd;

  const canUseFootballDataEnrichment =
    !!match.rawMatchId &&
    !!match.homeTeamId &&
    !!match.awayTeamId &&
    !!match.competitionCode;

  const [homeRecent, awayRecent, h2hData] = await Promise.all([
    canUseFootballDataEnrichment
      ? fetchTeamRecentMatches(match.homeTeamId, dateTo, 10)
      : Promise.resolve([]),
    canUseFootballDataEnrichment
      ? fetchTeamRecentMatches(match.awayTeamId, dateTo, 10)
      : Promise.resolve([]),
    canUseFootballDataEnrichment
      ? fetchMatchH2H(match.rawMatchId)
      : Promise.resolve(null)
  ]);

  const homeRecentStats = buildRecentTeamStats(homeRecent, match.homeTeamId);
  const awayRecentStats = buildRecentTeamStats(awayRecent, match.awayTeamId);

  const homeStandingForm = parseFormString(homeStanding?.form || "");
  const awayStandingForm = parseFormString(awayStanding?.form || "");

  const h2h = summarizeH2H(h2hData, match.homeTeamId, match.awayTeamId);

  return {
    ...match,
    enriched: {
      home: {
        standing: homeStanding,
        standingForm: homeStandingForm,
        recent: homeRecentStats
      },
      away: {
        standing: awayStanding,
        standingForm: awayStandingForm,
        recent: awayRecentStats
      },
      h2h,
      enrichmentLevel: canUseFootballDataEnrichment ? "full" : "limited"
    }
  };
}

function buildStrengthScore(side, opponent) {
  const recent = side?.recent || {};
  const standing = side?.standing || {};
  const standingForm = side?.standingForm || {};

  const oppRecent = opponent?.recent || {};
  const oppStanding = opponent?.standing || {};

  let score = 50;

  score += (Number(recent.formScore || 0) - 50) * 0.35;
  score += (Number(recent.goalsForAvg || 0) - Number(recent.goalsAgainstAvg || 0)) * 8;
  score += (Number(recent.over25Rate || 0) - 50) * 0.06;
  score += (Number(recent.bttsRate || 0) - 50) * 0.03;
  score += (Number(standingForm.formScore5 || 0) - 50) * 0.15;

  if (standing.position && oppStanding.position) {
    const posEdge = Number(oppStanding.position) - Number(standing.position);
    score += posEdge * 1.8;
  }

  if (standing.points != null && oppStanding.points != null) {
    score += (Number(standing.points) - Number(oppStanding.points)) * 0.12;
  }

  score -= (Number(oppRecent.formScore || 0) - 50) * 0.18;

  return round2(clamp(score, 1, 99));
}

function confidenceFromLean(mainLean, riskScore) {
  const x = mainLean - riskScore * 0.25;
  if (x >= 72) return "Cok Yuksek";
  if (x >= 62) return "Yuksek";
  if (x >= 52) return "Orta";
  return "Dusuk";
}

function riskFromBalance(balanceDiff, volatility) {
  const riskRaw = volatility - Math.min(balanceDiff, 25) * 0.7;
  if (riskRaw <= 18) return "Dusuk risk";
  if (riskRaw <= 32) return "Orta risk";
  return "Yuksek risk";
}

function buildReasonLineForData(match, home, away, enrichmentLevel) {
  const homeForm = home?.recent?.form10 || home?.standingForm?.form10 || "sinirli veri";
  const awayForm = away?.recent?.form10 || away?.standingForm?.form10 || "sinirli veri";

  if (enrichmentLevel === "full") {
    return `Form verisi: ${match.homeTeam} son maclarda ${homeForm}, ${match.awayTeam} ise ${awayForm}.`;
  }

  return `Veri kapsami sinirli: ${match.homeTeam} ve ${match.awayTeam} icin temel fikstur profili uzerinden analiz yapildi.`;
}

function buildRealTipFromEnrichedMatch(match, extraPrompt = "") {
  const home = match?.enriched?.home || {};
  const away = match?.enriched?.away || {};
  const h2h = match?.enriched?.h2h || {};
  const enrichmentLevel = match?.enriched?.enrichmentLevel || "limited";

  const homeStrength = buildStrengthScore(home, away);
  const awayStrength = buildStrengthScore(away, home);
  const gap = round2(homeStrength - awayStrength);
  const balanceDiff = Math.abs(gap);

  let resultPrediction = "X";
  if (gap >= 8) resultPrediction = "1";
  else if (gap <= -8) resultPrediction = "2";

  const combinedGoalBase =
    (Number(home?.recent?.goalsForAvg || 0) + Number(away?.recent?.goalsForAvg || 0)) * 17 +
    (Number(home?.recent?.goalsAgainstAvg || 0) + Number(away?.recent?.goalsAgainstAvg || 0)) * 8;

  let over25Lean = clamp(
    Math.round(
      combinedGoalBase * 0.9 +
      Number(home?.recent?.over25Rate || 0) * 0.30 +
      Number(away?.recent?.over25Rate || 0) * 0.30 +
      Number(h2h?.over25Rate || 0) * 0.24 -
      28
    ),
    10,
    92
  );

  let bttsLean = clamp(
    Math.round(
      Number(home?.recent?.bttsRate || 0) * 0.40 +
      Number(away?.recent?.bttsRate || 0) * 0.40 +
      Number(h2h?.bttsRate || 0) * 0.20
    ),
    8,
    90
  );

  let firstHalf2PlusLean = clamp(
    Math.round(
      Number(home?.recent?.firstHalf2PlusRate || 0) * 0.42 +
      Number(away?.recent?.firstHalf2PlusRate || 0) * 0.42 +
      Number(h2h?.firstHalf2PlusRate || 0) * 0.16
    ),
    5,
    78
  );

  if (enrichmentLevel !== "full") {
    over25Lean = clamp(Math.round((over25Lean * 0.55) + 20), 12, 68);
    bttsLean = clamp(Math.round((bttsLean * 0.55) + 18), 10, 65);
    firstHalf2PlusLean = clamp(Math.round((firstHalf2PlusLean * 0.50) + 10), 5, 45);
  }

  const homeLean = clamp(
    Math.round(
      50 + gap * 2.2 +
      (h2h.homeWins - h2h.awayWins) * 2
    ),
    5,
    90
  );

  const awayLean = clamp(
    Math.round(
      50 + (awayStrength - homeStrength) * 2.2 +
      (h2h.awayWins - h2h.homeWins) * 2
    ),
    5,
    90
  );

  const volatility =
    Math.abs(Number(home?.recent?.goalsForAvg || 0) - Number(home?.recent?.goalsAgainstAvg || 0)) * 4 +
    Math.abs(Number(away?.recent?.goalsForAvg || 0) - Number(away?.recent?.goalsAgainstAvg || 0)) * 4 +
    Math.abs(50 - bttsLean) * 0.12 +
    Math.abs(50 - over25Lean) * 0.10 +
    (enrichmentLevel === "full" ? 0 : 10);

  const dominantLean = Math.max(homeLean, awayLean, over25Lean, bttsLean);
  const riskNote = riskFromBalance(balanceDiff, volatility);
  const confidence = confidenceFromLean(dominantLean, volatility);

  let recommendedBet = "Cifte Sans 1X";
  if (resultPrediction === "1" && over25Lean >= 64) recommendedBet = "Mac Sonucu 1 ve 1.5 Ust";
  else if (resultPrediction === "1" && balanceDiff >= 10) recommendedBet = "Mac Sonucu 1";
  else if (resultPrediction === "2" && over25Lean >= 64) recommendedBet = "Mac Sonucu 2 veya 1.5 Ust";
  else if (resultPrediction === "2" && balanceDiff >= 10) recommendedBet = "Mac Sonucu 2";
  else if (over25Lean >= 68) recommendedBet = "2.5 Ust";
  else if (bttsLean >= 64) recommendedBet = "KG Var";
  else if (resultPrediction === "X") recommendedBet = "X veya 3.5 Alt";

  let scorePrediction = "1-1";
  if (resultPrediction === "1" && over25Lean >= 70) scorePrediction = "2-1";
  else if (resultPrediction === "1" && over25Lean < 55) scorePrediction = "1-0";
  else if (resultPrediction === "2" && over25Lean >= 70) scorePrediction = "1-2";
  else if (resultPrediction === "2" && over25Lean < 55) scorePrediction = "0-1";
  else if (over25Lean >= 76 && bttsLean >= 60) scorePrediction = "2-2";

  let tableContext = "Lig siralamasi dengeli gorunuyor.";
  const homePos = home?.standing?.position;
  const awayPos = away?.standing?.position;
  if (homePos && awayPos) {
    if (homePos + 4 <= awayPos) {
      tableContext = "Ev sahibi lig siralamasi ve puan tablosunda daha avantajli.";
    } else if (awayPos + 4 <= homePos) {
      tableContext = "Deplasman tarafi lig tablosunda daha ust seviyede.";
    } else {
      tableContext = "Iki takim lig tablosunda birbirine yakin.";
    }
  } else if (enrichmentLevel !== "full") {
    tableContext = `${match.league} maci icin tablo verisi sinirli, temel guc dengesi kullanildi.`;
  }

  const h2hSummary =
    enrichmentLevel === "full"
      ? h2h?.summary || "Yeterli H2H verisi yok."
      : `${match.homeTeam} - ${match.awayTeam} icin detayli H2H verisi sinirli.`;

  const reasons = [
    buildReasonLineForData(match, home, away, enrichmentLevel),
    `Gol egilimi: 2.5 Ust %${over25Lean}, KG Var %${bttsLean}, Ilk yari 2+ gol %${firstHalf2PlusLean}.`,
    extraPrompt
      ? `Ek not dikkate alindi: ${cleanText(extraPrompt).slice(0, 110)}`
      : enrichmentLevel === "full"
      ? `H2H ozeti: ${h2hSummary}`
      : `Mac profili: ${match.league} / ${match.country || "Bilinmeyen ulke"} verisiyle dusuk-guven analizi.`
  ];

  return {
    match_id: match.id,
    raw_match_id: match.rawMatchId,
    match: match.match,
    league: match.league,
    time: match.time,
    match_importance: match.stage || "Normal",
    confidence,
    risk_note: riskNote,
    result_prediction: resultPrediction,
    score_prediction: scorePrediction,
    prob_over25: over25Lean,
    prob_first_half_2plus: firstHalf2PlusLean,
    prob_btts: bttsLean,
    home_lean: homeLean,
    away_lean: awayLean,
    recommended_bet: recommendedBet,
    h2h_summary: h2hSummary,
    home_form: home?.recent?.form10 || home?.standingForm?.form10 || "",
    away_form: away?.recent?.form10 || away?.standingForm?.form10 || "",
    home_goals_avg: home?.recent?.goalsForAvg ?? 0,
    home_conceded_avg: home?.recent?.goalsAgainstAvg ?? 0,
    away_goals_avg: away?.recent?.goalsForAvg ?? 0,
    away_conceded_avg: away?.recent?.goalsAgainstAvg ?? 0,
    home_performance:
      homeStrength >= 72 ? "Cok guclu" :
      homeStrength >= 61 ? "Iyi" :
      homeStrength >= 50 ? "Orta" : "Dalgali",
    away_performance:
      awayStrength >= 72 ? "Cok guclu" :
      awayStrength >= 61 ? "Iyi" :
      awayStrength >= 50 ? "Orta" : "Dalgali",
    table_context: tableContext,
    reasons,
    source_match: match.provider,
    real_data: {
      enrichmentLevel,
      home: {
        teamId: match.homeTeamId,
        position: home?.standing?.position ?? null,
        points: home?.standing?.points ?? null,
        form5: home?.recent?.form5 || home?.standingForm?.form5 || "",
        form10: home?.recent?.form10 || home?.standingForm?.form10 || "",
        formScore: home?.recent?.formScore ?? home?.standingForm?.formScore10 ?? 0
      },
      away: {
        teamId: match.awayTeamId,
        position: away?.standing?.position ?? null,
        points: away?.standing?.points ?? null,
        form5: away?.recent?.form5 || away?.standingForm?.form5 || "",
        form10: away?.recent?.form10 || away?.standingForm?.form10 || "",
        formScore: away?.recent?.formScore ?? away?.standingForm?.formScore10 ?? 0
      },
      h2h: {
        matches: h2h.matches || 0,
        homeWins: h2h.homeWins || 0,
        draws: h2h.draws || 0,
        awayWins: h2h.awayWins || 0,
        avgGoals: h2h.avgGoals || 0,
        over25Rate: h2h.over25Rate || 0,
        bttsRate: h2h.bttsRate || 0
      }
    }
  };
}

async function improveTipsWithOpenAI(tips, extraPrompt = "") {
  if (!openai) {
    return { tips, source: "fallback-realdata" };
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
- Gercek sayisal verileri bozma
- match, match_id, raw_match_id, league, time, source_match, real_data alanlarini degistirme
- Her macin metni farkli olsun, ayni sablonu tekrar etme
- Ek istek: ${extraPrompt || "yok"}

Veri:
${JSON.stringify(tips, null, 2)}
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.45,
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
        raw_match_id: tips[i].raw_match_id,
        league: tips[i].league,
        time: tips[i].time,
        source_match: tips[i].source_match,
        real_data: tips[i].real_data
      }));

      return { tips: safeTips, source: "openai" };
    }

    return { tips, source: "fallback-openai-parse" };
  } catch (error) {
    console.error("OpenAI fallback devrede:", error?.message || error);
    return { tips, source: "fallback-openai-error" };
  }
}

function sortByStrength(tips) {
  const scoreTip = (tip) => {
    let score = 0;
    score += Number(tip.prob_over25 || 0) * 0.18;
    score += Number(tip.prob_btts || 0) * 0.11;
    score += Number(tip.prob_first_half_2plus || 0) * 0.07;
    score += Math.max(Number(tip.home_lean || 0), Number(tip.away_lean || 0)) * 0.18;

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
      Number(tip.prob_over25 || 0) >= 66
        ? "2.5 Ust"
        : Number(tip.prob_btts || 0) >= 62
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
      match_details: "/match-details/:id",
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
    rapidApiConfigured: !!RAPIDAPI_KEY,
    rapidApiHost: RAPIDAPI_HOST || null,
    rapidApiCustomPath: RAPIDAPI_MATCHES_BY_DATE_PATH || null,
    cacheActive: true,
    minCacheMatches: MIN_CACHE_MATCHES,
    competitions: DEFAULT_COMPETITION_CODES,
    cacheInfo: {
      fixtureTtlMinutes: CACHE_TTL.fixtureMs / 60000,
      standingsTtlMinutes: CACHE_TTL.standingsMs / 60000,
      teamMatchesTtlMinutes: CACHE_TTL.teamMatchesMs / 60000,
      h2hTtlMinutes: CACHE_TTL.h2hMs / 60000
    }
  });
});

app.get("/today-matches", async (req, res) => {
  try {
    const league_mode = String(req.query.league_mode || "all");
    const custom_leagues = String(req.query.custom_leagues || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    const match_limit = Math.max(1, Math.min(Number(req.query.match_limit) || 40, 150));
    const day_offset = clamp(Number(req.query.day_offset) || 0, 0, 2);
    const force_refresh = String(req.query.force_refresh || "0") === "1";

    const dateFrom = getDateShiftedYmd(day_offset);
    const dateTo = dateFrom;

    const fixtureResult = await getMatchesWithCache(dateFrom, dateTo, {
      forceRefresh: force_refresh,
      minNeeded: Math.max(MIN_CACHE_MATCHES, Math.min(match_limit, 20))
    });

    const allToday = fixtureResult.matches;
    const filtered = filterLeagueMode(allToday, league_mode, custom_leagues);
    const finalMatches = filtered.slice(0, match_limit);

    res.json({
      ok: true,
      date_tr: dateFrom,
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
      error: error?.message || "Maclar alinamadi"
    });
  }
});

app.get("/match-details/:id", async (req, res) => {
  try {
    const matchId = String(req.params.id || "").trim();
    if (!matchId) {
      return res.status(400).json({
        ok: false,
        error: "Gecerli match id gerekli"
      });
    }

    const allMatchesResult = await getMatchesWithCache(getDateShiftedYmd(0), getDateShiftedYmd(0), {
      forceRefresh: String(req.query.force_refresh || "0") === "1",
      minNeeded: MIN_CACHE_MATCHES
    });

    const found =
      allMatchesResult.matches.find((m) => m.id === matchId || String(m.rawMatchId) === matchId) ||
      null;

    if (!found) {
      return res.status(404).json({
        ok: false,
        error: "Mac bulunamadi"
      });
    }

    const enriched = await enrichMatch(found);

    res.json({
      ok: true,
      match: enriched
    });
  } catch (error) {
    console.error("match-details error:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || "Mac detayi alinamadi"
    });
  }
});

app.post("/analyze", async (req, res) => {
  try {
    const {
      match_limit = 10,
      league_mode = "all",
      custom_leagues = [],
      extra_prompt = "",
      day_offset = 0,
      force_refresh = false
    } = req.body || {};

    const safeDayOffset = clamp(Number(day_offset) || 0, 0, 2);
    const dateFrom = getDateShiftedYmd(safeDayOffset);
    const dateTo = dateFrom;

    const safeLimit = Math.max(1, Math.min(Number(match_limit) || 10, 20));

    const fixtureResult = await getMatchesWithCache(dateFrom, dateTo, {
      forceRefresh: !!force_refresh,
      minNeeded: Math.max(MIN_CACHE_MATCHES, safeLimit)
    });

    const allToday = fixtureResult.matches;
    const filtered = filterLeagueMode(allToday, league_mode, custom_leagues);
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
          message: "Filtreye uygun mac bulunamadi.",
          total_found_today: allToday.length,
          total_after_filter: filtered.length,
          analyze_date: dateFrom
        }
      });
    }

    const enrichedMatches = [];
    for (const m of selectedMatches) {
      try {
        const enriched = await enrichMatch(m);
        enrichedMatches.push(enriched);
      } catch (error) {
        console.error("Enrich failed for match:", m?.id, error?.message || error);
        enrichedMatches.push({
          ...m,
          enriched: {
            home: { standing: null, standingForm: {}, recent: {} },
            away: { standing: null, standingForm: {}, recent: {} },
            h2h: {
              matches: 0,
              homeWins: 0,
              draws: 0,
              awayWins: 0,
              avgGoals: 0,
              bttsRate: 0,
              over25Rate: 0,
              firstHalf2PlusRate: 0,
              summary: "Veri alinamadi."
            },
            enrichmentLevel: "limited"
          }
        });
      }
    }

    const localTips = enrichedMatches.map((m) => buildRealTipFromEnrichedMatch(m, extra_prompt));
    const improved = await improveTipsWithOpenAI(localTips, extra_prompt);
    const finalTips = sortByStrength(improved.tips);
    const coupons = buildCoupons(finalTips);

    res.json({
      ok: true,
      source: improved.source,
      fixture_source: fixtureResult.provider,
      analyze_date: dateFrom,
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
