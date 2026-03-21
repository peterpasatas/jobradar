// config.js — all API calls go through Netlify functions, keys are server-side only
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
    const res = await fetch('/.netlify/functions/fetch-jobs', {
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

async function scoreJobsWithGemini(jobs, resumeText, onProgress) {
  const BATCH_SIZE = 20;
  const allScored  = [];
  const batches    = Math.ceil(jobs.length / BATCH_SIZE);

  for (let b = 0; b < batches; b++) {
    const start = b * BATCH_SIZE;
    const batch = jobs.slice(start, start + BATCH_SIZE);
    onProgress && onProgress(`Scoring jobs ${start + 1}–${start + batch.length} of ${jobs.length}…`);

    try {
      const res = await fetch('/.netlify/functions/score-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobs: batch, resumeText }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Function error: ${res.status}`);
      }

      const data = await res.json();
      const batchScored = data.scored || [];

      // Re-map indexes back to global positions
      batchScored.forEach(item => {
        if (item?.index != null) item.index = start + item.index;
      });

      allScored.push(...batchScored);
    } catch(e) {
      throw new Error(`Scoring failed (batch ${b + 1}/${batches}): ${e.message}`);
    }

    // Small pause between batches to avoid rate limiting
    if (b < batches - 1) await sleep(2000);
  }

  return allScored;
}
