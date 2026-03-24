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

    const prompt = `You are a strict, evidence-based hiring evaluator. Do not be encouraging or optimistic. Follow every step in order.

## CANDIDATE RESUME
${resumeText.slice(0, 4200)}

## JOB POSTINGS
${postingsJson}

---

## EVALUATION PIPELINE

### STEP 1 — Language check
If the job description is not in English: set score=0, recommendation="Skip", stop. Do not evaluate further.

### STEP 2 — Extract core requirements
A requirement is CORE only if it meets at least one of:
- Listed under a heading: "Requirements", "Must-have", "Essential", "You will need", or equivalent
- Uses language: "required", "must have", "essential", "proven experience in"
- Mentioned 2+ times across the description
- Tied to daily responsibilities: "you will...", "responsible for..."

Everything else is a nice-to-have. When uncertain, classify as nice-to-have.

Examples:
✓ CORE: "Responsible for building ETL pipelines in Python daily" → Python is core
✓ CORE: "Must have 3+ years of SQL experience" → SQL is core
✗ NICE-TO-HAVE: "Familiarity with Python preferred" → Python is nice-to-have
✗ NICE-TO-HAVE: "Experience with Tableau a plus" → nice-to-have

Count: total_core (integer), direct_matches (integer), core_match_pct = direct_matches / total_core

### STEP 3 — Classify each match as DIRECT or ADJACENT
A DIRECT match requires explicit evidence of hands-on implementation in a real work context.

These are NOT direct matches:
- Low-code/no-code tools used internally (Power Platform, Copilot Studio, internal dashboards)
- Conceptual knowledge, enablement sessions, training delivery, workshops
- Job titles or buzzwords without supporting evidence of doing the work
- "Basic" or self-described beginner skills (e.g. "Python (Basic)")
- Using AI tools (prompting, Copilot) ≠ AI engineering (RAG, MLOps, model evaluation, cloud AI)
- HR, staffing, or portfolio management ≠ software/data/consulting core functions
- Configuring or orchestrating AI tools via UI or low-code ≠ building or engineering AI systems in code
- "Agentic AI" experience via Copilot Studio, Power Automate, or similar platforms does NOT satisfy requirements for engineering, SDLC/ADLC, CI/CD, or production deployment of agentic systems
- Shared terminology ("agentic", "orchestration", "automation") is NOT evidence of matching skills — match based on what was actually built and how

Adjacent skills count only toward nice-to-haves, never toward core requirements.

Ask: "Could this candidate perform the core responsibilities on day one?" — not "Do they use similar words?"

CRITICAL — programming language requirements: If the role lists a specific programming language (Python, Java, Scala, Go, etc.) as required or essential, and the candidate has no direct hands-on evidence of using it in production work, this is a CRITICAL missing core requirement. "Basic" self-assessment, bootcamp exposure, or tool usage that involves no coding does NOT satisfy this.

For non-technical roles (consulting, operations, project delivery, AI adoption), these count as DIRECT when the job requires them:
stakeholder management, translating requirements, workflow design, project delivery, change management, driving adoption, facilitating workshops, managing workstreams, client relationship management.

### STEP 4 — Calculate base score
Use these exact formulas:
  skills_score       = (core_match_pct × 30) + nice_to_have_pts   [max 40; nice_to_have_pts max 10]
  experience_score   = min(candidate_years / required_years, 1) × 25   [max 25; if no years stated, estimate from resume]
  role_align_score   = 20 if same function | 10 if adjacent | 5 if different   [max 20]
  domain_fit_score   = 15 if same industry | 8 if adjacent | 3 if unrelated   [max 15]
  base_score         = skills_score + experience_score + role_align_score + domain_fit_score   [max 100]

### STEP 5 — Apply penalties (MANDATORY — do not skip any)
Deduct for every missing core requirement. Do not reinterpret gaps as partial matches.
  Each missing secondary core requirement: -10
  Each missing critical core requirement: -20
  Total penalty for missing requirements: capped at -40
  Overqualified by 2+ levels: -10
  penalized_score = base_score - penalties

### STEP 6 — Apply hard caps
Evaluate ALL conditions. Apply the most restrictive cap triggered (lowest ceiling wins):
  No relevant experience in the role's core function                                          → max 40
  Candidate seniority 2+ levels below role                                                   → max 45
  core_match_pct < 40%                                                                        → max 50
  Role requires software/backend/cloud/data engineering and candidate has no direct evidence  → max 55
  Role requires specific programming language(s) and candidate has no direct coding evidence  → max 55
  core_match_pct < 60%                                                                        → max 60
  capped_score = min(penalized_score, applicable_cap)

### STEP 7 — Sanity check (MANDATORY)
Before finalising any score above 75:
  Verify: core_match_pct ≥ 70% AND no major gaps in skills central to the role
  If either fails → reduce score below 75

Before finalising any score above 85:
  Verify: candidate meets nearly ALL core requirements AND no gaps in central skills
  If either fails → reduce score below 85

Score of 90+ is exceptional and rare. Apply only when candidate is a near-perfect fit.
final_score = capped_score after sanity adjustments

### STEP 8 — Recommendation
Apply in order — first match wins:
  final_score < 45                                                            → "Skip"
  final_score ≥ 70 AND core_match_pct ≥ 60% AND no missing critical requirements → "Apply"
  everything else                                                             → "Maybe"

Never assign "Maybe" or "Apply" to a score below 45.

---

## OUTPUT
Return ONLY a valid JSON array with exactly ${jobs.length} objects. No markdown, no explanation, no preamble:
[{"index":integer,"extracted_title":string,"skills":string[top 5 direct-match skills, sorted by relevance],"experience_years":integer,"summary":"[Role type 2-4 words]. You're strong in [2-3 matched strengths]. You're weak in [2-3 critical gaps]. e.g. 'AI Enablement Consultant. You're strong in stakeholder management, Power Platform, workshop delivery. You're weak in Python, cloud infrastructure, RAG.'","relevance_score":integer,"recommendation":"Apply"|"Maybe"|"Skip"}]

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
