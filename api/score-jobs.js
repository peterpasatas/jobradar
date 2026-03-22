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

    const prompt = `You are a hiring evaluator acting as a senior recruiter. Your role is to apply strict, evidence-based screening — not to be encouraging or optimistic.

## CANDIDATE RESUME
${resumeText.slice(0, 3500)}

## JOB POSTINGS
${postingsJson}

---

## EVALUATION PROTOCOL — follow every step exactly, no exceptions

### STEP 1 — Language check
If the job description is not in English: set score=0, recommendation="Skip", stop immediately.

### STEP 2 — Extract core requirements
Core requirements are ONLY those that meet at least one of:
- Listed under "Requirements", "Must-have", "Essential", "You will need", or equivalent heading
- Stated with "required", "must have", "essential", "proven experience in"
- Repeated 2+ times across the description
- Explicitly tied to daily responsibilities ("you will...", "responsible for...")

Everything else is a nice-to-have. When uncertain, classify as nice-to-have.

You MUST count:
- Total core requirements identified (integer)
- Core requirements with DIRECT matches from the resume (integer)
- Core match % = direct matches / total core requirements

### STEP 3 — Determine direct vs adjacent match

A DIRECT MATCH requires explicit evidence of hands-on implementation in a real work context.

These DO NOT count as direct matches under any circumstances:
- "Basic" or beginner-level skills (e.g. "Python (Basic)")
- Low-code or no-code tools used as a substitute for engineering skills (e.g. Power Platform, Copilot Studio, Power Automate do NOT satisfy backend/software engineering requirements)
- Conceptual knowledge, workshop delivery, training, or enablement activities
- Using AI tools (e.g. prompting, Copilot) does NOT satisfy AI engineering requirements (RAG, MLOps, model evaluation, cloud AI infrastructure)
- Job titles or seniority alone without supporting evidence

Adjacent skills count ONLY toward nice-to-haves, never toward core requirements.

### STEP 4 — Apply hard caps (apply ALL that are triggered)
- Core match % < 40% → score cannot exceed 50
- Core match % < 60% → score cannot exceed 60
- Candidate seniority 2+ levels below required → score cannot exceed 45
- Role requires software/backend engineering, cloud infrastructure, or data engineering, and candidate has no direct evidence → score cannot exceed 55
- No relevant experience in the role's core function → score cannot exceed 40

### STEP 5 — Base scoring
Starting from 100, work downward:
- Skills match (max 40pts): (core match % × 30) + up to 10pts for nice-to-haves
- Experience level (max 25pts): full if meets/exceeds required years, pro-rated if below
- Role alignment (max 20pts): same function=20, adjacent=10, different=5
- Domain fit (max 15pts): same industry=15, adjacent=8, unrelated=3

### STEP 6 — Apply penalties (MANDATORY — do not skip)
You MUST apply a penalty for every missing core requirement. Do not reinterpret gaps as partial matches.
- Each missing core requirement: -10 to -20 depending on how central it is
- Total penalties for missing core requirements: capped at -40
- Overqualified by 2+ levels: -10

### STEP 7 — Sanity check (MANDATORY)
Before finalising any score above 75, verify both conditions are true:
1. Candidate directly meets at least 70% of core requirements
2. No major technical gaps exist in skills central to the role

If either condition fails, the score MUST be reduced below 75.

Before finalising any score above 85, verify:
1. Candidate directly meets nearly ALL core requirements
2. No gaps exist in any skills central to the role

If either condition fails, the score MUST be reduced below 85.

A score of 90+ should be exceptional and rare. If you are assigning 90+, you must be certain the candidate is outstanding for this specific role.

### STEP 8 — Recommendation
- "Apply" = score >= 70 AND core match % >= 60% AND no missing critical core requirements
- "Maybe" = score 45-69 OR core match % 40-59% OR 1-2 addressable gaps
- "Skip" = score < 45 OR core match % < 40% OR fundamental skill mismatch

---

## OUTPUT
Return ONLY a valid JSON array with exactly ${jobs.length} objects. No markdown, no explanation:
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
