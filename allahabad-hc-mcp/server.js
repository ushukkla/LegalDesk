#!/usr/bin/env node

/**
 * ═══════════════════════════════════════════════════════════════════════
 *  Allahabad High Court — MCP Server
 *  Provides structured tools for real-time court data access
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  Tools:
 *    1. get_case_status      — Search case by number/type/year (both benches)
 *    2. get_cause_list        — Fetch today's cause list URL & metadata
 *    3. get_bench_roster      — Current bench constitution & roster
 *    4. search_judgments      — Search judgments/orders from elegalix
 *    5. get_defective_list    — Fetch defective case filing list
 *    6. get_court_calendar    — Holidays, vacations, working day status
 *    7. get_advocate_cases    — Fetch all cases for an advocate by roll number
 *    8. get_case_history      — Listing history & IA details for a case
 *    9. get_court_view        — Live court view display board data
 *   10. get_justice_clock     — Disposal & institution statistics
 *
 *  Architecture:
 *    - Server-side HTTP requests (bypasses CORS)
 *    - HTML parsing via cheerio (no official API exists)
 *    - Auto CAPTCHA solving via Tesseract OCR (with manual fallback)
 *    - Structured JSON responses for agent consumption
 *
 *  Usage:
 *    npx allahabad-hc-mcp            (stdio transport)
 *    node server.js                  (stdio transport)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as cheerio from "cheerio";
import { solveCourtCaptcha } from "./captcha-solver.js";

// ─────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────

const BASE_URL = "https://www.allahabadhighcourt.in";
const CCMS_ALD = `${BASE_URL}/apps/status_ccms`;
const CCMS_LKO = `${BASE_URL}/apps/status_ccms_lko`;
const ELEGALIX = "https://elegalix.allahabadhighcourt.in/elegalix";
const COURT_VIEW_ALD = "https://courtview2.allahabadhighcourt.in/courtview/CourtViewAllahabad.do";
const COURT_VIEW_LKO = "https://courtview2.allahabadhighcourt.in/courtview/CourtViewLucknow.do";
const ECOURTS_BASE = "https://services.ecourts.gov.in/ecourtindia_v6";

/** Case type codes used by the CCMS portal */
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

/** Allahabad HC 2026 holidays */
const COURT_HOLIDAYS_2026 = [
  { date: "2026-01-26", name: "Republic Day", nameHi: "गणतंत्र दिवस" },
  { date: "2026-03-10", name: "Maha Shivaratri", nameHi: "महाशिवरात्रि" },
  { date: "2026-03-17", name: "Holi (2nd day)", nameHi: "होली" },
  { date: "2026-03-31", name: "Id-ul-Fitr", nameHi: "ईद-उल-फित्र" },
  { date: "2026-04-02", name: "Ram Navami", nameHi: "रामनवमी" },
  { date: "2026-04-06", name: "Mahavir Jayanti", nameHi: "महावीर जयंती" },
  { date: "2026-04-14", name: "Dr. Ambedkar Jayanti", nameHi: "डॉ. अम्बेडकर जयंती" },
  { date: "2026-04-18", name: "Good Friday", nameHi: "गुड फ्राइडे" },
  { date: "2026-05-01", name: "May Day", nameHi: "मई दिवस" },
  { date: "2026-05-24", name: "Buddha Purnima", nameHi: "बुद्ध पूर्णिमा" },
  { date: "2026-06-07", name: "Id-ul-Zuha (Bakrid)", nameHi: "ईद-उल-जुहा (बकरीद)" },
  { date: "2026-07-07", name: "Muharram", nameHi: "मुहर्रम" },
  { date: "2026-08-15", name: "Independence Day", nameHi: "स्वतंत्रता दिवस" },
  { date: "2026-08-16", name: "Janmashtami", nameHi: "जन्माष्टमी" },
  { date: "2026-09-05", name: "Milad-un-Nabi", nameHi: "मिलाद-उन-नबी" },
  { date: "2026-10-02", name: "Mahatma Gandhi Jayanti", nameHi: "महात्मा गांधी जयंती" },
  { date: "2026-10-20", name: "Dussehra", nameHi: "दशहरा" },
  { date: "2026-11-08", name: "Diwali (Lakshmi Puja)", nameHi: "दिवाली" },
  { date: "2026-11-10", name: "Govardhan Puja", nameHi: "गोवर्धन पूजा" },
  { date: "2026-11-12", name: "Guru Nanak Jayanti", nameHi: "गुरु नानक जयंती" },
  { date: "2026-12-25", name: "Christmas Day", nameHi: "क्रिसमस" },
];

