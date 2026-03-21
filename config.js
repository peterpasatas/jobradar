// config.js — shared across all pages
const CONFIG = {
  SUPABASE_URL:   'https://tfeuzkbxezahbdhxqnxt.supabase.co',
  SUPABASE_ANON:  'sb_publishable_jB2LDhCIsQMsnqkbCvYO4Q_tr6HescW',
  ADZUNA_APP_ID:  'd5e5065a',
  ADZUNA_APP_KEY: '0c3086e428c2726d739ffe8c556fafa5',
  GEMINI_API_KEY: 'AIzaSyB3j5wZD5MU_Epv2ejcDGaaNqLLDC6elok',
  GEMINI_MODEL:   'gemini-2.5-flash-lite',
};

const CORS_PROXIES = [
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
];

async function fetchWithProxy(url) {
  let lastErr;
  for (const proxyFn of CORS_PROXIES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(proxyFn(url), { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text || text.trim() === '' || text.trim() === 'null') throw new Error('Empty response');
      const parsed = JSON.parse(text);
      if (parsed && parsed.contents) return JSON.parse(parsed.contents);
      return parsed;
    } catch(e) {
      lastErr = e;
      await sleep(500);
    }
  }
  throw new Error(`All proxies failed: ${lastErr.message}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isExcluded(job) {
  const title    = (job.title || '').toLowerCase();
  const contract = (job.contract_type || '').toLowerCase();
  const contractKw = ['contract','contractor','freelance','fixed term','fixed-term'];
  const juniorKw   = ['junior','graduate','entry level','entry-level','trainee','intern'];
  return contractKw.some(k => contract.includes(k))
      || contractKw.some(k => title.includes(k))
      || juniorKw.some(k => title.includes(k));
}

function normaliseJob(job) {
  const company  = job.company  || {};
  const location = job.location || {};
  const area     = location.area || [];
  return {
    id:          String(job.id || Math.random()),
    title:       job.title || 'N/A',
    company:     (typeof company === 'object' ? company.display_name : company) || 'N/A',
    location:    area.length ? area.join(', ') : (location.display_name || 'N/A'),
    description: (job.description || '').slice(0, 2500),
    url:         job.redirect_url || '',
    salary_min:  job.salary_min || null,
    salary_max:  job.salary_max || null,
  };
}

async function fetchAdzunaJobs(query, country, results = 50, maxDaysOld = 15) {
  const maxAge = maxDaysOld * 86400; // Adzuna uses max_days_old in seconds
  const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?app_id=${CONFIG.ADZUNA_APP_ID}&app_key=${CONFIG.ADZUNA_APP_KEY}&what=${encodeURIComponent(query)}&results_per_page=${results}&max_days_old=${maxDaysOld}`;
  try {
    const data = await fetchWithProxy(url);
    return data.results || [];
  } catch(e) {
    console.warn(`Adzuna [${country}] "${query}": ${e.message}`);
    return [];
  }
}

async function collectJobs(queries, countries, resultsPerQuery = 50, maxDaysOld = 15, onProgress) {
  const unique = new Map();
  let skipped = 0;
  const total = queries.length * countries.length;
  let done = 0;

  for (const country of countries) {
    for (const query of queries) {
      const raw = await fetchAdzunaJobs(query, country, resultsPerQuery, maxDaysOld);
      for (const job of raw) {
        const id = String(job.id || '');
        if (!id || unique.has(id)) continue;
        if (isExcluded(job)) { skipped++; continue; }
        unique.set(id, normaliseJob(job));
      }
      done++;
      onProgress && onProgress(done, total, `[${country.toUpperCase()}] "${query}"`);
      await sleep(300);
    }
  }
  return { jobs: [...unique.values()], skipped };
}

async function scoreJobsWithGemini(jobs, resumeText, onProgress) {
  const postingsJson = JSON.stringify(jobs.map((j, i) => ({
    index: i, title: j.title, company: j.company,
    location: j.location, description: j.description,
  })), null, 2);

  const prompt = `You are an expert career advisor and hiring evaluator.

Your task is to evaluate how well a candidate fits multiple job postings using a structured, consistent, and explainable scoring framework.

You must follow the exact evaluation process below. Do not skip steps.

---

## INPUTS

### CANDIDATE RESUME
${resumeText.slice(0, 3500)}

### JOB POSTINGS
${postingsJson}

---

## OVERALL GOAL

For each job, estimate the candidate's likelihood of being a competitive applicant (i.e., passing an initial recruiter screen), based on:
- Skills match
- Experience level
- Role alignment
- Domain/industry fit
- Presence/absence of critical requirements

You are NOT optimising for keyword overlap.
You ARE optimising for real-world hiring likelihood.

---

## DEFINITIONS

### Core (Must-Have) Requirements
Skills, tools, or qualifications explicitly required using phrases like "required", "must have", "essential", or clearly central to the role.

### Secondary (Nice-to-Have) Requirements
Skills that are beneficial but not mandatory.

### Adjacent Fit
A candidate is considered adjacent if:
- They have used similar tools in a different domain
- They have performed similar responsibilities under a different title
- They demonstrate transferable skills (e.g., data analysis → business analysis)

---

## STEP 1: EXTRACT JOB FEATURES

For each job, extract:
- extracted_title: normalised role title
- seniority_level: one of ["Junior", "Mid", "Senior", "Lead", "Principal", "Unknown"]
- required_skills: 3–8 core skills/tools (must-have only)
- optional_skills: 2–6 secondary skills
- inferred_experience_years: use stated number if explicit, otherwise infer: Junior→1, Mid→4, Senior→8, Lead/Principal→10, Unknown→0
- domain: industry or problem space
- key_responsibilities: 2–4 concise phrases

---

## STEP 2: EXTRACT CANDIDATE FEATURES

From the resume, infer:
- candidate_skills: normalised list of skills/tools
- candidate_seniority: ["Junior", "Mid", "Senior", "Lead", "Principal", "Unknown"]
- candidate_experience_years: estimated total relevant experience
- candidate_domains: industries worked in
- candidate_roles: past role types

If information is missing or truncated, make conservative assumptions.

---

## STEP 3: HARD FILTER (ELIGIBILITY CHECK)

Apply BEFORE scoring:
1. If candidate is missing most core required_skills (less than 40% match) → cap score at 50
2. If candidate seniority is 2+ levels below required → cap score at 45
3. If role is clearly unrelated to candidate's domain AND no transferable skills → cap score at 40

---

## STEP 4: SCORING (0–100 TOTAL)

### 1. Skills Match (0–40)
- 30 pts: proportion of required_skills matched
- 10 pts: adjacent/transferable skills

### 2. Experience Level (0–25)
- Full points if candidate meets/exceeds inferred_experience_years
- Partial if slightly below
- Low if significantly below

### 3. Role Alignment (0–20)
- Same role/function → high
- Adjacent role → medium
- Different function → low

### 4. Domain Fit (0–15)
- Same domain → high
- Adjacent domain → medium
- Unrelated → low

---

## STEP 5: PENALTIES

Apply AFTER base scoring:
- Missing a critical required skill → subtract 10–25 points
- Overqualification (2+ levels above role) → subtract up to 10
- Vague job description → reduce confidence, do NOT inflate score

Ensure final score is between 0–100. Apply caps from STEP 3 if applicable.

---

## STEP 6: SCORE CALIBRATION

- 90–100 → very likely to pass recruiter screen
- 75–89 → strong candidate with minor gaps
- 60–74 → plausible but not competitive
- 40–59 → long shot
- <40 → unlikely

Use this scale consistently across ALL jobs.

---

## STEP 7: RECOMMENDATION

- "Apply" → score ≥ 70 AND no major missing core requirements
- "Maybe" → score 45–69 OR some gaps but plausible
- "Skip" → score < 45 OR fails hard filters

---

## STEP 8: OUTPUT FORMAT

For EVERY job return EXACTLY this JSON structure:
{
  "index": integer,
  "extracted_title": string,
  "skills": array of 5–10 normalised skills (prioritise required_skills),
  "experience_years": integer,
  "summary": "1–2 sentence role description",
  "relevance_score": integer (0–100),
  "recommendation": "Apply" | "Maybe" | "Skip"
}

---

## CRITICAL RULES

- Return ONLY a valid JSON array with exactly ${jobs.length} objects
- No markdown, no explanation, no extra text
- Internally follow all steps but DO NOT output reasoning
- Be consistent across all jobs (calibrated scoring)
- Avoid keyword matching bias — focus on actual capability alignment
- Be conservative when uncertain (do not over-score)

---

Evaluate all ${jobs.length} jobs now using this framework.`;

  onProgress && onProgress(`Sending ${jobs.length} jobs to Gemini…`);

  let attempt = 0;
  while (true) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    if (res.status === 429 && attempt < 4) {
      attempt++;
      const wait = attempt * 20;
      onProgress && onProgress(`Rate limited — waiting ${wait}s (retry ${attempt}/4)…`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    raw = raw.replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
    return JSON.parse(raw);
  }
}
