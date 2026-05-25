#!/usr/bin/env node

// Force Indian Standard Time for all date operations on the server
process.env.TZ = "Asia/Kolkata";

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
// CCMS bases.
// IMPORTANT: ALD CCMS uses /index.php/<route> for GETs but POSTs go to /<route> (form action strips index.php).
// LKO has migrated to its own subdomain (hclko.allahabadhighcourt.in) — /apps/status_ccms_lko is dead (404).
const CCMS_ALD = `${BASE_URL}/apps/status_ccms`;          // POST base
const CCMS_ALD_GET = `${BASE_URL}/apps/status_ccms/index.php`;  // GET base
const CCMS_LKO = "https://hclko.allahabadhighcourt.in/status";        // POST base
const CCMS_LKO_GET = "https://hclko.allahabadhighcourt.in/status/index.php"; // GET base
const ELEGALIX = "https://elegalix.allahabadhighcourt.in/elegalix";
const COURT_VIEW_ALD = "https://courtview2.allahabadhighcourt.in/courtview/CourtViewAllahabad.do";
const COURT_VIEW_LKO = "https://courtview2.allahabadhighcourt.in/courtview/CourtViewLucknow.do";
// Live cause list (CCMS — replaces the dead /causelist/causelist_*.htm URLs that returned 404)
const CAUSELIST_CCMS_ALD = `${BASE_URL}/apps/status_ccms/index.php/causelist`;
const CAUSELIST_CCMS_LKO = "https://hclko.allahabadhighcourt.in/status/index.php/cause-list";
// Legacy PDF index (fallback only — still alive at 200, but mostly stale 2021 samples)
const CAUSELIST_PDF_INDEX_ALD = `${BASE_URL}/causelist/indexA.html`;
const CAUSELIST_PDF_INDEX_LKO = "https://hclko.allahabadhighcourt.in/causelist/indexL.html";
// RSS feeds for Legal Updates
const RSS_HEADLINES = `${BASE_URL}/calendar/rssHeadlines.jsp`;
const RSS_JUDGMENTS = `${ELEGALIX}/rssfeed.do`;
const ECOURTS_BASE = "https://services.ecourts.gov.in/ecourtindia_v6";
const BCI_SEARCH = "https://www.barcouncilofindia.org/advocate-search";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ── Indian Standard Time helpers (UTC+5:30) ──
function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}
function istDateStr() {
  // Returns YYYY-MM-DD in IST
  const d = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  const [m, day, y] = d.split("/");
  return `${y}-${m}-${day}`;
}
function istTimestamp() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
}

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
    const setCookieRaw = resp.headers.getSetCookie?.() || [];
    // Normalize for re-use as a Cookie request header: strip attributes from each value.
    const setCookies = setCookieRaw
      .map(c => c.split(";")[0].trim())
      .filter(Boolean);
    const html = await resp.text();
    return { html, status: resp.status, cookies: setCookies, cookiesRaw: setCookieRaw, url: resp.url };
  } catch (err) {
    return { html: "", status: 0, cookies: [], url, error: err.message };
  }
}