const COURT_VACATIONS_2026 = [
  { start: "2026-05-25", end: "2026-07-05", name: "Summer Vacation", nameHi: "ग्रीष्मकालीन अवकाश" },
  { start: "2026-10-05", end: "2026-10-19", name: "Dussehra Vacation", nameHi: "दशहरा अवकाश" },
  { start: "2026-12-26", end: "2027-01-04", name: "Winter Vacation", nameHi: "शीतकालीन अवकाश" },
];

// ─────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Session store — maps advocate roll numbers to session cookies */
const sessionStore = new Map();

async function fetchPage(url, options = {}) {
  const headers = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
    ...options.headers,
  };
  if (options.sessionToken) {
    headers.Cookie = options.sessionToken;
  }
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
  $(tableEl)
    .find("tr")
    .each((i, tr) => {
      const cells = [];
      $(tr)
        .find("td, th")
        .each((j, td) => {
          cells.push($(td).text().trim());
        });
      if (cells.length > 0) rows.push(cells);
    });
  return rows;
}

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

// ─────────────────────────────────────────────────────────────────────
// MCP SERVER
// ─────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "allahabad-hc-mcp",
  version: "1.0.0",
  description:
    "MCP Server providing real-time access to Allahabad High Court data — case status, cause lists, bench roster, judgments, defective lists, court calendar, advocate cases, and live court view.",
});

// ─── TOOL 1: get_case_status ────────────────────────────────────────

