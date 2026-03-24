// api/fetch-serp-jobs.js
// Calls SerpAPI Google Jobs endpoint server-side — key never exposed to browser
// Free tier: 250 searches/month
// Pagination uses next_page_token (start param deprecated by Google)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { query, location, gl = 'gb', hl = 'en', dateRange = '3days', next_page_token = null } = req.body;

    if (!query || !location) {
      return res.status(400).json({ error: 'query and location are required' });
    }

    const strictQuery = `${query} ${location}`;
    const url = new URL('https://serpapi.com/search');
    url.searchParams.set('engine',   'google_jobs');
    url.searchParams.set('q',        strictQuery);
    url.searchParams.set('location', location);
    url.searchParams.set('gl',       gl);
    url.searchParams.set('hl',       hl);
    url.searchParams.set('ltype',    'l');
    if (next_page_token) {
      url.searchParams.set('next_page_token', next_page_token);
    }
    const dateMap = { today: 'today', '3days': '3days', week: 'week' };
    const datePart = dateMap[dateRange] || '3days';
    url.searchParams.set('chips', `date_posted:${datePart},employment_type:FULLTIME`);
    url.searchParams.set('api_key', process.env.SERPAPI_KEY);

    const response = await fetch(url.toString());

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `SerpAPI error: ${err.slice(0, 200)}` });
    }

    const data = await response.json();

    if (data.error) console.error('SerpAPI error field:', data.error);

    const jobs = (data.jobs_results || []).map(job => normaliseJob(job));

    return res.status(200).json({
      results: jobs,
      next_page_token: data.serpapi_pagination?.next_page_token || null,
      debug: {
        total_found: data.jobs_results?.length ?? 0,
        serpapi_error: data.error || null,
        has_next_page: !!data.serpapi_pagination?.next_page_token,
      }
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function normaliseJob(job) {
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
    via:         job.via || '',
    posted_at:   extensions.posted_at || 'Today',
    source:      'google_jobs',
  };
}
