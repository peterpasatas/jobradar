// api/fetch-news.js
// Vercel serverless function — proxies NewsAPI, key never exposed to browser
// NewsAPI free tier: 100 requests/day, last 30 days of articles

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { query, category, country, pageSize = 20, page = 1 } = req.body;

    const url = new URL('https://newsapi.org/v2/top-headlines');

    // If query provided, use everything endpoint for keyword search across all sources
    if (query) {
      url.href = 'https://newsapi.org/v2/everything';
      url.searchParams.set('q', query);
      url.searchParams.set('language', 'en');
      url.searchParams.set('sortBy', 'publishedAt');
    } else {
      // Top headlines with optional category/country filters
      if (category) url.searchParams.set('category', category);
      if (country)  url.searchParams.set('country', country);
      else          url.searchParams.set('country', 'gb'); // default UK
    }

    url.searchParams.set('pageSize', pageSize);
    url.searchParams.set('page', page);
    url.searchParams.set('apiKey', process.env.NEWSAPI_KEY);

    const response = await fetch(url.toString());
    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `NewsAPI error: ${err.slice(0, 200)}` });
    }

    const data = await response.json();
    if (data.status === 'error') {
      return res.status(400).json({ error: data.message });
    }

    return res.status(200).json({
      articles: data.articles || [],
      totalResults: data.totalResults || 0,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
