#!/usr/bin/env node

/**
 * ═══════════════════════════════════════════════════════════════════════
 *  LegalDesk API Server
 *  REST API wrapper for Allahabad High Court data
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  Endpoints:
 *    POST /api/validate-advocate     — Validate Bar Council enrollment & fetch advocate info
 *    GET  /api/advocate-cases/:roll  — Fetch all cases for an advocate by roll number
 *    GET  /api/case-status           — Get case status by type/number/year
 *    GET  /api/case-history          — Get listing history & IA details
 *    GET  /api/causelist-today       — Today's cause list for live ETA
 *    GET  /api/court-calendar        — Court holidays & vacations
 *    GET  /api/court-view            — Live court display board
 *    GET  /health                    — Health check
 *
 *  Deploy:
 *    npm install && npm start
 *    Default port: 3001 (or PORT env var)
 */

import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";

// ─────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
const BASE_URL = "https://www.allahabadhighcourt.in";
const CCMS_ALD = `${BASE_URL}/apps/status_ccms`;
const CCMS_LKO = `${BASE_URL}/apps/status_ccms_lko`;
const ELEGALIX = "https://elegalix.allahabadhighcourt.in/elegalix";
const COURT_VIEW_ALD = "https://courtview2.allahabadhighcourt.in/courtview/CourtViewAllahabad.do";
const COURT_VIEW_LKO = "https://courtview2.allahabadhighcourt.in/courtview/CourtViewLucknow.do";
const ECOURTS_BASE = "https://services.ecourts.gov.in/ecourtindia_v6";
const BCI_SEARCH = "https://www.barcouncilofindia.org/advocate-search";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const CASE_TYPES = {
  A482: { name: "APPLICATION U/s 482", id: "17" },
  BAIL: { name: "CRIMINAL MISC. BAIL APPLICATION", id: "16" },
  CRLP: { name: "CRIMINAL MISC. WRIT PETITION", id: "30" },
  CRLA: { name: "CRIMINAL APPEAL", id: "13" },
  CRLR: { name: "CRIMINAL REVISION", id: "14" },
  WRIA: { name: "WRIT - A", id: "20" },
  WRIB: { name: "WRIT - B", id: "21" },
  WRIC: { name: "WRIT - C", id: "22" },
  WPIL: { name: "WRIT - PUBLIC INTEREST LITIGATION", id: "92" },
  FAPL: { name: "FIRST APPEAL", id: "1" },
  SAPL: { name: "SECOND APPEAL", id: "2" },
  FAFO: { name: "FIRST APPEAL FROM ORDER", id: "3" },
  SPLA: { name: "SPECIAL APPEAL", id: "4" },
  CLRE: { name: "CIVIL REVISION", id: "6" },
  STRE: { name: "SALES/TRADE TAX REVISION", id: "8" },
  TACL: { name: "TRANSFER APPLICATION (CIVIL)", id: "9" },
  TACR: { name: "TRANSFER APPLICATION (CRIMINAL)", id: "19" },
  ABAIL: { name: "CRIMINAL MISC ANTICIPATORY BAIL APPLICATION U/S 438", id: "127" },
  BAILC: { name: "CRIMINAL MISC. BAIL CANCELLATION APPL.", id: "107" },
  A378: { name: "CRL. MISC. APPLICATION U/S 378", id: "15" },
  C372: { name: "CRIMINAL APPEAL U/S 372 Cr.PC.", id: "100" },
  CAPL: { name: "CONTEMPT APPLICATION (CIVIL)", id: "18" },
  CRCL: { name: "CONTEMPT APPLICATION (CRIMINAL)", id: "28" },
  HABC: { name: "HABEAS CORPUS WRIT PETITION", id: "88" },
  IAPL: { name: "INCOME TAX APPEAL", id: "70" },
  GSTAL: { name: "GOODS AND SERVICE TAX APPEAL", id: "128" },
  COMP: { name: "COMPANY APPLICATION", id: "11" },
  WTAX: { name: "WRIT TAX", id: "47" },
  CRPIL: { name: "CRIMINAL WRIT-PUBLIC INTEREST LITIGATION", id: "105" },
  GOVA: { name: "GOVERNMENT APPEAL", id: "81" },
};