server.tool(
  "get_case_status",
  "Search for a case in the Allahabad High Court CCMS portal by case type, number, and year. Returns case details including parties, coram, status, next hearing date, and filing info. Works for both Allahabad and Lucknow benches. CAPTCHA is solved automatically via Tesseract OCR. You can also provide a manual session_token + captcha_answer if auto-solve fails.",
  {
    case_type: z
      .string()
      .describe(
        `Case type code, e.g. BAIL, WRIA, WRIB, CRLP, CRLA, A482, SPLA, WPIL, etc. Available types: ${Object.keys(CASE_TYPES).join(", ")}`
      ),
    case_number: z.string().describe("Case number, e.g. 1234"),
    case_year: z
      .string()
      .describe("Case filing year, e.g. 2024"),
    bench: z
      .enum(["allahabad", "lucknow"])
      .default("allahabad")
      .describe("Which bench to query — allahabad (principal seat) or lucknow"),
    session_token: z
      .string()
      .optional()
      .describe("(Optional) Session cookie from a manual CAPTCHA solve. If omitted, auto-solve via OCR is attempted."),
    captcha_answer: z
      .string()
      .optional()
      .describe("(Optional) Manually solved CAPTCHA text, required with session_token"),
  },
  async ({ case_type, case_number, case_year, bench, session_token, captcha_answer }) => {
    const caseTypeInfo = CASE_TYPES[case_type.toUpperCase()];
    if (!caseTypeInfo) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Unknown case type: ${case_type}. Valid types: ${Object.keys(CASE_TYPES).join(", ")}`,
            }),
          },
        ],
      };
    }

    const base = bench === "lucknow" ? CCMS_LKO : CCMS_ALD;
    const searchUrl = `${base}/case-number`;

    // ── Auto-solve CAPTCHA if no manual token provided ──
    if (!session_token) {
      try {
        const solved = await solveCourtCaptcha(searchUrl, base, { maxAttempts: 3 });
        session_token = solved.sessionToken;
        captcha_answer = solved.captchaAnswer;
        console.error(`[CAPTCHA] Auto-solved in ${solved.attempts} attempt(s): "${solved.captchaAnswer}" (confidence: ${solved.confidence.toFixed(1)}%, strategy: ${solved.strategy})`);
      } catch (err) {
        // Auto-solve failed — return manual fallback
        console.error(`[CAPTCHA] Auto-solve failed: ${err.message}`);
        const page = await fetchPage(searchUrl);
        const $ = cheerio.load(page.html);
        const captchaImg = $('img[src*="captcha"]').attr("src");
        const captchaUrl = captchaImg
          ? captchaImg.startsWith("http") ? captchaImg : `${base}/${captchaImg}`
          : null;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "captcha_manual_required",
                message: "Auto CAPTCHA solve failed. Please solve manually and call again with session_token and captcha_answer.",
                auto_solve_error: err.message,
                captcha_url: captchaUrl,
                session_token: page.cookies.join("; "),
                portal_url: searchUrl,
              }),
            },
          ],
        };
      }
    }

    // ── Submit search form with CAPTCHA answer ──
    const formData = {
      case_type_id: caseTypeInfo.id,
      case_no: case_number,
      case_year: case_year,
      captcha: captcha_answer || "",
      submit: "Search",
    };

    const result = await fetchPostForm(searchUrl, formData, session_token);
    const $ = cheerio.load(result.html);

    // Check for CAPTCHA error — if auto-solve produced wrong answer
    const errorText = $(".alert-danger, .error, .text-danger").text().trim();
    if (errorText.toLowerCase().includes("captcha") || errorText.toLowerCase().includes("invalid")) {
      // Retry auto-solve one more time with fresh session
      try {
        console.error("[CAPTCHA] First answer rejected, retrying...");
        const retry = await solveCourtCaptcha(searchUrl, base, { maxAttempts: 2 });
        const retryForm = { ...formData, captcha: retry.captchaAnswer };
        const retryResult = await fetchPostForm(searchUrl, retryForm, retry.sessionToken);
        const $r = cheerio.load(retryResult.html);
        const retryError = $r(".alert-danger, .error, .text-danger").text().trim();
        if (retryError.toLowerCase().includes("captcha") || retryError.toLowerCase().includes("invalid")) {
          // Give up — return manual fallback
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "captcha_failed",
                  error: "Auto CAPTCHA solve was rejected by the server after multiple retries. Please solve manually.",
                  portal_url: searchUrl,
                }),
              },
            ],
          };
        }
        // Retry succeeded — use the retry result
        return parseCaseStatusResponse($r, case_type, case_number, case_year, bench, caseTypeInfo);
      } catch (retryErr) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "captcha_failed",
                error: errorText || "CAPTCHA verification failed.",
                retry_error: retryErr.message,
                portal_url: searchUrl,
              }),
            },
          ],
        };
      }
    }

    return parseCaseStatusResponse($, case_type, case_number, case_year, bench, caseTypeInfo);
  }
);

/** Parse case status HTML into structured JSON */
function parseCaseStatusResponse($, case_type, case_number, case_year, bench, caseTypeInfo) {
  const tables = $("table");
  const caseData = {
    status: "success",
    bench,
    case_ref: `${case_type.toUpperCase()} No. ${case_number} of ${case_year}`,
    case_type_name: caseTypeInfo.name,
  };

  tables.each((i, table) => {
    const rows = parseTable($, table);
    rows.forEach((row) => {
      if (row.length >= 2) {
        const key = row[0].toLowerCase().replace(/[:\s]+/g, "_").replace(/_+$/, "");
        const val = row[1];
        if (key && val) {
          if (key.includes("petitioner") || key.includes("applicant")) caseData.petitioner = val;
          else if (key.includes("respondent") || key.includes("opposite")) caseData.respondent = val;
          else if (key.includes("coram") || key.includes("bench") || key.includes("judge")) caseData.coram = val;
          else if (key.includes("next") && key.includes("date")) caseData.next_hearing = val;
          else if (key.includes("status") || key.includes("stage")) caseData.stage = val;
          else if (key.includes("filing") && key.includes("date")) caseData.filing_date = val;
          else if (key.includes("advocate") || key.includes("counsel")) caseData.advocate = val;
          else if (key.includes("order")) caseData.last_order = val;
        }
      }
    });
  });

  if (!caseData.petitioner && !caseData.coram) {
    const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 2000);
    caseData.raw_response = bodyText;
    caseData.note = "Could not parse structured data. Raw response included.";
  }

  return {
    content: [{ type: "text", text: JSON.stringify(caseData, null, 2) }],
  };
}

// ─── TOOL 2: get_cause_list ─────────────────────────────────────────

server.tool(
  "get_cause_list",
  "Fetch today's cause list for the Allahabad High Court. Returns cause list links and, when possible, parses the cause list page to extract listed cases. Available for both Allahabad and Lucknow benches.",
  {
    bench: z
      .enum(["allahabad", "lucknow"])
      .default("allahabad")
      .describe("Which bench — allahabad or lucknow"),
    date: z
      .string()
      .optional()
      .describe("Date in YYYY-MM-DD format. Defaults to today."),
  },
  async ({ bench, date }) => {
    const causeListUrl =
      bench === "lucknow"
        ? `${BASE_URL}/causelist/causelist_lko.htm`
        : `${BASE_URL}/causelist/causelist_ald.htm`;

    const page = await fetchPage(causeListUrl);
    const $ = cheerio.load(page.html);

    // Extract all PDF/HTML links from the cause list page
    const links = [];
    $("a[href]").each((i, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim();
      if (href && text && (href.includes(".pdf") || href.includes("causelist") || href.includes("cause"))) {
        const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
        links.push({ text, url: fullUrl });
      }
    });

    // Try to extract court/bench-wise case listings
    const courtListings = [];
    $("table").each((i, table) => {
      const rows = parseTable($, table);
      if (rows.length > 1) {
        courtListings.push({
          table_index: i,
          header: rows[0],
          row_count: rows.length - 1,
          sample_rows: rows.slice(1, 6),
        });
      }
    });

    const bodyText = $("body").text().replace(/\s+/g, " ").trim();
    const dateMatch = bodyText.match(/\d{2}[\/\-]\d{2}[\/\-]\d{4}/);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              bench: bench === "lucknow" ? "Lucknow Bench" : "Allahabad (Principal Seat)",
              cause_list_url: causeListUrl,
              date_on_page: dateMatch ? dateMatch[0] : date || todayISO(),
              pdf_links: links.slice(0, 30),
              court_listings: courtListings.slice(0, 10),
              total_links_found: links.length,
              note: "Cause lists are typically uploaded as PDF files. The pdf_links array contains direct download links. Court listings show parsed table data if available.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ─── TOOL 3: get_bench_roster ───────────────────────────────────────

server.tool(
  "get_bench_roster",
  "Fetch the current bench roster / bench constitution of the Allahabad High Court. Shows which judge/bench hears which type of cases. Essential for advocates to know where their case will be listed.",
  {
    group: z
      .enum(["roster", "notifications", "circulars"])
      .default("roster")
      .describe("roster = bench constitution, notifications = admin orders, circulars = office circulars"),
  },
  async ({ group }) => {
    const groupMap = { roster: "11", notifications: "5", circulars: "4" };
    const url = `${BASE_URL}/calendar/itemWiseList.jsp?group=${groupMap[group]}`;

    const page = await fetchPage(url);
    const $ = cheerio.load(page.html);

    const items = [];
    $("table tr").each((i, tr) => {
      const cells = [];
      $(tr)
        .find("td, th")
        .each((j, td) => {
          const text = $(td).text().trim();
          const link = $(td).find("a").attr("href");
          cells.push({ text, link: link ? (link.startsWith("http") ? link : `${BASE_URL}${link.startsWith("/") ? "" : "/calendar/"}${link}`) : undefined });
        });
      if (cells.some((c) => c.text)) items.push(cells);
    });

    // Also extract any heading/title text
    const pageTitle = $("h1, h2, h3, .heading, .title").first().text().trim();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              type: group,
              page_title: pageTitle || `Allahabad HC — ${group}`,
              url,
              items: items.slice(0, 50),
              total_items: items.length,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ─── TOOL 4: search_judgments ───────────────────────────────────────

server.tool(
  "search_judgments",
  "Search for judgments and orders from the Allahabad High Court's eLegalix system. Can search by case type, case number, year, party name, or free text. Also provides the RSS feed for latest judgment headlines.",
  {
    search_type: z
      .enum(["case_number", "party_name", "free_text", "rss_feed"])
      .describe("How to search — by case number, party name, free text keywords, or fetch the RSS feed of latest judgments"),
    case_type: z.string().optional().describe("Case type code (e.g. WRIA, BAIL) — for case_number search"),
    case_number: z.string().optional().describe("Case number — for case_number search"),
    case_year: z.string().optional().describe("Year — for case_number search"),
    query: z.string().optional().describe("Search query — for party_name or free_text search"),
    bench: z
      .enum(["allahabad", "lucknow", "both"])
      .default("both")
      .describe("Filter by bench"),
  },
  async ({ search_type, case_type, case_number, case_year, query, bench }) => {
    if (search_type === "rss_feed") {
      const rssUrl = `${ELEGALIX}/rssfeed.do`;
      const page = await fetchPage(rssUrl);
      const $ = cheerio.load(page.html, { xmlMode: true });
      const items = [];
      $("item").each((i, el) => {
        items.push({
          title: $(el).find("title").text().trim(),
          link: $(el).find("link").text().trim(),
          description: $(el).find("description").text().trim().slice(0, 300),
          pubDate: $(el).find("pubDate").text().trim(),
        });
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              type: "rss_feed",
              feed_url: rssUrl,
              total_items: items.length,
              items: items.slice(0, 25),
            }, null, 2),
          },
        ],
      };
    }

    // For other search types, use the judgment search page
    const searchUrl = `${BASE_URL}/jo.htm`;
    const page = await fetchPage(searchUrl);
    const $ = cheerio.load(page.html);

    // Extract available search forms and links
    const searchForms = [];
    $("form").each((i, form) => {
      const action = $(form).attr("action");
      const inputs = [];
      $(form)
        .find("input, select")
        .each((j, inp) => {
          inputs.push({
            name: $(inp).attr("name"),
            type: $(inp).attr("type") || "select",
            value: $(inp).attr("value"),
          });
        });
      searchForms.push({ action, inputs });
    });

    const judgmentLinks = [];
    $("a[href]").each((i, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim();
      if (href && text && (href.includes("elegalix") || href.includes("judgment") || href.includes("jo"))) {
        const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
        judgmentLinks.push({ text, url: fullUrl });
      }
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: "search_page_loaded",
              search_url: searchUrl,
              search_type,
              query: query || `${case_type} ${case_number}/${case_year}`,
              available_search_forms: searchForms,
              judgment_links: judgmentLinks.slice(0, 20),
              elegalix_direct_search: `${ELEGALIX}/WebSearch.do`,
              rss_feed: `${ELEGALIX}/rssfeed.do`,
              note: "The judgment search portal uses JavaScript-based forms. For direct search, use the elegalix_direct_search URL with appropriate POST parameters, or use the rss_feed for latest headlines.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ─── TOOL 5: get_defective_list ─────────────────────────────────────

server.tool(
  "get_defective_list",
  "Fetch the official list of defective case filings from the Allahabad High Court. Shows cases that have defects (court fees not paid, format issues, missing documents, etc.) that need to be cleared by the advocate.",
  {},
  async () => {
    const url = `${BASE_URL}/calendar/cleardefectivelist.jsp`;
    const page = await fetchPage(url);
    const $ = cheerio.load(page.html);

    const tables = [];
    $("table").each((i, table) => {
      const rows = parseTable($, table);
      if (rows.length > 0) {
        tables.push({
          header: rows[0],
          data: rows.slice(1, 100),
          total_rows: rows.length - 1,
        });
      }
    });

    const pageTitle = $("h1, h2, h3, .heading").first().text().trim();
    const lastUpdated = $("body").text().match(/updated[:\s]*(\d{2}[\/\-]\d{2}[\/\-]\d{4})/i);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              title: pageTitle || "Defective Case Files List",
              url,
              last_updated: lastUpdated ? lastUpdated[1] : todayISO(),
              tables: tables.slice(0, 5),
              note: "This is the official list of cases with filing defects. Advocates should check this regularly and clear defects before the deadline to avoid dismissal.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ─── TOOL 6: get_court_calendar ─────────────────────────────────────

server.tool(
  "get_court_calendar",
  "Get the Allahabad High Court calendar — holidays, vacations, and working day status. Can check if a specific date is a working day, and lists upcoming holidays/vacations.",
  {
    check_date: z
      .string()
      .optional()
      .describe("Check if a specific date (YYYY-MM-DD) is a working day. Defaults to today."),
  },
  async ({ check_date }) => {
    const dateToCheck = check_date || todayISO();
    const d = new Date(dateToCheck);
    const dayOfWeek = d.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const holiday = COURT_HOLIDAYS_2026.find((h) => h.date === dateToCheck);
    const vacation = COURT_VACATIONS_2026.find(
      (v) => new Date(dateToCheck) >= new Date(v.start) && new Date(dateToCheck) <= new Date(v.end)
    );
    const isWorkingDay = !isWeekend && !holiday && !vacation;

    const upcomingHolidays = COURT_HOLIDAYS_2026.filter((h) => new Date(h.date) >= new Date(todayISO())).slice(0, 10);
    const nextVacation = COURT_VACATIONS_2026.find((v) => new Date(v.start) > new Date(todayISO()));
    const currentVacation = COURT_VACATIONS_2026.find(
      (v) => new Date(todayISO()) >= new Date(v.start) && new Date(todayISO()) <= new Date(v.end)
    );

    // Count working days until next hearing date
    function workingDaysBetween(from, to) {
      let count = 0;
      const curr = new Date(from);
      const end = new Date(to);
      while (curr < end) {
        curr.setDate(curr.getDate() + 1);
        const iso = curr.toISOString().split("T")[0];
        const wd = curr.getDay();
        const isH = COURT_HOLIDAYS_2026.some((h) => h.date === iso);
        const isV = COURT_VACATIONS_2026.some(
          (v) => curr >= new Date(v.start) && curr <= new Date(v.end)
        );
        if (wd !== 0 && wd !== 6 && !isH && !isV) count++;
      }
      return count;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              date_checked: dateToCheck,
              day_of_week: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dayOfWeek],
              is_working_day: isWorkingDay,
              is_weekend: isWeekend,
              is_holiday: holiday ? { name: holiday.name, nameHi: holiday.nameHi } : false,
              is_vacation: vacation ? { name: vacation.name, nameHi: vacation.nameHi, start: vacation.start, end: vacation.end } : false,
              current_vacation: currentVacation || null,
              upcoming_holidays: upcomingHolidays,
              next_vacation: nextVacation || null,
              all_vacations: COURT_VACATIONS_2026,
              calendar_url: `${BASE_URL}/Calendar/calendar.htm`,
              working_days_calculator: "Use check_date parameter to check any date",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ─── TOOL 7: get_advocate_cases ─────────────────────────────────────

server.tool(
  "get_advocate_cases",
  "Fetch all cases associated with an advocate using their Bar Council roll number. Queries the CCMS portal. CAPTCHA is solved automatically via Tesseract OCR. Manual fallback available if auto-solve fails.",
  {
    roll_number: z.string().describe("Advocate's Bar Council roll number"),
    bench: z
      .enum(["allahabad", "lucknow"])
      .default("allahabad")
      .describe("Which bench to query"),
    session_token: z.string().optional().describe("(Optional) Session cookie from manual CAPTCHA solve"),
    captcha_answer: z.string().optional().describe("(Optional) Manually solved CAPTCHA text"),
  },
  async ({ roll_number, bench, session_token, captcha_answer }) => {
    const base = bench === "lucknow" ? CCMS_LKO : CCMS_ALD;
    const url = `${base}/advocate-cases-roll-wise`;

    // ── Auto-solve CAPTCHA if no manual token ──
    if (!session_token) {
      try {
        const solved = await solveCourtCaptcha(url, base, { maxAttempts: 3 });
        session_token = solved.sessionToken;
        captcha_answer = solved.captchaAnswer;
        console.error(`[CAPTCHA] Auto-solved for advocate lookup: "${solved.captchaAnswer}" (confidence: ${solved.confidence.toFixed(1)}%)`);
      } catch (err) {
        console.error(`[CAPTCHA] Auto-solve failed: ${err.message}`);
        const page = await fetchPage(url);
        const $ = cheerio.load(page.html);
        const captchaImg = $('img[src*="captcha"]').attr("src");
        const captchaUrl = captchaImg
          ? captchaImg.startsWith("http") ? captchaImg : `${base}/${captchaImg}`
          : null;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "captcha_manual_required",
                message: "Auto CAPTCHA solve failed. Please solve manually.",
                auto_solve_error: err.message,
                captcha_url: captchaUrl,
                session_token: page.cookies.join("; "),
                portal_url: url,
                roll_number,
                bench,
              }),
            },
          ],
        };
      }
    }

    const formData = {
      roll_no: roll_number,
      captcha: captcha_answer || "",
      submit: "Search",
    };

    const result = await fetchPostForm(url, formData, session_token);
    const $ = cheerio.load(result.html);

    // Check if CAPTCHA was rejected
    const errorText = $(".alert-danger, .error, .text-danger").text().trim();
    if (errorText.toLowerCase().includes("captcha") || errorText.toLowerCase().includes("invalid")) {
      // One more retry
      try {
        const retry = await solveCourtCaptcha(url, base, { maxAttempts: 2 });
        const retryResult = await fetchPostForm(url, { ...formData, captcha: retry.captchaAnswer }, retry.sessionToken);
        const $r = cheerio.load(retryResult.html);
        const retryErr = $r(".alert-danger, .error, .text-danger").text().trim();
        if (!retryErr.toLowerCase().includes("captcha") && !retryErr.toLowerCase().includes("invalid")) {
          return parseAdvocateCases($r, roll_number, bench);
        }
      } catch (_) {}
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "captcha_failed",
              error: "CAPTCHA auto-solve was rejected. Please solve manually.",
              portal_url: url,
            }),
          },
        ],
      };
    }

    return parseAdvocateCases($, roll_number, bench);
  }
);

/** Parse advocate cases response HTML */
function parseAdvocateCases($, roll_number, bench) {
  const cases = [];
  $("table tr").each((i, tr) => {
    if (i === 0) return;
    const cells = [];
    $(tr).find("td").each((j, td) => cells.push($(td).text().trim()));
    if (cells.length >= 3) {
      cases.push({
        serial: cells[0],
        case_ref: cells[1],
        parties: cells[2],
        next_hearing: cells[3] || null,
        status: cells[4] || null,
        coram: cells[5] || null,
      });
    }
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: cases.length > 0 ? "success" : "no_cases_found",
          roll_number,
          bench: bench === "lucknow" ? "Lucknow Bench" : "Allahabad",
          total_cases: cases.length,
          cases: cases.slice(0, 100),
          note: cases.length === 0
            ? "No cases found. The roll number may be incorrect, or there are no pending cases."
            : undefined,
        }, null, 2),
      },
    ],
  };
}

// ─── TOOL 8: get_case_history ───────────────────────────────────────

server.tool(
  "get_case_history",
  "Fetch the listing history and interlocutory application (IA) details for a specific case. Shows all past hearing dates, orders, and connected IAs. CAPTCHA is solved automatically via Tesseract OCR.",
  {
    case_type: z.string().describe("Case type code (e.g. BAIL, WRIA)"),
    case_number: z.string().describe("Case number"),
    case_year: z.string().describe("Case year"),
    bench: z.enum(["allahabad", "lucknow"]).default("allahabad"),
    session_token: z.string().optional().describe("(Optional) Session cookie from manual CAPTCHA solve"),
    captcha_answer: z.string().optional().describe("(Optional) Manually solved CAPTCHA text"),
  },
  async ({ case_type, case_number, case_year, bench, session_token, captcha_answer }) => {
    const caseTypeInfo = CASE_TYPES[case_type.toUpperCase()];
    if (!caseTypeInfo) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Unknown case type: ${case_type}` }) }],
      };
    }

    const base = bench === "lucknow" ? CCMS_LKO : CCMS_ALD;
    const url = `${base}/listing-history`;

    // ── Auto-solve CAPTCHA if no manual token ──
    if (!session_token) {
      try {
        const solved = await solveCourtCaptcha(url, base, { maxAttempts: 3 });
        session_token = solved.sessionToken;
        captcha_answer = solved.captchaAnswer;
        console.error(`[CAPTCHA] Auto-solved for case history: "${solved.captchaAnswer}" (confidence: ${solved.confidence.toFixed(1)}%)`);
      } catch (err) {
        console.error(`[CAPTCHA] Auto-solve failed: ${err.message}`);
        const page = await fetchPage(url);
        const $ = cheerio.load(page.html);
        const captchaImg = $('img[src*="captcha"]').attr("src");
        const captchaUrl = captchaImg
          ? captchaImg.startsWith("http") ? captchaImg : `${base}/${captchaImg}`
          : null;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "captcha_manual_required",
                message: "Auto CAPTCHA solve failed. Please solve manually.",
                auto_solve_error: err.message,
                captcha_url: captchaUrl,
                session_token: page.cookies.join("; "),
                portal_url: url,
              }),
            },
          ],
        };
      }
    }

    const formData = {
      case_type_id: caseTypeInfo.id,
      case_no: case_number,
      case_year: case_year,
      captcha: captcha_answer || "",
      submit: "Search",
    };

    const result = await fetchPostForm(url, formData, session_token);
    const $ = cheerio.load(result.html);

    // Check if CAPTCHA was rejected
    const errorText = $(".alert-danger, .error, .text-danger").text().trim();
    if (errorText.toLowerCase().includes("captcha") || errorText.toLowerCase().includes("invalid")) {
      try {
        const retry = await solveCourtCaptcha(url, base, { maxAttempts: 2 });
        const retryResult = await fetchPostForm(url, { ...formData, captcha: retry.captchaAnswer }, retry.sessionToken);
        const $r = cheerio.load(retryResult.html);
        const retryErr = $r(".alert-danger, .error, .text-danger").text().trim();
        if (!retryErr.toLowerCase().includes("captcha") && !retryErr.toLowerCase().includes("invalid")) {
          return parseCaseHistory($r, case_type, case_number, case_year, bench);
        }
      } catch (_) {}
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "captcha_failed",
              error: "CAPTCHA auto-solve was rejected. Please solve manually.",
              portal_url: url,
            }),
          },
        ],
      };
    }

    return parseCaseHistory($, case_type, case_number, case_year, bench);
  }
);

