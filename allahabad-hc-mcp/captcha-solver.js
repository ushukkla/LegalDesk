/**
 * ═══════════════════════════════════════════════════════════════════════
 *  CAPTCHA Solver — Tesseract OCR with Image Preprocessing
 *  Solves simple text CAPTCHAs from the Allahabad HC CCMS portal
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  Pipeline:
 *    1. Fetch CAPTCHA image from court portal
 *    2. Preprocess with sharp (grayscale → contrast → threshold → denoise)
 *    3. Run Tesseract OCR on the cleaned image
 *    4. Post-process text (strip whitespace, fix common OCR errors)
 *    5. Return solved text + confidence score
 *
 *  Retry logic:
 *    - Up to 3 attempts with fresh CAPTCHA each time
 *    - Falls back to manual solve if all attempts fail
 */

import Tesseract from "tesseract.js";
import sharp from "sharp";

// ─────────────────────────────────────────────────────────────────────
// IMAGE PREPROCESSING
// ─────────────────────────────────────────────────────────────────────

/**
 * Preprocess a CAPTCHA image buffer for better OCR accuracy.
 * Applies multiple strategies and returns all variants for best-of-N.
 */
async function preprocessImage(imageBuffer) {
  const variants = [];

  // Strategy 1: High-contrast grayscale + threshold
  try {
    const v1 = await sharp(imageBuffer)
      .grayscale()
      .normalize()           // auto-contrast stretch
      .sharpen({ sigma: 1.5 })
      .threshold(140)        // binarize at 140/255
      .negate()              // invert if white-on-black
      .toBuffer();
    variants.push({ name: "high_contrast_inverted", buffer: v1 });
  } catch (_) {}

  // Strategy 2: Standard grayscale + moderate threshold (no invert)
  try {
    const v2 = await sharp(imageBuffer)
      .grayscale()
      .normalize()
      .sharpen({ sigma: 1 })
      .threshold(128)
      .toBuffer();
    variants.push({ name: "standard_threshold", buffer: v2 });
  } catch (_) {}

  // Strategy 3: Aggressive denoise + low threshold
  try {
    const v3 = await sharp(imageBuffer)
      .grayscale()
      .median(3)             // median filter removes salt-and-pepper noise
      .normalize()
      .threshold(100)
      .toBuffer();
    variants.push({ name: "denoised_low_thresh", buffer: v3 });
  } catch (_) {}

  // Strategy 4: Resize up 2x (helps with small CAPTCHAs) + threshold
  try {
    const metadata = await sharp(imageBuffer).metadata();
    const v4 = await sharp(imageBuffer)
      .resize(metadata.width * 2, metadata.height * 2, {
        kernel: sharp.kernel.lanczos3,
      })
      .grayscale()
      .normalize()
      .sharpen({ sigma: 2 })
      .threshold(130)
      .toBuffer();
    variants.push({ name: "upscaled_2x", buffer: v4 });
  } catch (_) {}

  // Strategy 5: Raw grayscale (no threshold — let Tesseract decide)
  try {
    const v5 = await sharp(imageBuffer)
      .grayscale()
      .normalize()
      .sharpen({ sigma: 1.5 })
      .toBuffer();
    variants.push({ name: "raw_grayscale", buffer: v5 });
  } catch (_) {}

  return variants;
}

// ─────────────────────────────────────────────────────────────────────
// TEXT POST-PROCESSING
// ─────────────────────────────────────────────────────────────────────

/**
 * Clean up OCR output — fix common misreads for CAPTCHA text.
 * Court CAPTCHAs are typically 4-6 alphanumeric characters.
 */
function cleanCaptchaText(raw) {
  let text = raw
    .replace(/\s+/g, "")     // remove all whitespace
    .replace(/[^a-zA-Z0-9]/g, "")  // keep only alphanumeric
    .trim();

  // Common OCR substitution fixes
  const fixes = {
    O: "0", o: "0",   // O → 0 (if context suggests number)
    l: "1", I: "1",   // l/I → 1
    S: "5", s: "5",   // S → 5
    B: "8",            // B → 8
    Z: "2",            // Z → 2
    G: "6",            // G → 6
  };

  // Only apply number fixes if the CAPTCHA looks mostly numeric
  const digitCount = (text.match(/\d/g) || []).length;
  const letterCount = (text.match(/[a-zA-Z]/g) || []).length;

  if (digitCount > letterCount) {
    // Likely a numeric CAPTCHA — convert ambiguous letters to digits
    text = text
      .split("")
      .map((ch) => fixes[ch] || ch)
      .join("");
  }

  return text;
}

/**
 * Score how likely an OCR result is a valid CAPTCHA answer.
 * Court CAPTCHAs are typically 4-6 characters, alphanumeric.
 */
function scoreCaptchaResult(text, confidence) {
  let score = confidence;

  // Penalize unusual lengths
  if (text.length < 3) score -= 30;
  if (text.length > 8) score -= 20;
  if (text.length >= 4 && text.length <= 6) score += 10;

  // Bonus for clean alphanumeric
  if (/^[a-zA-Z0-9]+$/.test(text)) score += 5;

  return Math.max(0, Math.min(100, score));
}