// ─────────────────────────────────────────────────────────────────────
// HTTP HELPERS
// ─────────────────────────────────────────────────────────────────────

async function fetchPage(url, options = {}) {
  const headers = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
    ...options.headers,
  };
  if (options.sessionToken) headers.Cookie = options.sessionToken;
  try {
    const resp = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body,
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    const setCookies = resp.headers.getSetCookie?.() || [];
    const html = await resp.text();
    return { html, status: resp.status, cookies: setCookies, url: resp.url };
  } catch (err) {
    return { html: "", status: 0, cookies: [], url, error: err.message };
  }
}

async function fetchPostForm(url, formData, sessionToken) {
  const body = new URLSearchParams(formData).toString();
  return fetchPage(url, {
    method: "POST",
    body,
    sessionToken,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

function parseTable($, tableEl) {
  const rows = [];
  $(tableEl).find("tr").each((i, tr) => {
    const cells = [];
    $(tr).find("td, th").each((j, td) => cells.push($(td).text().trim()));
    if (cells.length > 0) rows.push(cells);
  });
  return rows;
}

// ─────────────────────────────────────────────────────────────────────
// CAPTCHA SOLVER (lazy-loaded)
// ─────────────────────────────────────────────────────────────────────

let solveCourtCaptcha = null;

async function loadCaptchaSolver() {
  if (solveCourtCaptcha) return solveCourtCaptcha;
  try {
    const mod = await import("../allahabad-hc-mcp/captcha-solver.js");
    solveCourtCaptcha = mod.solveCourtCaptcha;
    console.log("[API] CAPTCHA solver loaded successfully");
    return solveCourtCaptcha;
  } catch (err) {
    console.warn("[API] CAPTCHA solver not available:", err.message);
    return null;
  }
}

async function solveCaptchaForUrl(url, base) {
  const solver = await loadCaptchaSolver();
  if (!solver) throw new Error("CAPTCHA solver not available");
  return solver(url, base, { maxAttempts: 3 });
}

// ─────────────────────────────────────────────────────────────────────
// RESPONSE CACHE (TTL-based, avoids hammering court servers)
// ─────────────────────────────────────────────────────────────────────

const cache = new Map();
const CACHE_TTL = {
  advocate_cases: 5 * 60 * 1000,   // 5 min
  case_status: 5 * 60 * 1000,      // 5 min
  case_history: 10 * 60 * 1000,    // 10 min
  causelist: 30 * 60 * 1000,       // 30 min
  court_view: 30 * 1000,           // 30 sec (live data)
  calendar: 24 * 60 * 60 * 1000,   // 24 hr
};

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data, ttl) {
  cache.set(key, { data, ts: Date.now(), ttl });
  // Cleanup old entries periodically
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts > v.ttl) cache.delete(k);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// BAR COUNCIL VALIDATION
// ─────────────────────────────────────────────────────────────────────

/**
 * Validates Bar Council enrollment number format and attempts
 * to verify against BCI website + eCourts advocate search.
 *
 * Format: STATE/NUMBER/YEAR (e.g., UP/1234/2015)
 */
function validateBarCouncilFormat(enrollmentNo) {
  if (!enrollmentNo) return { valid: false, error: "Enrollment number is required" };

  const cleaned = enrollmentNo.trim().toUpperCase();

  // Standard format: STATE/NUMBER/YEAR
  const pattern = /^([A-Z]{2,3})\/(\d{1,6})\/(\d{4})$/;
  const match = cleaned.match(pattern);

  if (!match) {
    // Also accept formats like UP-1234-2015 or UP 1234 2015
    const altPattern = /^([A-Z]{2,3})[\s\-_](\d{1,6})[\s\-_](\d{4})$/;
    const altMatch = cleaned.match(altPattern);
    if (!altMatch) {
      return { valid: false, error: "Invalid format. Expected: STATE/NUMBER/YEAR (e.g., UP/1234/2015)" };
    }
    return { valid: true, state: altMatch[1], number: altMatch[2], year: parseInt(altMatch[3]), normalized: `${altMatch[1]}/${altMatch[2]}/${altMatch[3]}` };
  }

  const year = parseInt(match[3]);
  if (year < 1960 || year > new Date().getFullYear()) {
    return { valid: false, error: `Enrollment year ${year} seems invalid` };
  }

  const validStates = ["AP","AR","AS","BR","CG","CH","DD","DL","GA","GJ","HP","HR","JH","JK","KA","KL","LA","MH","ML","MN","MP","MZ","NL","OD","PB","PY","RJ","SK","TN","TS","TR","UK","UP","WB"];
  if (!validStates.includes(match[1])) {
    return { valid: false, error: `Unknown state code: ${match[1]}` };
  }

  return { valid: true, state: match[1], number: match[2], year, normalized: `${match[1]}/${match[2]}/${match[3]}` };
}

/**
 * Attempt to verify the advocate exists on eCourts by searching
 * advocate name on eCourts services portal (no CAPTCHA needed).
 */
async function verifyOnECourts(advocateName, stateCode) {
  try {
    // eCourts has a public advocate search endpoint
    const url = `${ECOURTS_BASE}/showCaseFromAdvocate.do`;
    const result = await fetchPostForm(url, {
      advocate_name: advocateName,
      state_code: stateCode === "UP" ? "26" : "1", // UP state code on eCourts
      dist_code: "1",
      court_complex_code: "1",
      search: "Search",
    });

    const $ = cheerio.load(result.html);
    // If we get results, the advocate likely exists
    const rows = $("table tr").length;
    return { found: rows > 1, source: "eCourts" };
  } catch (err) {
    return { found: false, source: "eCourts", error: err.message };
  }
}


// ─────────────────────────────────────────────────────────────────────
// ADVOCATE CASES
// ─────────────────────────────────────────────────────────────────────

async function fetchAdvocateCases(rollNumber, bench = "allahabad") {
  const cacheKey = `adv_${rollNumber}_${bench}`;
  const cached = getCached(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const base = bench === "lucknow" ? CCMS_LKO : CCMS_ALD;
  const url = `${base}/advocate-cases-roll-wise`;

  // Solve CAPTCHA
  let sessionToken, captchaAnswer;
  try {
    const solved = await solveCaptchaForUrl(url, base);
    sessionToken = solved.sessionToken;
    captchaAnswer = solved.captchaAnswer;
    console.log(`[API] CAPTCHA solved for advocate lookup: "${captchaAnswer}" (confidence: ${solved.confidence.toFixed(1)}%)`);
  } catch (err) {
    console.error(`[API] CAPTCHA solve failed: ${err.message}`);
    return { status: "captcha_failed", error: "Could not solve court CAPTCHA. Please try again.", roll_number: rollNumber };
  }

  const result = await fetchPostForm(url, {
    roll_no: rollNumber,
    captcha: captchaAnswer,
    submit: "Search",
  }, sessionToken);

  const $ = cheerio.load(result.html);

  // Check for CAPTCHA rejection
  const errorText = $(".alert-danger, .error, .text-danger").text().trim();
  if (errorText.toLowerCase().includes("captcha") || errorText.toLowerCase().includes("invalid")) {
    // Retry once
    try {
      const retry = await solveCaptchaForUrl(url, base);
      const retryResult = await fetchPostForm(url, { roll_no: rollNumber, captcha: retry.captchaAnswer, submit: "Search" }, retry.sessionToken);
      const $r = cheerio.load(retryResult.html);
      const retryErr = $r(".alert-danger, .error, .text-danger").text().trim();
      if (!retryErr.toLowerCase().includes("captcha")) {
        const data = parseAdvocateCases($r, rollNumber, bench);
        setCache(cacheKey, data, CACHE_TTL.advocate_cases);
        return data;
      }
    } catch (_) {}
    return { status: "captcha_failed", error: "CAPTCHA verification failed after retry. Please try again." };
  }

  const data = parseAdvocateCases($, rollNumber, bench);
  setCache(cacheKey, data, CACHE_TTL.advocate_cases);
  return data;
}

function parseAdvocateCases($, rollNumber, bench) {
  const cases = [];
  $("table tr").each((i, tr) => {
    if (i === 0) return;
    const cells = [];
    $(tr).find("td").each((j, td) => cells.push($(td).text().trim()));
    if (cells.length >= 3) {
      // Parse case reference to extract type/number/year
      const caseRef = cells[1] || "";
      const refMatch = caseRef.match(/([A-Z]+)\s*[-\/]?\s*(\d+)\s*[-\/]\s*(\d{4})/i);

      cases.push({
        serial: cells[0],
        caseRef: cells[1],
        caseType: refMatch ? refMatch[1].toUpperCase() : "",
        caseNo: refMatch ? refMatch[2] : "",
        year: refMatch ? refMatch[3] : "",
        parties: cells[2],
        title: cells[2], // alias
        nextHearing: cells[3] || null,
        status: cells[4] || "PENDING",
        coram: cells[5] || null,
      });
    }
  });

  return {
    status: cases.length > 0 ? "success" : "no_cases_found",
    rollNumber,
    bench: bench === "lucknow" ? "Lucknow Bench" : "Allahabad",
    totalCases: cases.length,
    cases,
    fetchedAt: new Date().toISOString(),
  };
}


// ─────────────────────────────────────────────────────────────────────
// CASE STATUS
// ─────────────────────────────────────────────────────────────────────

async function fetchCaseStatus(caseType, caseNumber, caseYear, bench = "allahabad") {
  const cacheKey = `case_${caseType}_${caseNumber}_${caseYear}_${bench}`;
  const cached = getCached(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const typeInfo = CASE_TYPES[caseType.toUpperCase()];
  if (!typeInfo) return { status: "error", error: `Unknown case type: ${caseType}` };

  const base = bench === "lucknow" ? CCMS_LKO : CCMS_ALD;
  const url = `${base}/case-status`;

  let sessionToken, captchaAnswer;
  try {
    const solved = await solveCaptchaForUrl(url, base);
    sessionToken = solved.sessionToken;
    captchaAnswer = solved.captchaAnswer;
  } catch (err) {
    return { status: "captcha_failed", error: "Could not solve CAPTCHA" };
  }

  const result = await fetchPostForm(url, {
    case_type_id: typeInfo.id,
    case_no: caseNumber,
    case_year: caseYear,
    captcha: captchaAnswer,
    submit: "Search",
  }, sessionToken);

  const $ = cheerio.load(result.html);
  const errorText = $(".alert-danger, .error, .text-danger").text().trim();
  if (errorText.toLowerCase().includes("captcha")) {
    return { status: "captcha_failed", error: "CAPTCHA rejected" };
  }

  // Parse case details
  const caseData = { caseRef: `${caseType.toUpperCase()}/${caseNumber}/${caseYear}` };
  $("table tr, .case-detail tr, .detail-row").each((i, el) => {
    const cells = [];
    $(el).find("td, th").each((j, td) => cells.push($(td).text().trim()));
    if (cells.length >= 2) {
      const key = cells[0].toLowerCase().replace(/[:\s]+/g, "_");
      const val = cells[1];
      if (key.includes("party") || key.includes("petitioner")) caseData.petitioner = val;
      else if (key.includes("respondent") || key.includes("opposite")) caseData.respondent = val;
      else if (key.includes("status")) caseData.status = val;
      else if (key.includes("stage")) caseData.stage = val;
      else if (key.includes("next") && key.includes("date")) caseData.nextHearing = val;
      else if (key.includes("last") && key.includes("date")) caseData.lastHearing = val;
      else if (key.includes("filing") && key.includes("date")) caseData.filingDate = val;
      else if (key.includes("coram") || key.includes("bench") || key.includes("judge")) caseData.coram = val;
      else if (key.includes("advocate") || key.includes("counsel")) caseData.advocate = val;
      else if (key.includes("district")) caseData.district = val;
      else if (key.includes("police") || key.includes("fir")) caseData.firDetails = val;
    }
  });

  caseData.status = caseData.status || "PENDING";
  caseData.fetchedAt = new Date().toISOString();
  const data = { status: "success", ...caseData };
  setCache(cacheKey, data, CACHE_TTL.case_status);
  return data;
}


// ─────────────────────────────────────────────────────────────────────
// CASE HISTORY
// ─────────────────────────────────────────────────────────────────────

async function fetchCaseHistory(caseType, caseNumber, caseYear, bench = "allahabad") {
  const cacheKey = `hist_${caseType}_${caseNumber}_${caseYear}_${bench}`;
  const cached = getCached(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const typeInfo = CASE_TYPES[caseType.toUpperCase()];
  if (!typeInfo) return { status: "error", error: `Unknown case type: ${caseType}` };

  const base = bench === "lucknow" ? CCMS_LKO : CCMS_ALD;
  const url = `${base}/listing-history`;

  let sessionToken, captchaAnswer;
  try {
    const solved = await solveCaptchaForUrl(url, base);
    sessionToken = solved.sessionToken;
    captchaAnswer = solved.captchaAnswer;
  } catch (err) {
    return { status: "captcha_failed", error: "Could not solve CAPTCHA" };
  }

  const result = await fetchPostForm(url, {
    case_type_id: typeInfo.id,
    case_no: caseNumber,
    case_year: caseYear,
    captcha: captchaAnswer,
    submit: "Search",
  }, sessionToken);

  const $ = cheerio.load(result.html);
  const history = [];
  const iAs = [];

  $("table").each((i, table) => {
    const rows = parseTable($, table);
    const header = rows[0]?.map(h => h.toLowerCase()) || [];

    if (header.some(h => h.includes("listing") || h.includes("hearing") || h.includes("date"))) {
      rows.slice(1).forEach(row => {
        history.push({ date: row[0], court: row[1], coram: row[2], purpose: row[3], order: row[4] });
      });
    } else if (header.some(h => h.includes("ia") || h.includes("interlocutory") || h.includes("application"))) {
      rows.slice(1).forEach(row => {
        iAs.push({ iaNumber: row[0], type: row[1], filedOn: row[2], status: row[3] });
      });
    }
  });

  const data = {
    status: "success",
    caseRef: `${caseType.toUpperCase()} No. ${caseNumber} of ${caseYear}`,
    bench: bench === "lucknow" ? "Lucknow" : "Allahabad",
    listingHistory: history,
    interlocutoryApplications: iAs,
    totalHearings: history.length,
    fetchedAt: new Date().toISOString(),
  };
  setCache(cacheKey, data, CACHE_TTL.case_history);
  return data;
}


// ─────────────────────────────────────────────────────────────────────
// CAUSE LIST (for live ETA)
// ─────────────────────────────────────────────────────────────────────

async function fetchCauselistToday(bench = "allahabad") {
  const cacheKey = `cl_${bench}`;
  const cached = getCached(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const url = bench === "lucknow"
    ? `${BASE_URL}/causelist/causelist_lko.htm`
    : `${BASE_URL}/causelist/causelist_ald.htm`;

  const page = await fetchPage(url);
  const $ = cheerio.load(page.html);

  const causelists = [];
  $("a").each((i, a) => {
    const href = $(a).attr("href");
    const text = $(a).text().trim();
    if (href && text && (href.includes(".pdf") || href.includes("causelist"))) {
      causelists.push({
        title: text,
        url: href.startsWith("http") ? href : `${BASE_URL}/causelist/${href}`,
        date: new Date().toISOString().split("T")[0],
      });
    }
  });

  const data = {
    status: "success",
    bench: bench === "lucknow" ? "Lucknow" : "Allahabad",
    date: new Date().toISOString().split("T")[0],
    causelists,
    totalLists: causelists.length,
    fetchedAt: new Date().toISOString(),
  };
  setCache(cacheKey, data, CACHE_TTL.causelist);
  return data;
}


// ─────────────────────────────────────────────────────────────────────
// COURT VIEW (live display board — for real-time ETA)
// ─────────────────────────────────────────────────────────────────────

async function fetchCourtView(bench = "allahabad") {
  const cacheKey = `cv_${bench}`;
  const cached = getCached(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const url = bench === "lucknow" ? COURT_VIEW_LKO : COURT_VIEW_ALD;
  const page = await fetchPage(url);
  const $ = cheerio.load(page.html);

  const courts = [];
  $("table tr").each((i, tr) => {
    if (i === 0) return;
    const cells = [];
    $(tr).find("td").each((j, td) => cells.push($(td).text().trim()));
    if (cells.length >= 3) {
      courts.push({
        courtNo: cells[0],
        coram: cells[1],
        currentItem: cells[2],
        caseBeingHeard: cells[3] || null,
        causelistType: cells[4] || null,
      });
    }
  });

  const data = {
    status: "success",
    bench: bench === "lucknow" ? "Lucknow" : "Allahabad",
    courts,
    totalCourts: courts.length,
    fetchedAt: new Date().toISOString(),
  };
  setCache(cacheKey, data, CACHE_TTL.court_view);
  return data;
}


// ─────────────────────────────────────────────────────────────────────
// COURT CALENDAR
// ─────────────────────────────────────────────────────────────────────

const HOLIDAYS_2026 = [
  { date: "2026-01-26", name: "Republic Day" },
  { date: "2026-03-10", name: "Maha Shivaratri" },
  { date: "2026-03-17", name: "Holi" },
  { date: "2026-03-31", name: "Id-ul-Fitr" },
  { date: "2026-04-02", name: "Ram Navami" },
  { date: "2026-04-06", name: "Mahavir Jayanti" },
  { date: "2026-04-14", name: "Dr. Ambedkar Jayanti" },
  { date: "2026-04-18", name: "Good Friday" },
  { date: "2026-05-01", name: "May Day" },
  { date: "2026-05-24", name: "Buddha Purnima" },
  { date: "2026-06-07", name: "Id-ul-Zuha" },
  { date: "2026-07-06", name: "Muharram" },
  { date: "2026-08-15", name: "Independence Day" },
  { date: "2026-08-16", name: "Janmashtami" },
  { date: "2026-09-05", name: "Milad-un-Nabi" },
  { date: "2026-10-02", name: "Mahatma Gandhi Jayanti" },
  { date: "2026-10-20", name: "Dussehra" },
  { date: "2026-11-08", name: "Diwali" },
  { date: "2026-11-12", name: "Guru Nanak Jayanti" },
  { date: "2026-12-25", name: "Christmas Day" },
];

const VACATIONS_2026 = [
  { start: "2026-05-25", end: "2026-07-05", name: "Summer Vacation" },
  { start: "2026-10-05", end: "2026-10-19", name: "Dussehra Vacation" },
  { start: "2026-12-26", end: "2027-01-04", name: "Winter Vacation" },
];


// ─────────────────────────────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Health check ──
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "LegalDesk API", version: "1.0.0", uptime: process.uptime() });
});

// ── Validate advocate enrollment ──
app.post("/api/validate-advocate", async (req, res) => {
  try {
    const { enrollmentNo, name } = req.body;

    // Step 1: Format validation
    const formatResult = validateBarCouncilFormat(enrollmentNo);
    if (!formatResult.valid) {
      return res.json({ status: "invalid", error: formatResult.error });
    }

    // Step 2: Try to verify on eCourts (non-blocking, best-effort)
    let ecourtResult = null;
    if (name) {
      ecourtResult = await verifyOnECourts(name, formatResult.state).catch(() => null);
    }

    // Step 3: Check if they have cases on Allahabad HC CCMS
    // This doubles as validation — if the roll number returns cases, the advocate is real
    let casesResult = null;
    try {
      casesResult = await fetchAdvocateCases(formatResult.normalized, "allahabad");
    } catch (err) {
      console.warn("[API] Advocate case check failed:", err.message);
    }

    const hasCases = casesResult?.status === "success" && casesResult.totalCases > 0;

    res.json({
      status: "validated",
      format: formatResult,
      ecourtVerification: ecourtResult,
      hasCasesOnHC: hasCases,
      totalCases: casesResult?.totalCases || 0,
      // Confidence level
      confidence: hasCases ? "high" : (ecourtResult?.found ? "medium" : "format_only"),
      message: hasCases
        ? `Verified: ${casesResult.totalCases} case(s) found on Allahabad HC for this enrollment`
        : "Enrollment number format is valid. Cases will appear when fetched from court portal.",
    });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ── Get advocate's cases ──
app.get("/api/advocate-cases/:rollNumber", async (req, res) => {
  try {
    const { rollNumber } = req.params;
    const bench = req.query.bench || "allahabad";
    const result = await fetchAdvocateCases(rollNumber, bench);
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// Also fetch from both benches combined
app.get("/api/advocate-cases-all/:rollNumber", async (req, res) => {
  try {
    const { rollNumber } = req.params;
    const [ald, lko] = await Promise.allSettled([
      fetchAdvocateCases(rollNumber, "allahabad"),
      fetchAdvocateCases(rollNumber, "lucknow"),
    ]);

    const aldCases = ald.status === "fulfilled" && ald.value.status === "success" ? ald.value.cases : [];
    const lkoCases = lko.status === "fulfilled" && lko.value.status === "success" ? lko.value.cases : [];

    // Tag cases with their bench
    aldCases.forEach(c => { c.bench = "Allahabad"; c.court = "Allahabad High Court"; });
    lkoCases.forEach(c => { c.bench = "Lucknow"; c.court = "Allahabad High Court (Lucknow Bench)"; });

    const allCases = [...aldCases, ...lkoCases];

    res.json({
      status: allCases.length > 0 ? "success" : "no_cases_found",
      rollNumber,
      totalCases: allCases.length,
      allahabadCases: aldCases.length,
      lucknowCases: lkoCases.length,
      cases: allCases,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ── Case status ──
app.get("/api/case-status", async (req, res) => {
  try {
    const { type, number, year, bench } = req.query;
    if (!type || !number || !year) {
      return res.status(400).json({ status: "error", error: "Required: type, number, year" });
    }
    const result = await fetchCaseStatus(type, number, year, bench || "allahabad");
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ── Case history ──
app.get("/api/case-history", async (req, res) => {
  try {
    const { type, number, year, bench } = req.query;
    if (!type || !number || !year) {
      return res.status(400).json({ status: "error", error: "Required: type, number, year" });
    }
    const result = await fetchCaseHistory(type, number, year, bench || "allahabad");
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ── Today's cause list ──
app.get("/api/causelist-today", async (req, res) => {
  try {
    const bench = req.query.bench || "allahabad";
    const result = await fetchCauselistToday(bench);
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ── Live court view (for real-time ETA) ──
app.get("/api/court-view", async (req, res) => {
  try {
    const bench = req.query.bench || "allahabad";
    const result = await fetchCourtView(bench);
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ── Court calendar ──
app.get("/api/court-calendar", (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const isHoliday = HOLIDAYS_2026.find(h => h.date === today);
  const isVacation = VACATIONS_2026.find(v => today >= v.start && today <= v.end);
  const dayOfWeek = new Date().getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  res.json({
    status: "success",
    today,
    isWorkingDay: !isHoliday && !isVacation && !isWeekend,
    isHoliday: isHoliday || null,
    isVacation: isVacation || null,
    isWeekend,
    holidays: HOLIDAYS_2026,
    vacations: VACATIONS_2026,
  });
});

// ── Available case types ──
app.get("/api/case-types", (req, res) => {
  res.json({
    status: "success",
    caseTypes: Object.entries(CASE_TYPES).map(([code, info]) => ({ code, name: info.name })),
  });
});

// ── Start server ──
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  LegalDesk API Server v1.0.0                                 ║
║  Running on http://localhost:${PORT}                            ║
║                                                               ║
║  Endpoints:                                                   ║
║    POST /api/validate-advocate     — Validate Bar Council     ║
║    GET  /api/advocate-cases/:roll  — Advocate's cases         ║
║    GET  /api/advocate-cases-all/:r — Both benches combined    ║
║    GET  /api/case-status           — Case status lookup       ║
║    GET  /api/case-history          — Listing history & IAs    ║
║    GET  /api/causelist-today       — Today's cause list       ║
║    GET  /api/court-view            — Live court display       ║
║    GET  /api/court-calendar        — Holidays & vacations     ║
║    GET  /api/case-types            — Available case types     ║
║    GET  /health                    — Health check             ║
╚═══════════════════════════════════════════════════════════════╝
  `);

  // Pre-load CAPTCHA solver
  loadCaptchaSolver();
});