/** Parse case history response HTML */
function parseCaseHistory($, case_type, case_number, case_year, bench) {
  const history = [];
  const iAs = [];

  $("table").each((i, table) => {
    const rows = parseTable($, table);
    const header = rows[0]?.map((h) => h.toLowerCase()) || [];

    if (header.some((h) => h.includes("listing") || h.includes("hearing") || h.includes("date"))) {
      rows.slice(1).forEach((row) => {
        history.push({
          date: row[0],
          court: row[1],
          coram: row[2],
          purpose: row[3],
          order: row[4],
        });
      });
    } else if (header.some((h) => h.includes("ia") || h.includes("interlocutory") || h.includes("application"))) {
      rows.slice(1).forEach((row) => {
        iAs.push({
          ia_number: row[0],
          type: row[1],
          filed_on: row[2],
          status: row[3],
        });
      });
    }
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          case_ref: `${case_type.toUpperCase()} No. ${case_number} of ${case_year}`,
          bench: bench === "lucknow" ? "Lucknow" : "Allahabad",
          listing_history: history,
          interlocutory_applications: iAs,
          total_hearings: history.length,
          total_ias: iAs.length,
        }, null, 2),
      },
    ],
  };
}

// ─── TOOL 9: get_court_view ─────────────────────────────────────────