// ─────────────────────────────────────────────────────────────────────
// CORE SOLVER
// ─────────────────────────────────────────────────────────────────────

/**
 * Solve a CAPTCHA from its image buffer.
 * Tries multiple preprocessing strategies, picks the best result.
 *
 * @param {Buffer} imageBuffer - Raw image bytes (PNG/JPEG)
 * @returns {{ text: string, confidence: number, strategy: string }}
 */
async function solveCaptchaFromBuffer(imageBuffer) {
  const variants = await preprocessImage(imageBuffer);

  if (variants.length === 0) {
    throw new Error("Image preprocessing failed — no variants produced");
  }

  const results = [];

  for (const variant of variants) {
    try {
      const { data } = await Tesseract.recognize(variant.buffer, "eng", {
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
        tessedit_pageseg_mode: "7",  // single line of text
      });

      const cleaned = cleanCaptchaText(data.text);
      const score = scoreCaptchaResult(cleaned, data.confidence);

      results.push({
        text: cleaned,
        rawText: data.text.trim(),
        confidence: data.confidence,
        score,
        strategy: variant.name,
      });
    } catch (_) {
      // Skip failed variants
    }
  }

  if (results.length === 0) {
    throw new Error("OCR failed on all preprocessing variants");
  }

  // Sort by score descending, pick the best
  results.sort((a, b) => b.score - a.score);
  const best = results[0];

  return {
    text: best.text,
    confidence: best.confidence,
    score: best.score,
    strategy: best.strategy,
    allResults: results.map((r) => ({
      text: r.text,
      score: r.score,
      strategy: r.strategy,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
// HIGH-LEVEL: FETCH + SOLVE
// ─────────────────────────────────────────────────────────────────────

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * Fetch a CAPTCHA image from a URL and solve it.
 *
 * @param {string} captchaUrl - Direct URL to the CAPTCHA image
 * @param {string} [sessionCookie] - Session cookie to include in the request
 * @returns {{ text: string, confidence: number, strategy: string }}
 */
async function fetchAndSolveCaptcha(captchaUrl, sessionCookie) {
  const headers = { "User-Agent": UA };
  if (sessionCookie) headers.Cookie = sessionCookie;

  const resp = await fetch(captchaUrl, {
    headers,
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch CAPTCHA image: HTTP ${resp.status}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  const imageBuffer = Buffer.from(arrayBuffer);

  return solveCaptchaFromBuffer(imageBuffer);
}

/**
 * Full CAPTCHA solve flow for court portal pages:
 *   1. Fetch the search page to get CAPTCHA image URL + session cookie
 *   2. Fetch and solve the CAPTCHA image
 *   3. Return { sessionToken, captchaAnswer, confidence }
 *
 * Retries up to `maxAttempts` times with a fresh CAPTCHA each attempt.
 *
 * @param {string} pageUrl - URL of the search page with the CAPTCHA form
 * @param {string} baseUrl - Base URL prefix for resolving relative CAPTCHA src
 * @param {object} options - { maxAttempts: number }
 * @returns {{ sessionToken: string, captchaAnswer: string, confidence: number, attempts: number }}
 */
async function solveCourtCaptcha(pageUrl, baseUrl, options = {}) {
  const maxAttempts = options.maxAttempts || 3;
  const errors = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Step 1: Fetch the page to get the CAPTCHA image + session
      const resp = await fetch(pageUrl, {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
        },
        signal: AbortSignal.timeout(15000),
      });

      const html = await resp.text();
      const setCookies = resp.headers.getSetCookie?.() || [];
      const sessionToken = setCookies.join("; ");

      // Step 2: Extract CAPTCHA image URL from HTML
      const captchaMatch = html.match(/<img[^>]+src=["']([^"']*captcha[^"']*)["']/i);
      if (!captchaMatch) {
        errors.push(`Attempt ${attempt}: No CAPTCHA image found on page`);
        continue;
      }

      let captchaUrl = captchaMatch[1];
      if (!captchaUrl.startsWith("http")) {
        captchaUrl = `${baseUrl}/${captchaUrl.replace(/^\//, "")}`;
      }

      // Step 3: Fetch and solve the CAPTCHA
      const solution = await fetchAndSolveCaptcha(captchaUrl, sessionToken);

      // Step 4: Validate — only accept if confidence is reasonable
      if (solution.text.length < 3) {
        errors.push(`Attempt ${attempt}: OCR result too short ("${solution.text}")`);
        continue;
      }

      if (solution.confidence < 20) {
        errors.push(`Attempt ${attempt}: Confidence too low (${solution.confidence.toFixed(1)}%)`);
        continue;
      }

      return {
        sessionToken,
        captchaAnswer: solution.text,
        confidence: solution.confidence,
        score: solution.score,
        strategy: solution.strategy,
        attempts: attempt,
        allResults: solution.allResults,
      };
    } catch (err) {
      errors.push(`Attempt ${attempt}: ${err.message}`);
    }
  }

  // All attempts failed
  throw new Error(
    `CAPTCHA auto-solve failed after ${maxAttempts} attempts.\nErrors:\n${errors.join("\n")}`
  );
}

export { solveCaptchaFromBuffer, fetchAndSolveCaptcha, solveCourtCaptcha, cleanCaptchaText };
