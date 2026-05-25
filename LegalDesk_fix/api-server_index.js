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
const CCMS_ALD = `${BASE_URL}/apps/status_ccms`;
const CCMS_LKO = `${BASE_URL}/apps/status_ccms_lko`;
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

async function fetchAdvocateCases(rollNumber, bench = "allahabad") {
  const cacheKey = `adv_${rollNumber}_${bench}`;
  const cached = getCached(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  // Build list of roll number formats to try:
  // 1. As-is (original input)
  // 2. If it looks like "B/A2401/2019" → try "A2401/2019" (strip prefix)
  // 3. If it looks like "UP/2030/2018" (Bar Council format) → try as-is
  // 4. If it contains "/" → try without any prefix (just number/year)
  const formatsToTry = [rollNumber];
  const cleaned = rollNumber.trim();

  // Strip single-letter prefix like "B/" from Advocate IDs (e.g., "B/A2401/2019" → "A2401/2019")
  if (/^[A-Z]\//.test(cleaned)) {
    formatsToTry.push(cleaned.substring(2));
  }
  // If it has format like "A2401/2019", also try just the number
  const numYearMatch = cleaned.match(/[A-Z]*(\d+)\/(\d{4})$/);
  if (numYearMatch) {
    formatsToTry.push(`${numYearMatch[1]}/${numYearMatch[2]}`);
  }

  // Deduplicate
  const uniqueFormats = [...new Set(formatsToTry)];
  console.log(`[API] Advocate case lookup for "${rollNumber}" — trying formats: ${uniqueFormats.join(", ")}`);

  const base = bench === "lucknow" ? CCMS_LKO : CCMS_ALD;
  const url = `${base}/advocate-cases-roll-wise`;

  for (const format of uniqueFormats) {
    // Solve CAPTCHA for each attempt
    let sessionToken, captchaAnswer;
    try {
      const solved = await solveCaptchaForUrl(url, base);
      sessionToken = solved.sessionToken;
      captchaAnswer = solved.captchaAnswer;
      console.log(`[API] CAPTCHA solved for advocate lookup (format "${format}"): "${captchaAnswer}" (confidence: ${solved.confidence.toFixed(1)}%)`);
    } catch (err) {
      console.error(`[API] CAPTCHA solve failed: ${err.message}`);
      continue; // Try next format
    }

    const result = await fetchPostForm(url, {
      roll_no: format,
      captcha: captchaAnswer,
      submit: "Search",
    }, sessionToken);

    const $ = cheerio.load(result.html);

    // Check for CAPTCHA rejection
    const errorText = $(".alert-danger, .error, .text-danger").text().trim();
    if (errorText.toLowerCase().includes("captcha") || errorText.toLowerCase().includes("invalid")) {
      // Retry once with new CAPTCHA
      try {
        const retry = await solveCaptchaForUrl(url, base);
        const retryResult = await fetchPostForm(url, { roll_no: format, captcha: retry.captchaAnswer, submit: "Search" }, retry.sessionToken);
        const $r = cheerio.load(retryResult.html);
        const retryErr = $r(".alert-danger, .error, .text-danger").text().trim();
        if (!retryErr.toLowerCase().includes("captcha")) {
          const data = parseAdvocateCases($r, rollNumber, bench);
          if (data.totalCases > 0) {
            console.log(`[API] Found ${data.totalCases} cases using format "${format}"`);
            setCache(cacheKey, data, CACHE_TTL.advocate_cases);
            return data;
          }
        }
      } catch (_) {}
      continue; // Try next format
    }

    const data = parseAdvocateCases($, rollNumber, bench);
    if (data.totalCases > 0) {
      console.log(`[API] Found ${data.totalCases} cases using format "${format}"`);
      setCache(cacheKey, data, CACHE_TTL.advocate_cases);
      return data;
    }
    console.log(`[API] No cases found with format "${format}", trying next...`);
  }

  // None of the formats returned cases
  console.log(`[API] No cases found for "${rollNumber}" with any format`);
  return {
    status: "no_cases_found",
    rollNumber,
    bench: bench === "lucknow" ? "Lucknow Bench" : "Allahabad",
    totalCases: 0,
    cases: [],
    fetchedAt: istTimestamp(),
  };
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
    fetchedAt: istTimestamp(),
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
