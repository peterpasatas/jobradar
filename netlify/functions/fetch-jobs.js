// api/fetch-jobs.js
// Vercel serverless function — proxies Adzuna API, keys never exposed to browser
// Free tier: 60 second timeout

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { query, country, results = 50, maxDaysOld = 15 } = req.body;

    if (!query || !country) {
      return res.status(400).json({ error: 'query and country are required' });
    }

    const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`);
    url.searchParams.set('app_id',           process.env.ADZUNA_APP_ID);
    url.searchParams.set('app_key',          process.env.ADZUNA_APP_KEY);
    url.searchParams.set('what',             query);
    url.searchParams.set('results_per_page', results);
    url.searchParams.set('max_days_old',     maxDaysOld);

    const response = await fetch(url.toString());
    if (!response.ok) {
      return res.status(response.status).json({ error: `Adzuna error: ${response.status}` });
    }

    const data = await response.json();
    return res.status(200).json({ results: data.results || [] });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
