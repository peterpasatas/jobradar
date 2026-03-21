// config.js — shared across all pages
const CONFIG = {
  SUPABASE_URL:   'https://tfeuzkbxezahbdhxqnxt.supabase.co',
  SUPABASE_ANON:  'sb_publishable_jB2LDhCIsQMsnqkbCvYO4Q_tr6HescW',
  ADZUNA_APP_ID:  'd5e5065a',
  ADZUNA_APP_KEY: '0c3086e428c2726d739ffe8c556fafa5',
  GEMINI_API_KEY: 'AIzaSyAiP9oPXMIDOWRXs3RsdXcNDk50RBp0ygA',
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

async function fetchAdzunaJobs(query, country, results = 50) {
  const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?app_id=${CONFIG.ADZUNA_APP_ID}&app_key=${CONFIG.ADZUNA_APP_KEY}&what=${encodeURIComponent(query)}&results_per_page=${results}`;
  try {
    const data = await fetchWithProxy(url);
    return data.results || [];
  } catch(e) {
    console.warn(`Adzuna [${country}] "${query}": ${e.message}`);
    return [];
  }
}

async function collectJobs(queries, countries, onProgress) {
  const unique = new Map();
  let skipped = 0;
  const total = queries.length * countries.length;
  let done = 0;

  for (const country of countries) {
    for (const query of queries) {
      const raw = await fetchAdzunaJobs(query, country);
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

  const prompt = `You are an expert career advisor evaluating job-candidate fit.

## CANDIDATE RESUME
${resumeText.slice(0, 3000)}

## JOB POSTINGS
${postingsJson}

## TASK
For EVERY posting return a JSON object with EXACTLY these fields:
- index (integer — same as input)
- extracted_title (string)
- skills (array of strings — key skills/tools required by the role)
- experience_years (integer, 0 if not stated)
- summary (1-2 sentence string describing the role)
- relevance_score (integer 0-100; assess how well the candidate's actual experience, skills, and background match what this role requires — consider both direct and adjacent fit, not just keyword overlap)
- recommendation (EXACTLY one of: "Apply", "Maybe", "Skip")
  Apply = score >= 65, Maybe = 40-64, Skip = < 40

Return ONLY a valid JSON array with exactly ${jobs.length} objects. No markdown, no explanation.`;

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