server.tool(
  "get_court_view",
  "Fetch the live Court View display board data — shows which cases are currently being heard in which courtroom. Data auto-refreshes on the court portal every 30 seconds.",
  {
    bench: z
      .enum(["allahabad", "lucknow"])
      .default("allahabad")
      .describe("Which bench to query"),
  },
  async ({ bench }) => {
    const url = bench === "lucknow" ? COURT_VIEW_LKO : COURT_VIEW_ALD;

    const page = await fetchPage(url);
    const $ = cheerio.load(page.html);

    const courtRooms = [];
    $("table").each((i, table) => {
      const rows = parseTable($, table);
      if (rows.length > 0) {
        // Each table typically represents a court room or section
        const header = rows[0];
        rows.slice(1).forEach((row) => {
          courtRooms.push({
            court_no: row[0] || header[0],
            bench: row[1],
            case_ref: row[2],
            parties: row[3],
            item_no: row[4],
            status: row[5],
          });
        });
      }
    });

    // Try extracting court room cards/divs (court view may use divs instead of tables)
    const courtCards = [];
    $(".courtroom, .court-card, [class*=court], div[id*=court]").each((i, el) => {
      courtCards.push({
        id: $(el).attr("id"),
        text: $(el).text().trim().slice(0, 300),
      });
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            bench: bench === "lucknow" ? "Lucknow Bench" : "Allahabad (Principal Seat)",
            url,
            timestamp: new Date().toISOString(),
            court_rooms: courtRooms.slice(0, 50),
            court_cards: courtCards.slice(0, 30),
            auto_refresh: "30 seconds on the portal",
            note: "The Court View system shows real-time data. If court_rooms is empty, the court may not be in session, or the page structure may have changed. Use the url to view directly in browser.",
          }, null, 2),
        },
      ],
    };
  }
);

