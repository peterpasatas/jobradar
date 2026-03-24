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

    const prompt = `You are a senior hiring evaluator. Your task is strict, evidence-based semantic comparison of a resume against a job description. You do not encourage or inflate. You evaluate actual evidence only.

## INPUTS

### CANDIDATE RESUME
${resumeText.slice(0, 4200)}

### JOB POSTING
${postingsJson}

---

## EVALUATION PIPELINE — execute every step in order, no skipping

---

### STEP 1 — Language gate
If any job description is not in English: score=0, recommendation="Skip", skip all remaining steps for that job.

---

### STEP 2 — Role classification
For each job, classify the role as one of:
- TECHNICAL: requires hands-on software/data/AI engineering, coding, or infrastructure (e.g. software engineer, data engineer, ML engineer, platform engineer, DevOps)
- HYBRID: delivery, architecture, or consulting roles that require both technical understanding AND non-technical skills (e.g. solutions architect, technical PM, AI consultant, delivery manager)
- NON-TECHNICAL: strategy, operations, enablement, change management, stakeholder management (e.g. programme manager, AI adoption lead, consulting analyst, operations manager)

This classification determines what counts as DIRECT evidence in Step 3.

---

### STEP 3 — Evidence classification (apply per core requirement)
Extract every core requirement from the job description. A requirement is CORE if it appears under a Requirements/Must-have/Essential heading, uses "required/must have/essential/proven experience in", is mentioned 2+ times, or is tied to daily responsibilities.

For each core requirement, classify the candidate's match as:
- DIRECT: explicit hands-on evidence in a real work context — the candidate demonstrably did this thing
- ADJACENT: related but not the same — candidate has transferable experience but not direct evidence
- NONE: no evidence

Evidence rules by role type:
TECHNICAL roles — DIRECT requires: production code, deployed systems, engineering ownership. The following are NEVER direct for technical roles: low-code/no-code tools (Power Platform, Copilot Studio), configuration-only work, prompt engineering, workshop delivery, enabling others to use tools, "Basic" self-assessed skills. Programming language listed as required + no production coding evidence = NONE.

HYBRID roles — DIRECT for technical requirements follows TECHNICAL rules above. DIRECT for delivery/coordination requirements: demonstrated project ownership, cross-functional team leadership, stakeholder management with evidence of outcomes.

NON-TECHNICAL roles — DIRECT includes: stakeholder management, requirements translation, workflow design, project delivery, change management, adoption driving, workshop facilitation, workstream management, client relationship management — when the job requires them and the resume shows evidence.

ANTI-INFLATION RULE: Shared terminology ("agentic", "AI", "orchestration", "automation", "digital transformation") is NOT evidence of matching skills. Match on what was actually done, not what words were used.

Count: total_core_requirements (integer), direct_matches (integer), adjacent_matches (integer)
core_match_pct = direct_matches / total_core_requirements

---

### STEP 4 — Scored categories (compute each explicitly)

**A. Skills Match — max 35 points**
  direct_skill_pts  = (direct_matches / total_core_requirements) × 25
  adjacent_skill_pts = (adjacent_matches / total_core_requirements) × 10  [max 7]
  A_score = direct_skill_pts + adjacent_skill_pts  [cap at 35]

**B. Experience Relevance — max 25 points**
  years_pts    = min(candidate_years / required_years, 1.0) × 12  [if no requirement stated, use 8]
  seniority_pts = 8 if level matches | 4 if one level off | 0 if two+ levels off
  industry_pts  = 5 if same industry | 3 if adjacent | 0 if unrelated
  B_score = years_pts + seniority_pts + industry_pts  [cap at 25]

**C. Responsibilities Alignment — max 20 points**
  Proportion of job responsibilities the candidate has directly performed, weighted by depth of ownership:
  C_score = (matching_responsibility_pct × 16) + ownership_depth_pts  [ownership: 0-4, cap total at 20]

**D. Achievements and Impact — max 10 points**
  quantified_results_pts = 0-5 based on evidence of measurable outcomes in resume
  business_impact_pts    = 0-5 based on evidence of business outcomes relevant to this role
  D_score = quantified_results_pts + business_impact_pts  [cap at 10]

**E. Education and Certifications — max 10 points**
  E_score = 10 if meets all required qualifications | 7 if meets preferred | 4 if adjacent | 0 if unrelated or missing required

**F. Red Flags — deduction, 0 to -20 points**
  Each missing CRITICAL core requirement (listed as essential/must-have): -8 each [cap deduction at -16]
  Each missing SECONDARY core requirement: -3 each [cap deduction at -9]
  Career gap > 12 months without explanation: -3
  Overqualified by 2+ seniority levels: -5
  F_score = sum of deductions [floor at -20]

**raw_score = A_score + B_score + C_score + D_score + E_score + F_score**

---

### STEP 5 — Hard caps (apply AFTER raw_score, lowest ceiling wins)
Evaluate all conditions and apply the most restrictive:
  No relevant experience in role's core function                                              → ceiling = 35
  Seniority 2+ levels below role requirement                                                 → ceiling = 42
  core_match_pct < 35%                                                                        → ceiling = 48
  TECHNICAL role: no direct coding/engineering evidence                                      → ceiling = 52
  TECHNICAL role: required programming language(s) present, candidate has no coding evidence → ceiling = 52
  core_match_pct < 55%                                                                        → ceiling = 58
  No caps triggered                                                                           → ceiling = 100

  final_score = min(raw_score, ceiling)

---

### STEP 6 — Sanity gates (mandatory check before finalising)
Before assigning any score above 75: verify core_match_pct ≥ 65% AND no critical requirements missing. If either fails → reduce to 74.
Before assigning any score above 85: verify core_match_pct ≥ 80% AND no gaps in skills central to the role. If either fails → reduce to 84.
Score of 90+ is exceptional. Apply only when candidate is a near-perfect fit with direct evidence across nearly all core requirements.

---

### STEP 7 — Recommendation
Apply in order, first match wins:
  final_score < 45                                                              → "Skip"
  final_score ≥ 70 AND core_match_pct ≥ 60% AND no missing critical requirements → "Apply"
  everything else                                                               → "Maybe"

---

## OUTPUT
Return ONLY a valid JSON array with exactly ${jobs.length} objects. No markdown, no explanation, no preamble:
[{"index":0,"extracted_title":"Example Role Title","skills":["skill1","skill2"],"experience_years":3,"summary":"AI Consultant. You're strong in stakeholder management, Power Platform, workshop delivery. You're weak in Python, cloud infrastructure, RAG.","relevance_score":65,"recommendation":"Maybe"}]

Use that structure for all ${jobs.length} jobs. The summary must always follow this exact format: "[Role type 2-4 words]. You're strong in [specific strengths]. You're weak in [specific gaps]." — no other format is acceptable.

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

      // Enforce recommendation rules in code — Gemini frequently misapplies the score threshold
      scored = scored.map(job => {
        const score = job.relevance_score || 0;
        let rec;
        if (score < 45) {
          rec = 'Skip';
        } else if (score >= 70) {
          rec = 'Apply';
        } else {
          rec = 'Maybe';
        }
        return { ...job, recommendation: rec };
      });

      return res.status(200).json({ scored });
    }

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
