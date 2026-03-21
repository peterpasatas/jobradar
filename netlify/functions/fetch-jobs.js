// netlify/functions/fetch-jobs.js
// Proxies Adzuna API calls server-side — keys never exposed to browser

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { query, country, results = 50, maxDaysOld = 15 } = JSON.parse(event.body || '{}');

    if (!query || !country) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'query and country are required' }) };
    }

    const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`);
    url.searchParams.set('app_id',           process.env.ADZUNA_APP_ID);
    url.searchParams.set('app_key',          process.env.ADZUNA_APP_KEY);
    url.searchParams.set('what',             query);
    url.searchParams.set('results_per_page', results);
    url.searchParams.set('max_days_old',     maxDaysOld);

    const res = await fetch(url.toString());
    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: `Adzuna error: ${res.status}` }) };
    }

    const data = await res.json();
    return { statusCode: 200, headers, body: JSON.stringify({ results: data.results || [] }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