async function fetchPostForm(url, formData, sessionToken, extraHeaders = {}) {
  const body = new URLSearchParams(formData).toString();
  return fetchPage(url, {
    method: "POST",
    body,
    sessionToken,
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...extraHeaders },
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
  // 6 attempts because the CCMS captcha is genuinely hard (color extraction works ~70-80%
  // of the time, so 6 attempts gives >99% success even with no retry layer above).
  return solver(url, base, { maxAttempts: 6 });
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
  news: 60 * 60 * 1000,            // 60 min (RSS feeds)
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
  if (year < 1960 || year > istNow().getFullYear()) {
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

// Build the list of roll-number format variants to try against the court form.
// The CCMS form expects the "Advocate Roll Number" format (e.g. "B/A2401/2019") —
// NOT the Bar Council enrollment number (e.g. "UP/2030/2018"). We accept either input
// and try a few common normalizations.
function rollNumberVariants(rollNumber) {
  const cleaned = (rollNumber || "").trim().toUpperCase();
  if (!cleaned) return [];
  const variants = new Set([cleaned]);
  // "B/A2401/2019" → "A2401/2019" (strip single-letter type prefix)
  if (/^[A-Z]\//.test(cleaned)) variants.add(cleaned.substring(2));
  // "A2401/2019" → "B/A2401/2019" (add common type prefix)
  if (/^[A-Z]?\d+\/\d{4}$/.test(cleaned) && !/^[A-Z]\//.test(cleaned)) {
    ["B", "A", "L"].forEach(p => variants.add(`${p}/${cleaned}`));
  }
  // "UP/2030/2018" Bar Council format — try as-is and also strip state prefix
  const upMatch = cleaned.match(/^([A-Z]{2,3})\/(\d+)\/(\d{4})$/);
  if (upMatch) {
    variants.add(`${upMatch[2]}/${upMatch[3]}`);
    ["B", "A", "L"].forEach(p => variants.add(`${p}/${upMatch[2]}/${upMatch[3]}`));
  }
  return [...variants];
}

// Parse a CCMS results page into structured cases.
// The result table column order (observed): Sr. | Case Number | Petitioner | Respondent | Listing | Status
function parseAdvocateCases($, rollNumber, bench) {
  const cases = [];
  // The result lives in a <table> with class "table" (Bootstrap-styled). Use the largest table on the page.
  let bestTable = null;
  let bestRows = 0;
  $("table").each((_, t) => {
    const rowCount = $(t).find("tr").length;
    if (rowCount > bestRows) { bestRows = rowCount; bestTable = t; }
  });
  if (!bestTable) return { status: "no_cases_found", rollNumber, bench, totalCases: 0, cases: [], fetchedAt: istTimestamp() };

  // Read header to map columns by name (column order varies between roll-wise and date-wise pages)
  const headerCells = [];
  $(bestTable).find("tr").first().find("th, td").each((_, c) => headerCells.push($(c).text().trim().toLowerCase()));
  const col = (re) => headerCells.findIndex(h => re.test(h));
  const idx = {
    serial: col(/^(sr|s\.? *no|serial)/),
    caseRef: col(/case|cnr/),
    petitioner: col(/petition|applicant|appellant/),
    respondent: col(/respond|opposite/),
    parties: col(/parties|title|vs/),
    nextHearing: col(/next|listing|hearing/),
    status: col(/status|stage/),
    coram: col(/coram|judge|bench/),
  };

  $(bestTable).find("tr").each((i, tr) => {
    if (i === 0 && headerCells.length) return; // skip header
    const cells = [];
    $(tr).find("td").each((_, td) => cells.push($(td).text().trim().replace(/\s+/g, " ")));
    if (cells.length < 2) return;

    const caseRef = idx.caseRef >= 0 ? cells[idx.caseRef] : (cells[1] || "");
    if (!caseRef || caseRef.length < 3) return;
    const refMatch = caseRef.match(/([A-Z]+)\s*[-\/]?\s*(\d+)\s*[-\/]\s*(\d{4})/i);

    const petitioner = idx.petitioner >= 0 ? cells[idx.petitioner] : "";
    const respondent = idx.respondent >= 0 ? cells[idx.respondent] : "";
    const parties = idx.parties >= 0
      ? cells[idx.parties]
      : (petitioner && respondent ? `${petitioner} Vs ${respondent}` : (petitioner || respondent || cells[2] || ""));

    cases.push({
      serial: idx.serial >= 0 ? cells[idx.serial] : String(i),
      caseRef,
      caseType: refMatch ? refMatch[1].toUpperCase() : "",
      caseNo: refMatch ? refMatch[2] : "",
      year: refMatch ? refMatch[3] : "",
      petitioner,
      respondent,
      parties,
      title: parties,
      nextHearing: idx.nextHearing >= 0 ? (cells[idx.nextHearing] || null) : null,
      status: idx.status >= 0 ? (cells[idx.status] || "PENDING") : "PENDING",
      coram: idx.coram >= 0 ? (cells[idx.coram] || null) : null,
    });
  });

  return {
    status: cases.length > 0 ? "success" : "no_cases_found",
    rollNumber,
    bench: bench === "lucknow" ? "Lucknow Bench" : "Allahabad",
    totalCases: cases.length,
    cases,
    fetchedAt: istTimestamp(),
  };
}

// Detect failure modes after a POST to get_ListedCaseRoll (AJAX HTML fragment) or the full form page.
function detectAdvocateFormError($, htmlOpt) {
  const html = (htmlOpt || $.html() || "").toLowerCase();
  // Explicit captcha rejection
  if (/wrong\s*captcha|invalid\s*captcha|captcha\s*(is\s*)?(wrong|invalid|incorrect)/i.test(html)) return "captcha";
  // "Record Not Found" is the no-match signal from get_ListedCaseRoll
  if (/record\s*not\s*found|no\s*record(s)?\s*found|no\s*case(s)?\s*found/i.test(html)) return "no_match";
  // Generic danger text (could be either captcha or input validation)
  const errorText = $(".alert-danger, .alert-warning, .error, .text-danger, .help-block").text().trim().toLowerCase();
  if (!errorText) return null;
  if (errorText.includes("captcha") || errorText.includes("verification code")) return "captcha";
  if (errorText.includes("invalid") || errorText.includes("incorrect")) return "captcha";
  if (errorText.includes("no record") || errorText.includes("not found")) return "no_match";
  return "other";
}

// One POST attempt with one captcha solve. Returns { kind: "ok"|"captcha"|"no_match"|"error", data?, errMsg? }
async function attemptAdvocatePost({ getUrl, postUrl, fields, debug = false }) {
  let solved;
  try {
    solved = await solveCaptchaForUrl(getUrl, getUrl);
  } catch (err) {
    if (debug) console.log(`[advocatePost] captcha solve failed: ${err.message}`);
    return { kind: "error", errMsg: `captcha solve failed: ${err.message}` };
  }
  const formData = { ...fields, captchacode: solved.captchaAnswer, submit: "Go" };
  if (debug) console.log(`[advocatePost] POST ${postUrl} with`, formData);
  // The get_ListedCaseRoll endpoint expects an XHR request with the form-page Referer.
  const result = await fetchPostForm(postUrl, formData, solved.sessionToken, {
    "X-Requested-With": "XMLHttpRequest",
    "Referer": getUrl,
  });
  if (debug) console.log(`[advocatePost] response status=${result.status} bodyLen=${result.html?.length || 0}`);
  const $ = cheerio.load(result.html);
  const errKind = detectAdvocateFormError($, result.html);
  if (debug) {
    const bodyText = $("body").text().replace(/\s+/g, " ").slice(0, 400);
    const tableCount = $("table").length;
    const rowCount = $("table tr").length;
    console.log(`[advocatePost] errKind=${errKind} tables=${tableCount} rows=${rowCount} bodyPreview="${bodyText}"`);
  }
  if (errKind === "captcha") return { kind: "captcha", $, errMsg: "CAPTCHA rejected" };
  if (errKind === "no_match") return { kind: "no_match", $ };
  return { kind: "ok", $, rawHtml: debug ? result.html : undefined };
}

// Diagnostic dry-run — one POST, returns the raw response for inspection.
async function dryRunAdvocate(bench, rollNumber, year, listingDate) {
  const getUrl = bench === "lucknow"
    ? `${CCMS_LKO_GET}/advocate-cases-date-wise`
    : `${CCMS_ALD_GET}/advocate-cases-roll-wise`;
  // Real submit endpoint is an AJAX route under index.php (not the form's action attribute).
  const postUrl = bench === "lucknow"
    ? `${CCMS_LKO_GET}/get_ListedCaseDate`         // best guess for LKO equivalent
    : `${CCMS_ALD_GET}/get_ListedCaseRoll`;
  const today = istNow();
  const defaultDate = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
  const fields = bench === "lucknow"
    ? { adv_roll: rollNumber, date: listingDate || defaultDate, listing_date: listingDate || defaultDate }
    : { adv_roll: rollNumber, case_year: String(year || istNow().getFullYear()) };
  const out = await attemptAdvocatePost({ getUrl, postUrl, fields, debug: true });
  const parsed = out.$ ? parseAdvocateCases(out.$, rollNumber, bench) : null;
  return {
    bench,
    getUrl, postUrl, fields,
    kind: out.kind,
    errMsg: out.errMsg,
    htmlLength: out.rawHtml?.length,
    bodyPreview: out.$ ? out.$("body").text().replace(/\s+/g, " ").slice(0, 600) : null,
    parsedCount: parsed?.totalCases || 0,
    parsedSample: parsed?.cases?.slice(0, 2) || [],
  };
}

// Allahabad bench — advocate-cases-roll-wise.
// CRITICAL: The HTML form looks like it POSTs back to itself, but the visible page is
// just a shell. A click handler intercepts the submit and AJAX-POSTs to
// /apps/status_ccms/index.php/get_ListedCaseRoll which returns the actual results HTML
// (table rows or "Record Not Found").
// FORM REQUIRES: adv_roll, case_year, captchacode, submit=Go
// To get ALL cases for an advocate we must iterate years.
async function fetchAdvocateCasesAllahabad(rollNumber, opts = {}) {
  const getUrl = `${CCMS_ALD_GET}/advocate-cases-roll-wise`;
  const postUrl = `${CCMS_ALD_GET}/get_ListedCaseRoll`;
  const variants = rollNumberVariants(rollNumber);
  const currentYear = istNow().getFullYear();
  // Default: scan last 5 years. Caller can pass ?yearsBack=N or ?years=a,b,c to widen.
  const yearsBack = opts.yearsBack || 4;
  const years = opts.years || Array.from({ length: yearsBack + 1 }, (_, i) => currentYear - i);

  const allCases = [];
  const seen = new Set();
  let formatWorked = null;
  const benchErrors = [];

  for (const adv_roll of variants) {
    let formatHadAny = false;
    let consecutiveCaptchaFails = 0;
    for (const year of years) {
      let attempt = await attemptAdvocatePost({
        getUrl, postUrl, fields: { adv_roll, case_year: String(year) },
      });
      // One quick retry on captcha rejection (the solver already retries inside, this is belt+braces).
      if (attempt.kind === "captcha") {
        attempt = await attemptAdvocatePost({ getUrl, postUrl, fields: { adv_roll, case_year: String(year) } });
      }
      if (attempt.kind === "error") {
        benchErrors.push(`year ${year}: ${attempt.errMsg}`);
        consecutiveCaptchaFails++;
        if (consecutiveCaptchaFails >= 3) { console.warn(`[API] ALD: aborting ${adv_roll} after 3 consecutive captcha errors`); break; }
        continue;
      }
      if (attempt.kind === "captcha") {
        consecutiveCaptchaFails++;
        continue;
      }
      consecutiveCaptchaFails = 0;
      if (attempt.kind !== "ok") continue;
      const parsed = parseAdvocateCases(attempt.$, rollNumber, "allahabad");
      if (parsed.totalCases > 0) {
        formatHadAny = true;
        for (const c of parsed.cases) {
          const key = c.caseRef;
          if (key && !seen.has(key)) { seen.add(key); allCases.push(c); }
        }
        console.log(`[API] ALD: ${adv_roll} / year ${year} → ${parsed.totalCases} cases`);
      }
    }
    if (formatHadAny) { formatWorked = adv_roll; break; }
  }

  return {
    status: allCases.length > 0 ? "success" : "no_cases_found",
    rollNumber,
    rollFormatUsed: formatWorked,
    bench: "Allahabad",
    totalCases: allCases.length,
    cases: allCases,
    yearsScanned: years,
    fetchedAt: istTimestamp(),
  };
}

// Lucknow bench — advocate-cases-date-wise.
// FORM REQUIRES: adv_roll, listing_date (YYYY-MM-DD picked from a select), captchacode, submit=Go
// The endpoint returns cases LISTED ON A SPECIFIC DATE — not the advocate's entire case history.
// To approximate "all matters" we scan a window of upcoming + recent dates.
// NOTE: LKO captcha is JS-generated client-side; server doesn't strictly validate it (any string works after fetching the form to get a session cookie).
async function fetchAdvocateCasesLucknow(rollNumber, opts = {}) {
  const getUrl = `${CCMS_LKO_GET}/advocate-cases-date-wise`;
  const postUrl = `${CCMS_LKO_GET}/advocate-cases-date-wise`;
  const variants = rollNumberVariants(rollNumber);
  // Quick reachability check — LKO has been known to go into maintenance mode.
  // If the form page says "Website is currently down for maintenance" we short-circuit with a clear error.
  const probe = await fetchPage(getUrl);
  if (probe.html && /currently down for maintenance/i.test(probe.html)) {
    return {
      status: "upstream_maintenance",
      rollNumber,
      bench: "Lucknow Bench",
      totalCases: 0,
      cases: [],
      error: "Allahabad HC Lucknow Bench CCMS is currently in maintenance mode (per upstream banner). Try again later.",
      fetchedAt: istTimestamp(),
    };
  }

  // Build candidate listing dates: today + next N working days + last few days.
  const dates = [];
  const today = istNow();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const window = opts.daysWindow || 14;
  for (let i = -3; i <= window; i++) {
    const d = new Date(today); d.setDate(today.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6) continue; // skip Sun/Sat
    dates.push(fmt(d));
  }

  const allCases = [];
  const seen = new Set();
  let formatWorked = null;

  for (const adv_roll of variants) {
    let formatHadAny = false;
    for (const listing_date of dates) {
      // Any captchacode works for LKO; we still call attemptAdvocatePost so we get a fresh session cookie.
      let attempt = await attemptAdvocatePost({
        getUrl, postUrl,
        fields: { adv_roll, date: listing_date, listing_date }, // include both common field names
      });
      if (attempt.kind === "captcha") {
        attempt = await attemptAdvocatePost({ getUrl, postUrl, fields: { adv_roll, date: listing_date, listing_date } });
      }
      if (attempt.kind !== "ok") continue;
      const parsed = parseAdvocateCases(attempt.$, rollNumber, "lucknow");
      if (parsed.totalCases > 0) {
        formatHadAny = true;
        for (const c of parsed.cases) {
          const key = c.caseRef;
          if (key && !seen.has(key)) { seen.add(key); allCases.push(c); }
        }
        console.log(`[API] LKO: ${adv_roll} / ${listing_date} → ${parsed.totalCases} cases (cumulative: ${allCases.length})`);
      }
    }
    if (formatHadAny) { formatWorked = adv_roll; break; }
  }

  return {
    status: allCases.length > 0 ? "success" : "no_cases_found",
    rollNumber,
    rollFormatUsed: formatWorked,
    bench: "Lucknow Bench",
    totalCases: allCases.length,
    cases: allCases,
    datesScanned: dates,
    note: "Lucknow CCMS only exposes per-date listings — total may understate the advocate's full case history (which lives in the login-gated advmgmtsys).",
    fetchedAt: istTimestamp(),
  };
}

// Unified entry point. Caches per (rollNumber, bench).
async function fetchAdvocateCases(rollNumber, bench = "allahabad") {
  const cacheKey = `adv_${rollNumber}_${bench}`;
  const cached = getCached(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  console.log(`[API] Advocate lookup: ${rollNumber} @ ${bench}`);

  let data;
  try {
    data = bench === "lucknow"
      ? await fetchAdvocateCasesLucknow(rollNumber)
      : await fetchAdvocateCasesAllahabad(rollNumber);
  } catch (err) {
    console.error(`[API] Advocate lookup failed: ${err.message}`);
    return {
      status: "error",
      rollNumber,
      bench: bench === "lucknow" ? "Lucknow Bench" : "Allahabad",
      error: err.message,
      totalCases: 0,
      cases: [],
      fetchedAt: istTimestamp(),
    };
  }

  if (data.totalCases > 0) setCache(cacheKey, data, CACHE_TTL.advocate_cases);
  return data;
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
  caseData.fetchedAt = istTimestamp();
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
    fetchedAt: istTimestamp(),
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

  // PRIMARY: CCMS cause list (rich structured data).
  // Previous URLs (/causelist/causelist_*.htm) returned 404 — the court moved this content to the CCMS app.
  const ccmsUrl = bench === "lucknow" ? CAUSELIST_CCMS_LKO : CAUSELIST_CCMS_ALD;
  const pdfIndexUrl = bench === "lucknow" ? CAUSELIST_PDF_INDEX_LKO : CAUSELIST_PDF_INDEX_ALD;
  const pdfBase = bench === "lucknow"
    ? "https://hclko.allahabadhighcourt.in/causelist/"
    : `${BASE_URL}/causelist/`;

  const causelists = [];   // structured rows from CCMS
  const pdfs = [];         // consolidated/supplementary PDF links

  // ── Try CCMS first ──
  try {
    const page = await fetchPage(ccmsUrl);
    if (page.status === 200 && page.html) {
      const $ = cheerio.load(page.html);
      // CCMS renders an HTML table; column order varies slightly between ALD and LKO,
      // so detect columns by header name rather than position.
      $("table").each((_, table) => {
        const rows = parseTable($, table);
        if (rows.length < 2) return;
        const header = rows[0].map(h => h.toLowerCase());
        const idx = {
          court: header.findIndex(h => /court\s*no/.test(h)),
          serial: header.findIndex(h => /sr\.?\s*no|serial/.test(h)),
          caseRef: header.findIndex(h => /case|cnr/.test(h)),
          parties: header.findIndex(h => /part(y|ies)|title/.test(h)),
          listType: header.findIndex(h => /list|type/.test(h)),
          judge: header.findIndex(h => /coram|judge|bench/.test(h)),
        };
        rows.slice(1).forEach(row => {
          if (row.length < 2) return;
          const entry = {
            courtNo: idx.court >= 0 ? row[idx.court] : null,
            serial: idx.serial >= 0 ? row[idx.serial] : null,
            caseRef: idx.caseRef >= 0 ? row[idx.caseRef] : row[0],
            parties: idx.parties >= 0 ? row[idx.parties] : (row[2] || null),
            listType: idx.listType >= 0 ? row[idx.listType] : null,
            coram: idx.judge >= 0 ? row[idx.judge] : null,
          };
          if (entry.caseRef && entry.caseRef.length > 1) causelists.push(entry);
        });
      });

      // Pick up any PDF causelist links present on the CCMS page
      $("a").each((_, a) => {
        const href = $(a).attr("href");
        const text = $(a).text().trim();
        if (href && /\.pdf$/i.test(href)) {
          pdfs.push({
            title: text || href.split("/").pop(),
            url: href.startsWith("http") ? href : (href.startsWith("/") ? `${BASE_URL}${href}` : pdfBase + href),
          });
        }
      });
    }
  } catch (err) {
    console.warn(`[API] CCMS cause list fetch failed (${bench}):`, err.message);
  }

  // ── Fallback to legacy PDF index for consolidated / supplementary PDFs ──
  try {
    const idx = await fetchPage(pdfIndexUrl);
    if (idx.status === 200 && idx.html) {
      const $ = cheerio.load(idx.html);
      $("a").each((_, a) => {
        const href = $(a).attr("href");
        const text = $(a).text().trim();
        if (!href) return;
        const isPdf = /\.pdf$/i.test(href);
        const isCauselistLink = /causelist|cause-list/i.test(href);
        if ((isPdf || isCauselistLink) && text) {
          const fullUrl = href.startsWith("http") ? href : (href.startsWith("/") ? `${BASE_URL}${href}` : pdfBase + href);
          if (!pdfs.some(p => p.url === fullUrl)) {
            pdfs.push({ title: text, url: fullUrl });
          }
        }
      });
    }
  } catch (err) {
    console.warn(`[API] PDF index fallback failed (${bench}):`, err.message);
  }

  const data = {
    status: "success",
    bench: bench === "lucknow" ? "Lucknow" : "Allahabad",
    date: istDateStr(),
    source: "ccms+pdf-index",
    sourceUrls: { ccms: ccmsUrl, pdfIndex: pdfIndexUrl },
    causelists,
    pdfs,
    totalLists: causelists.length + pdfs.length,
    totalEntries: causelists.length,
    totalPdfs: pdfs.length,
    fetchedAt: istTimestamp(),
  };
  setCache(cacheKey, data, CACHE_TTL.causelist);
  return data;
}


// ─────────────────────────────────────────────────────────────────────
// LEGAL NEWS (Allahabad HC RSS feeds: headlines + judgments)
// ─────────────────────────────────────────────────────────────────────

function parseRssItems(xmlString, source) {
  const $ = cheerio.load(xmlString, { xmlMode: true });
  const items = [];
  $("item").each((_, el) => {
    const $el = $(el);
    const description = $el.find("description").text().trim();
    // Strip basic HTML from RSS descriptions for clean rendering
    const cleanDesc = description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
    const link = $el.find("link").text().trim() || $el.find("guid").text().trim();
    const pubDateRaw = $el.find("pubDate").text().trim() || $el.find("dc\\:date, date").text().trim();
    let pubDate = null;
    if (pubDateRaw) {
      const d = new Date(pubDateRaw);
      if (!isNaN(d.getTime())) pubDate = d.toISOString();
    }
    items.push({
      id: `${source}_${Buffer.from(link || $el.find("title").text()).toString("base64").slice(0, 16)}`,
      title: $el.find("title").text().trim(),
      link,
      description: cleanDesc,
      source,           // "headlines" or "judgments"
      pubDate,
      pubDateRaw,
    });
  });
  return items;
}

async function fetchLegalNews() {
  const cacheKey = "news_all";
  const cached = getCached(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const [headlinesRes, judgmentsRes] = await Promise.allSettled([
    fetchPage(RSS_HEADLINES),
    fetchPage(RSS_JUDGMENTS),
  ]);

  let headlines = [];
  let judgments = [];

  if (headlinesRes.status === "fulfilled" && headlinesRes.value.status === 200) {
    try { headlines = parseRssItems(headlinesRes.value.html, "headlines"); }
    catch (err) { console.warn("[API] Headlines RSS parse failed:", err.message); }
  }
  if (judgmentsRes.status === "fulfilled" && judgmentsRes.value.status === 200) {
    try { judgments = parseRssItems(judgmentsRes.value.html, "judgments"); }
    catch (err) { console.warn("[API] Judgments RSS parse failed:", err.message); }
  }

  // Merge + sort newest first
  const all = [...headlines, ...judgments].sort((a, b) => {
    const da = a.pubDate ? Date.parse(a.pubDate) : 0;
    const db = b.pubDate ? Date.parse(b.pubDate) : 0;
    return db - da;
  });

  const data = {
    status: "success",
    sources: {
      headlines: { url: RSS_HEADLINES, count: headlines.length },
      judgments: { url: RSS_JUDGMENTS, count: judgments.length },
    },
    totalItems: all.length,
    items: all,
    fetchedAt: istTimestamp(),
  };
  setCache(cacheKey, data, CACHE_TTL.news);
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
  // Court View table structure:
  // Court No. | Serial No. | List (cause list type) | Progress | Case Details | Important Information
  // Case Details cell contains structured text: "Case Details - WRIA/3800/2026  Title:... Petitioner's Counsels -...  Respondent's Counsel -..."
  $("table tr").each((i, tr) => {
    if (i === 0) return; // skip header
    const cells = [];
    $(tr).find("td").each((j, td) => cells.push($(td).text().trim()));
    if (cells.length >= 3) {
      const courtNo = cells[0];
      const serialNo = cells[1]; // current item number being heard
      const listType = cells[2] || "";
      const progress = cells[3] || "";
      const caseDetails = cells[4] || "";

      // Skip "Court NOT in session" rows
      if (serialNo.toLowerCase().includes("not in session")) {
        courts.push({
          courtNo,
          currentItem: "0",
          status: "not_in_session",
          causelistType: null,
          caseBeingHeard: null,
          caseRef: null,
          title: null,
          petitionerCounsel: null,
          respondentCounsel: null,
          coram: null,
          progress: null,
        });
        return;
      }

      // Parse case details text
      const caseRefMatch = caseDetails.match(/Case Details\s*[-–]\s*([A-Z0-9\/]+)/i);
      const titleMatch = caseDetails.match(/Title\s*:?\s*(.+?)(?:\s*Petitioner|$)/i);
      const petCounselMatch = caseDetails.match(/Petitioner'?s?\s*Counsels?\s*[-–]\s*(.+?)(?:\s*Respondent|$)/i);
      const resCounselMatch = caseDetails.match(/Respondent'?s?\s*Counsel\s*[-–]\s*(.+?)$/i);

      courts.push({
        courtNo,
        currentItem: serialNo,
        causelistType: listType,
        progress: progress || null,
        caseBeingHeard: caseRefMatch ? caseRefMatch[1].trim() : null,
        caseRef: caseRefMatch ? caseRefMatch[1].trim() : null,
        title: titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : null,
        petitionerCounsel: petCounselMatch ? petCounselMatch[1].trim() : null,
        respondentCounsel: resCounselMatch ? resCounselMatch[1].trim() : null,
        coram: null, // Court View doesn't show judge names, just court numbers
        status: "in_session",
      });
    }
  });

  const data = {
    status: "success",
    bench: bench === "lucknow" ? "Lucknow" : "Allahabad",
    courts,
    totalCourts: courts.length,
    fetchedAt: istTimestamp(),
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
  console.log(`[${istTimestamp()}] ${req.method} ${req.path}`);
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

    aldCases.forEach(c => { c.bench = "Allahabad"; c.court = "Allahabad High Court"; });
    lkoCases.forEach(c => { c.bench = "Lucknow"; c.court = "Allahabad High Court (Lucknow Bench)"; });

    const allCases = [...aldCases, ...lkoCases];

    // Bench-level status detail so the frontend can show meaningful messages
    // (e.g. "Lucknow Bench CCMS is in maintenance" vs "advocate has no cases").
    const benchStatus = {
      allahabad: {
        status: ald.status === "fulfilled" ? ald.value.status : "error",
        count: aldCases.length,
        error: ald.status === "fulfilled" ? ald.value.error : ald.reason?.message,
        rollFormatUsed: ald.status === "fulfilled" ? ald.value.rollFormatUsed : null,
      },
      lucknow: {
        status: lko.status === "fulfilled" ? lko.value.status : "error",
        count: lkoCases.length,
        error: lko.status === "fulfilled" ? lko.value.error : lko.reason?.message,
        rollFormatUsed: lko.status === "fulfilled" ? lko.value.rollFormatUsed : null,
        note: lko.status === "fulfilled" ? lko.value.note : null,
      },
    };

    res.json({
      status: allCases.length > 0 ? "success"
            : (benchStatus.allahabad.status === "upstream_maintenance" || benchStatus.lucknow.status === "upstream_maintenance")
              ? "upstream_maintenance"
              : "no_cases_found",
      rollNumber,
      totalCases: allCases.length,
      allahabadCases: aldCases.length,
      lucknowCases: lkoCases.length,
      cases: allCases,
      benchStatus,
      fetchedAt: istTimestamp(),
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

// ── Diagnostics: dry-run a single POST and return raw response ──
app.get("/api/advocate-dryrun", async (req, res) => {
  try {
    const { roll, bench = "lucknow", year } = req.query;
    if (!roll) return res.status(400).json({ error: "missing ?roll=" });
    const out = await dryRunAdvocate(bench, roll, year);
    res.json(out);
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ── Diagnostics: what URLs / formats does the backend try for a given roll number? ──
app.get("/api/advocate-diag/:rollNumber", async (req, res) => {
  try {
    const { rollNumber } = req.params;
    const variants = rollNumberVariants(rollNumber);
    const currentYear = istNow().getFullYear();
    res.json({
      input: rollNumber,
      variants,
      allahabad: {
        getUrl: `${CCMS_ALD_GET}/advocate-cases-roll-wise`,
        postUrl: `${CCMS_ALD}/advocate-cases-roll-wise`,
        fields: ["adv_roll", "case_year", "captchacode", "submit=Go"],
        yearsToScan: Array.from({ length: 9 }, (_, i) => currentYear - i),
      },
      lucknow: {
        getUrl: `${CCMS_LKO_GET}/advocate-cases-date-wise`,
        postUrl: `${CCMS_LKO}/advocate-cases-date-wise`,
        fields: ["adv_roll", "captchacode", "submit=Go"],
      },
      note: "CCMS uses the Advocate Roll Number (e.g. B/A2401/2019), not the Bar Council enrollment number (e.g. UP/2030/2018).",
    });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ── Legal updates / news (merged Allahabad HC RSS feeds) ──
app.get("/api/news", async (req, res) => {
  try {
    const result = await fetchLegalNews();
    const limit = parseInt(req.query.limit, 10);
    if (Number.isFinite(limit) && limit > 0) {
      res.json({ ...result, items: result.items.slice(0, limit) });
    } else {
      res.json(result);
    }
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
  const today = istDateStr();
  const isHoliday = HOLIDAYS_2026.find(h => h.date === today);
  const isVacation = VACATIONS_2026.find(v => today >= v.start && today <= v.end);
  const dayOfWeek = istNow().getDay();
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

// ─────────────────────────────────────────────────────────────────────
// TRANSLATION (Google Translate — free, no key needed)
// ─────────────────────────────────────────────────────────────────────

let translateFn = null;

async function loadTranslator() {
  try {
    const mod = await import("google-translate-api-x");
    translateFn = mod.default || mod.translate;
    console.log("[Translator] Google Translate loaded successfully");
  } catch (err) {
    console.error("[Translator] Failed to load google-translate-api-x:", err.message);
  }
}

// POST /api/translate — translate text between languages
app.post("/api/translate", async (req, res) => {
  try {
    const { text, from, to } = req.body;
    if (!text || !to) {
      return res.status(400).json({ status: "error", error: "Missing 'text' and 'to' parameters" });
    }
    if (!translateFn) {
      await loadTranslator();
      if (!translateFn) {
        return res.status(503).json({ status: "error", error: "Translation service unavailable" });
      }
    }

    const fromLang = from || "auto";
    const MAX_CHUNK = 4500; // Google Translate limit per request

    // Split long text into chunks at sentence boundaries
    let chunks = [];
    if (text.length <= MAX_CHUNK) {
      chunks = [text];
    } else {
      let i = 0;
      while (i < text.length) {
        let end = Math.min(i + MAX_CHUNK, text.length);
        if (end < text.length) {
          const lastPeriod = text.lastIndexOf(".", end);
          const lastNewline = text.lastIndexOf("\n", end);
          const splitAt = Math.max(lastPeriod, lastNewline);
          if (splitAt > i) end = splitAt + 1;
        }
        chunks.push(text.slice(i, end));
        i = end;
      }
    }

    // Translate each chunk
    const results = [];
    for (const chunk of chunks) {
      const result = await translateFn(chunk, { from: fromLang, to });
      results.push(result.text);
    }

    const translated = results.join("");
    res.json({
      status: "success",
      translatedText: translated,
      from: fromLang,
      to,
      chars: text.length,
    });
  } catch (err) {
    console.error("[Translate] Error:", err.message);
    res.status(500).json({ status: "error", error: "Translation failed: " + err.message });
  }
});

// GET /api/translate/languages — list supported languages
app.get("/api/translate/languages", (req, res) => {
  // Common languages relevant for Indian legal context
  res.json({
    status: "success",
    languages: [
      { code: "hi", name: "Hindi" },
      { code: "en", name: "English" },
      { code: "ur", name: "Urdu" },
      { code: "bn", name: "Bengali" },
      { code: "ta", name: "Tamil" },
      { code: "te", name: "Telugu" },
      { code: "mr", name: "Marathi" },
      { code: "gu", name: "Gujarati" },
      { code: "kn", name: "Kannada" },
      { code: "ml", name: "Malayalam" },
      { code: "pa", name: "Punjabi" },
      { code: "or", name: "Odia" },
      { code: "as", name: "Assamese" },
      { code: "sa", name: "Sanskrit" },
      { code: "ar", name: "Arabic" },
      { code: "fr", name: "French" },
      { code: "de", name: "German" },
      { code: "es", name: "Spanish" },
      { code: "zh-CN", name: "Chinese (Simplified)" },
      { code: "ja", name: "Japanese" },
    ],
  });
});


// ── Start server ──
app.listen(PORT, () => {
  loadTranslator();
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
║    POST /api/translate             — Translate text (free)    ║
║    GET  /api/translate/languages   — Supported languages      ║
║    GET  /health                    — Health check             ║
╚═══════════════════════════════════════════════════════════════╝
  `);

  // Pre-load CAPTCHA solver
  loadCaptchaSolver();
});
