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

    const prompt = `You are a strict hiring evaluator. Your job is to assess whether a candidate would realistically pass an initial recruiter screen for each role.

## CANDIDATE RESUME
${resumeText.slice(0, 3500)}

## JOB POSTINGS
${postingsJson}

## HOW TO EVALUATE

### Step 1 — Identify what the role actually requires
For each job, extract:
- Core requirements: skills/experience explicitly marked as required, essential, or must-have — or clearly central to the role's function
- Nice-to-haves: beneficial but not blocking

### Step 2 — Honestly assess the candidate against those requirements
- Direct match: candidate has demonstrably done this before
- Adjacent match: candidate has done something meaningfully similar but not identical — only counts for nice-to-haves, NOT for core requirements
- Gap: candidate has no relevant evidence

IMPORTANT: Adjacent or transferable skills can ONLY compensate for missing nice-to-haves. They do NOT compensate for missing core requirements. If a role requires a specific technical skill and the candidate has never done it, that is a gap — even if they work in a related field.

### Step 3 — Score
- Skills match (40pts): % of core requirements directly met × 30pts, plus up to 10pts for nice-to-haves
- Experience level (25pts): full if meets/exceeds required years, scaled down if below
- Role alignment (20pts): how closely the candidate's past roles match this role's function
- Domain fit (15pts): industry/sector match

HARD CAPS:
- Under 40% of core requirements directly met → max score 50
- Candidate seniority 2+ levels below role → max score 45
- No relevant experience in the role's core function → max score 40

PENALTIES (subtract after scoring):
- Each missing core requirement → -10 to -20 depending on centrality
- Overqualified by 2+ levels → -10

### Step 4 — Calibrate
- 85-100: Exceptional fit — candidate meets nearly all requirements directly
- 70-84: Strong fit — meets most requirements, minor gaps
- 55-69: Plausible — meets some requirements, notable gaps
- 40-54: Long shot — significant gaps in core requirements
- Below 40: Poor fit — fundamental mismatch

Be conservative and honest. Do not inflate scores because the candidate works in a broadly related field. A score above 80 should be rare and well-justified.

RECOMMENDATION:
- "Apply" = score >= 70 and no missing core requirements
- "Maybe" = score 45-69 or 1-2 gaps that could be addressed
- "Skip" = score < 45 or multiple missing core requirements

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
