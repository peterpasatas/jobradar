// api/fetch-jobs.js
// Vercel serverless function — proxies Adzuna API, keys never exposed to browser
// Adzuna free tier caps at 10 results per page — we paginate to hit the requested count

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

    const perPage   = 10; // Adzuna free tier hard cap
    const pagesNeeded = Math.ceil(Math.min(results, 50) / perPage);
    const allResults = [];
    const seen = new Set();

    for (let page = 1; page <= pagesNeeded; page++) {
      const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`);
      url.searchParams.set('app_id',           process.env.ADZUNA_APP_ID);
      url.searchParams.set('app_key',          process.env.ADZUNA_APP_KEY);
      url.searchParams.set('what',             query);
      url.searchParams.set('results_per_page', String(perPage));
      url.searchParams.set('max_days_old',     String(maxDaysOld));

      const response = await fetch(url.toString());
      if (!response.ok) {
        // If first page fails, return error. Otherwise return what we have.
        if (page === 1) {
          return res.status(response.status).json({ error: `Adzuna error: ${response.status}` });
        }
        break;
      }

      const data = await response.json();
      const pageResults = data.results || [];

      for (const job of pageResults) {
        const key = String(job.id || job.title);
        if (seen.has(key)) continue;
        seen.add(key);
        allResults.push(job);
      }

      // Stop early if Adzuna returned fewer results than requested (end of listings)
      if (pageResults.length < perPage) break;

      // Stop if we have enough
      if (allResults.length >= results) break;
    }

    return res.status(200).json({ results: allResults });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
