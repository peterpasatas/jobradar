// api/score-jobs.js
// Vercel serverless function — proxies Gemini API, keys never exposed to browser
// Free tier: 60 second timeout (vs Netlify's 10s)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { jobs, resumeText } = req.body;

    if (!jobs || !resumeText) {
      return res.status(400).json({ error: 'jobs and resumeText are required' });
    }

    const postingsJson = JSON.stringify(jobs.map((j, i) => ({
      index: i, title: j.title, company: j.company,
      location: j.location, description: j.description,
    })), null, 2);

    const prompt = `You are a hiring evaluator. Score each job against the candidate resume below.

## CANDIDATE RESUME
${resumeText.slice(0, 3500)}

## JOB POSTINGS
${postingsJson}

## SCORING RULES
For each job, score 0-100 based on:
- Skills match (40pts): required skills matched vs missing. Award partial for adjacent/transferable skills.
- Experience level (25pts): full if candidate meets or exceeds years required, partial if slightly below.
- Role alignment (20pts): same function=high, adjacent=medium, different=low.
- Domain fit (15pts): same industry=high, adjacent=medium, unrelated=low.

HARD CAPS (apply before scoring):
- Under 40% of required skills matched → max 50
- Candidate 2+ seniority levels below role → max 45
- Completely unrelated domain, no transferable skills → max 40

PENALTIES (apply after scoring):
- Missing critical required skill → -10 to -25
- Overqualified by 2+ levels → -10

RECOMMENDATION:
- "Apply" = score >= 70 and no major skill gaps
- "Maybe" = score 45-69 or some gaps
- "Skip" = score < 45

Focus on real hiring likelihood, NOT keyword matching. Consider adjacent and transferable skills.

## OUTPUT
Return ONLY a JSON array with exactly ${jobs.length} objects, no markdown, no explanation:
[{"index":integer,"extracted_title":string,"skills":string[],"experience_years":integer,"summary":"1-2 sentences","relevance_score":integer,"recommendation":"Apply"|"Maybe"|"Skip"}]

Evaluate all ${jobs.length} jobs now.`;

    let attempt = 0;
    while (true) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );

      if (response.status === 429 && attempt < 3) {
        attempt++;
        await new Promise(r => setTimeout(r, attempt * 10000));
        continue;
      }

      if (!response.ok) {
        const err = await response.text();
        return res.status(response.status).json({ error: `Gemini ${response.status}: ${err.slice(0, 300)}` });
      }

      const data = await response.json();
      let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

      const arrayStart = raw.indexOf('[');
      const arrayEnd   = raw.lastIndexOf(']');
      if (arrayStart === -1 || arrayEnd === -1) {
        return res.status(500).json({ error: `No JSON array in Gemini response: ${raw.slice(0, 200)}` });
      }

      raw = raw.slice(arrayStart, arrayEnd + 1);

      let scored;
      try {
        scored = JSON.parse(raw);
      } catch(e) {
        return res.status(500).json({ error: `JSON parse failed: ${e.message}. Raw: ${raw.slice(0, 200)}` });
      }

      return res.status(200).json({ scored });
    }

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