// ─── TOOL 10: get_justice_clock ─────────────────────────────────────

server.tool(
  "get_justice_clock",
  "Fetch the Justice Clock data from the Allahabad High Court — shows real-time case disposal and institution statistics by bench. Useful for tracking court efficiency and workload.",
  {},
  async () => {
    const url = `${BASE_URL}/jclock.html`;
    const page = await fetchPage(url);
    const $ = cheerio.load(page.html);

    // Justice Clock typically shows stats in tables or styled divs
    const stats = [];
    $("table").each((i, table) => {
      const rows = parseTable($, table);
      rows.forEach((row) => {
        if (row.length >= 2) {
          stats.push({ label: row[0], value: row[1], extra: row[2] });
        }
      });
    });

    // Extract any prominent numbers/text
    const highlights = [];
    $(".count, .number, .stat, [class*=clock], [class*=counter], h1, h2, h3, strong, b").each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.length < 100) highlights.push(text);
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "Allahabad High Court — Justice Clock",
            url,
            stats,
            highlights: [...new Set(highlights)].slice(0, 30),
            note: "The Justice Clock shows institution vs disposal statistics. If stats are empty, the page may use JavaScript rendering — visit the url directly for full data.",
          }, null, 2),
        },
      ],
    };
  }
);

// ─── RESOURCE: Court Information ────────────────────────────────────

server.resource(
  "court-info",
  "allahabad-hc://info",
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/plain",
        text: JSON.stringify({
          name: "Allahabad High Court",
          established: 1866,
          jurisdiction: "State of Uttar Pradesh",
          principal_seat: "Prayagraj (Allahabad)",
          bench: "Lucknow Bench",
          website: BASE_URL,
          ccms_allahabad: CCMS_ALD,
          ccms_lucknow: CCMS_LKO,
          court_view: { allahabad: COURT_VIEW_ALD, lucknow: COURT_VIEW_LKO },
          elegalix: ELEGALIX,
          case_types: CASE_TYPES,
          holidays_2026: COURT_HOLIDAYS_2026,
          vacations_2026: COURT_VACATIONS_2026,
        }, null, 2),
      },
    ],
  })
);

// ─── RESOURCE: Case Types Reference ─────────────────────────────────

server.resource(
  "case-types",
  "allahabad-hc://case-types",
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/plain",
        text: JSON.stringify(
          Object.entries(CASE_TYPES).map(([code, info]) => ({
            code,
            name: info.name,
            id: info.id,
          })),
          null,
          2
        ),
      },
    ],
  })
);

// ─── START ──────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Allahabad HC MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
