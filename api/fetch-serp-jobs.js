// api/fetch-serp-jobs.js
// Calls SerpAPI Google Jobs endpoint server-side — key never exposed to browser
// Free tier: 250 searches/month
// Each call returns ~10 jobs for one keyword + location combination

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { query, location, gl = 'gb', hl = 'en', dateRange = '3days' } = req.body;

    if (!query || !location) {
      return res.status(400).json({ error: 'query and location are required' });
    }

    // Build SerpAPI URL
    // Embed location in query for strict city filtering — location param alone is just a bias
    const strictQuery = `${query} ${location}`;
    const url = new URL('https://serpapi.com/search');
    url.searchParams.set('engine',   'google_jobs');
    url.searchParams.set('q',        strictQuery);
    url.searchParams.set('location', location);
    url.searchParams.set('gl',       gl);
    url.searchParams.set('hl',       hl);
    url.searchParams.set('ltype',    'l');  // strict location filtering
    const dateMap = { today: 'today', '3days': '3days', week: 'week' };
    const datePart = dateMap[dateRange] || '3days';
    url.searchParams.set('chips', `date_posted:${datePart},employment_type:FULLTIME`);
    url.searchParams.set('api_key',  process.env.SERPAPI_KEY);

    const response = await fetch(url.toString());

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `SerpAPI error: ${err.slice(0, 200)}` });
    }

    const data = await response.json();

    // Log what SerpAPI returned for debugging
    console.log('SerpAPI response keys:', Object.keys(data));
    console.log('Jobs found:', data.jobs_results?.length ?? 0);
    if (data.error) console.error('SerpAPI error field:', data.error);

    const allJobs = (data.jobs_results || []).map(job => normaliseJob(job));

    // No platform or location filtering — return all results
    // Filtering is handled in the UI by the user
    const jobs = allJobs;
    console.log(`Total jobs returned: ${jobs.length}`);

    return res.status(200).json({
      results: jobs,
      debug: {
        total_found: data.jobs_results?.length ?? 0,
        serpapi_error: data.error || null,
        search_metadata: data.search_metadata?.status || null,
      }
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function normaliseJob(job) {
  // Extract salary if present in extensions
  const extensions = job.detected_extensions || {};

  return {
    id:          job.job_id || `serp_${Math.random().toString(36).slice(2)}`,
    title:       job.title || 'N/A',
    company:     job.company_name || 'N/A',
    location:    job.location || 'N/A',
    description: job.description || '',
    url:         job.apply_options?.[0]?.link || job.share_link || '',
    salary_min:  extensions.salary_min || null,
    salary_max:  extensions.salary_max || null,
    via:         job.via || '',              // e.g. "via LinkedIn", "via Indeed"
    posted_at:   extensions.posted_at || 'Today',
    source:      'google_jobs',
  };
}
