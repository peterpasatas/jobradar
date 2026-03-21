// netlify/functions/score-jobs.js
// Calls Gemini API server-side — key never exposed to browser

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
    const { jobs, resumeText } = JSON.parse(event.body || '{}');

    if (!jobs || !resumeText) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'jobs and resumeText are required' }) };
    }

    const postingsJson = JSON.stringify(jobs.map((j, i) => ({
      index: i, title: j.title, company: j.company,
      location: j.location, description: j.description,
    })), null, 2);

    const prompt = `You are an expert career advisor and hiring evaluator.

Your task is to evaluate how well a candidate fits multiple job postings using a structured, consistent, and explainable scoring framework.

You must follow the exact evaluation process below. Do not skip steps.

---

## INPUTS

### CANDIDATE RESUME
${resumeText.slice(0, 3500)}

### JOB POSTINGS
${postingsJson}

---

## OVERALL GOAL

For each job, estimate the candidate's likelihood of being a competitive applicant (i.e., passing an initial recruiter screen), based on:
- Skills match
- Experience level
- Role alignment
- Domain/industry fit
- Presence/absence of critical requirements

You are NOT optimising for keyword overlap.
You ARE optimising for real-world hiring likelihood.

---

## DEFINITIONS

### Core (Must-Have) Requirements
Skills, tools, or qualifications explicitly required using phrases like "required", "must have", "essential", or clearly central to the role.

### Secondary (Nice-to-Have) Requirements
Skills that are beneficial but not mandatory.

### Adjacent Fit
A candidate is considered adjacent if:
- They have used similar tools in a different domain
- They have performed similar responsibilities under a different title
- They demonstrate transferable skills (e.g., data analysis → business analysis)

---

## STEP 1: EXTRACT JOB FEATURES

For each job, extract:
- extracted_title: normalised role title
- seniority_level: one of ["Junior", "Mid", "Senior", "Lead", "Principal", "Unknown"]
- required_skills: 3–8 core skills/tools (must-have only)
- optional_skills: 2–6 secondary skills
- inferred_experience_years: use stated number if explicit, otherwise infer: Junior→1, Mid→4, Senior→8, Lead/Principal→10, Unknown→0
- domain: industry or problem space
- key_responsibilities: 2–4 concise phrases

---

## STEP 2: EXTRACT CANDIDATE FEATURES

From the resume, infer:
- candidate_skills: normalised list of skills/tools
- candidate_seniority: ["Junior", "Mid", "Senior", "Lead", "Principal", "Unknown"]
- candidate_experience_years: estimated total relevant experience
- candidate_domains: industries worked in
- candidate_roles: past role types

If information is missing or truncated, make conservative assumptions.

---

## STEP 3: HARD FILTER (ELIGIBILITY CHECK)

Apply BEFORE scoring:
1. If candidate is missing most core required_skills (less than 40% match) → cap score at 50
2. If candidate seniority is 2+ levels below required → cap score at 45
3. If role is clearly unrelated to candidate's domain AND no transferable skills → cap score at 40

---

## STEP 4: SCORING (0–100 TOTAL)

### 1. Skills Match (0–40)
- 30 pts: proportion of required_skills matched
- 10 pts: adjacent/transferable skills

### 2. Experience Level (0–25)
- Full points if candidate meets/exceeds inferred_experience_years
- Partial if slightly below
- Low if significantly below

### 3. Role Alignment (0–20)
- Same role/function → high
- Adjacent role → medium
- Different function → low

### 4. Domain Fit (0–15)
- Same domain → high
- Adjacent domain → medium
- Unrelated → low

---

## STEP 5: PENALTIES

Apply AFTER base scoring:
- Missing a critical required skill → subtract 10–25 points
- Overqualification (2+ levels above role) → subtract up to 10
- Vague job description → reduce confidence, do NOT inflate score

Ensure final score is between 0–100. Apply caps from STEP 3 if applicable.

---

## STEP 6: SCORE CALIBRATION

- 90–100 → very likely to pass recruiter screen
- 75–89 → strong candidate with minor gaps
- 60–74 → plausible but not competitive
- 40–59 → long shot
- <40 → unlikely

Use this scale consistently across ALL jobs.

---

## STEP 7: RECOMMENDATION

- "Apply" → score ≥ 70 AND no major missing core requirements
- "Maybe" → score 45–69 OR some gaps but plausible
- "Skip" → score < 45 OR fails hard filters

---

## STEP 8: OUTPUT FORMAT

For EVERY job return EXACTLY this JSON structure — no markdown, no explanation, no extra text:

[
  {
    "index": integer,
    "extracted_title": string,
    "skills": array of 5-10 normalised skills,
    "experience_years": integer,
    "summary": "1-2 sentence role description",
    "relevance_score": integer 0-100,
    "recommendation": "Apply" or "Maybe" or "Skip"
  }
]

Return ONLY a valid JSON array with exactly ${jobs.length} objects.

Evaluate all ${jobs.length} jobs now using this framework.`;

    // Call Gemini
    let attempt = 0;
    while (true) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );

      if (res.status === 429 && attempt < 4) {
        attempt++;
        const wait = attempt * 20000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const err = await res.text();
        return { statusCode: res.status, headers, body: JSON.stringify({ error: `Gemini error: ${err.slice(0, 200)}` }) };
      }

      const data = await res.json();
      let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // Strip markdown fences
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

      // Find the JSON array — sometimes Gemini adds preamble text
      const arrayStart = raw.indexOf('[');
      const arrayEnd   = raw.lastIndexOf(']');
      if (arrayStart === -1 || arrayEnd === -1) {
        // Log what Gemini actually returned to help debug
        console.error('Gemini raw response (no JSON array found):', raw.slice(0, 500));
        return { statusCode: 500, headers, body: JSON.stringify({ error: `Gemini did not return a JSON array. Got: ${raw.slice(0, 200)}` }) };
      }

      raw = raw.slice(arrayStart, arrayEnd + 1);

      let scored;
      try {
        scored = JSON.parse(raw);
      } catch(parseErr) {
        console.error('JSON parse error:', parseErr.message, 'Raw:', raw.slice(0, 500));
        return { statusCode: 500, headers, body: JSON.stringify({ error: `JSON parse failed: ${parseErr.message}` }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ scored }) };
    }

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
