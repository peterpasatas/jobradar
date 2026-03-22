// config.js — all API calls go through Vercel API functions, keys are server-side only
const CONFIG = {
  SUPABASE_URL:  'https://tfeuzkbxezahbdhxqnxt.supabase.co',
  SUPABASE_ANON: 'sb_publishable_jB2LDhCIsQMsnqkbCvYO4Q_tr6HescW',
};

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
  try {
    const res = await fetch('/api/fetch-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, country, results, maxDaysOld }),
    });
    if (!res.ok) throw new Error(`Function error: ${res.status}`);
    const data = await res.json();
    return data.results || [];
  } catch(e) {
    console.warn(`fetch-jobs [${country}] "${query}": ${e.message}`);
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

// Maps country names to SerpAPI gl/hl/location params
const SERP_COUNTRY_MAP = {
  'United Kingdom':  { gl: 'gb', hl: 'en', location: 'London, England, United Kingdom' },
  'Germany':         { gl: 'de', hl: 'de', location: 'Berlin, Germany' },
  'Spain':           { gl: 'es', hl: 'es', location: 'Madrid, Spain' },
  'Portugal':        { gl: 'pt', hl: 'pt', location: 'Lisbon, Portugal' },
  'Belgium':         { gl: 'be', hl: 'en', location: 'Brussels, Belgium' },
  'Luxembourg':      { gl: 'lu', hl: 'en', location: 'Luxembourg City, Luxembourg' },
  'Switzerland':     { gl: 'ch', hl: 'en', location: 'Zurich, Switzerland' },
  'Netherlands':     { gl: 'nl', hl: 'nl', location: 'Amsterdam, Netherlands' },
  'France':          { gl: 'fr', hl: 'fr', location: 'Paris, France' },
  'Remote':          { gl: 'gb', hl: 'en', location: 'London, England, United Kingdom' },
};

async function fetchSerpJobs(query, location, gl = 'gb', hl = 'en', dateRange = '3days') {
  try {
    const res = await fetch('/api/fetch-serp-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, location, gl, hl, dateRange }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.debug) console.log(`SerpAPI debug [${location}] "${query}":`, data.debug);
    if (data.debug?.serpapi_error) console.error('SerpAPI error:', data.debug.serpapi_error);
    return data.results || [];
  } catch(e) {
    console.warn(`SerpAPI "${query}" in ${location}: ${e.message}`);
    return [];
  }
}

async function collectSerpJobs(queries, locations, countries, dateRange = '3days', onProgress) {
  // locations = cities if provided, otherwise country names
  // countries = used for gl/hl localisation params
  const unique = new Map();
  let skipped = 0;
  const total = queries.length * locations.length;
  let done = 0;

  for (const location of locations) {
    // Find matching country params for this location
    // Try exact country match first, then default to gb
    const countryName = countries.find(c =>
      location.toLowerCase().includes(c.toLowerCase().split(' ')[0].toLowerCase())
    ) || countries[0] || 'United Kingdom';
    const params = SERP_COUNTRY_MAP[countryName] || { gl: 'gb', hl: 'en' };

    for (const query of queries) {
      const raw = await fetchSerpJobs(query, location, params.gl, params.hl, dateRange);
      for (const job of raw) {
        if (!job.id || unique.has(job.id)) continue;
        if (isExcluded(job)) { skipped++; continue; }
        unique.set(job.id, job);
      }
      done++;
      onProgress && onProgress(done, total, `[${location}] "${query}"`);
      await sleep(500);
    }
  }
  return { jobs: [...unique.values()], skipped };
}

async function scoreJobsWithGemini(jobs, resumeText, onProgress) {
  // Process jobs 1 by 1, 2 concurrently
  const CONCURRENCY = 2;
  const allScored = new Array(jobs.length).fill(null);
  let completed = 0;

  async function scoreOne(job, index) {
    const res = await fetch('/api/score-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobs: [job], resumeText }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const scored = data.scored || [];
    if (scored[0]) scored[0].index = index;
    return scored[0] || null;
  }

  // Process in groups of CONCURRENCY
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const group = jobs.slice(i, i + CONCURRENCY);
    const promises = group.map((job, offset) => scoreOne(job, i + offset));
    const results = await Promise.all(promises);
    results.forEach((r, offset) => { if (r) allScored[i + offset] = r; });
    completed += group.length;
    const pct = Math.round((completed / jobs.length) * 100);
    onProgress && onProgress(pct, completed, jobs.length);
    if (i + CONCURRENCY < jobs.length) await sleep(500);
  }

  return allScored.filter(Boolean);
}
