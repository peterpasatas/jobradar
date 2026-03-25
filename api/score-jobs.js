// api/score-jobs.js
// Vercel serverless function — proxies Gemini API with function calling for structured output

const SCORE_FUNCTION = {
  name: 'submit_job_evaluations',
  description: 'Submit structured evaluation results for all job postings against the candidate resume.',
  parameters: {
    type: 'object',
    properties: {
      evaluations: {
        type: 'array',
        description: 'One evaluation object per job posting, in the same order as the input.',
        items: {
          type: 'object',
          properties: {
            index: {
              type: 'integer',
              description: 'The index of the job posting as provided in the input.',
            },
            extracted_title: {
              type: 'string',
              description: 'Cleaned, normalised job title extracted from the posting.',
            },
            skills: {
              type: 'array',
              description: 'Top direct-match skills from the resume, sorted by relevance. DIRECT evidence only — no adjacent or inferred skills.',
              items: { type: 'string' },
              maxItems: 5,
            },
            experience_years: {
              type: 'integer',
              description: 'Estimated years of relevant experience the candidate has for this role. Must be a whole number.',
            },
            summary: {
              type: 'string',
              description: "Exactly this format: '[Role type 2-4 words]. You're strong in [2-3 specific strengths]. You're weak in [2-3 specific critical gaps].' Example: 'AI Enablement Consultant. You're strong in stakeholder management, Power Platform, workshop delivery. You're weak in Python, cloud infrastructure, RAG.'",
            },
            relevance_score: {
              type: 'integer',
              description: 'Final score 0-100 after applying all evaluation steps, penalties, hard caps, and sanity gates.',
              minimum: 0,
              maximum: 100,
            },
          },
          required: ['index', 'extracted_title', 'skills', 'experience_years', 'summary', 'relevance_score'],
        },
      },
    },
    required: ['evaluations'],
  },
};

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

    const prompt = `You are a senior hiring evaluator. Your task is strict, evidence-based semantic comparison of a resume against a job description. You do not encourage or inflate. You evaluate actual evidence only. Call the submit_job_evaluations function with your results for all ${jobs.length} jobs.

## INPUTS

### CANDIDATE RESUME
${resumeText.slice(0, 4200)}

### JOB POSTINGS
${postingsJson}

---

## EVALUATION PIPELINE — execute every step in order, no skipping

### STEP 1 — Language gate
If any job description is not in English: set relevance_score=0, skip all remaining steps for that job.

### STEP 2 — Role classification
Classify each role as one of:
- TECHNICAL: requires hands-on software/data/AI engineering, coding, or infrastructure
- HYBRID: delivery, architecture, or consulting roles requiring both technical understanding AND non-technical skills
- NON-TECHNICAL: strategy, operations, enablement, change management, stakeholder management

### STEP 3 — Evidence classification
Extract every CORE requirement (under Requirements/Must-have/Essential heading, uses "required/must have/essential/proven experience in", mentioned 2+ times, or tied to daily responsibilities).

Classify each match as DIRECT, ADJACENT, or NONE:
- TECHNICAL roles — DIRECT requires production code, deployed systems, engineering ownership. NEVER direct: low-code/no-code tools, configuration-only work, prompt engineering, workshops, "Basic" skills. Required programming language + no production coding = NONE.
- HYBRID roles — DIRECT for technical requirements follows TECHNICAL rules. DIRECT for delivery/coordination: demonstrated project ownership, cross-functional leadership with outcomes.
- NON-TECHNICAL roles — DIRECT includes: stakeholder management, requirements translation, workflow design, project delivery, change management, adoption driving, workshop facilitation, workstream management, client relationship management — when required and evidenced.

ANTI-INFLATION: Shared terminology ("agentic", "AI", "orchestration", "automation") is NOT skill evidence. Match on what was actually done.

Count: total_core_requirements, direct_matches, adjacent_matches
core_match_pct = direct_matches / total_core_requirements

### STEP 4 — Scored categories
A. Skills Match (max 35): direct_skill_pts = (direct_matches/total_core) × 25; adjacent_skill_pts = (adjacent_matches/total_core) × 10 [max 7]; A = sum [cap 35]
B. Experience Relevance (max 25): years_pts = min(candidate_yrs/required_yrs, 1.0) × 12 [use 8 if unstated]; seniority_pts = 8 match | 4 one-off | 0 two+; industry_pts = 5 same | 3 adjacent | 0 unrelated; B = sum [cap 25]
C. Responsibilities Alignment (max 20): C = (matching_responsibility_pct × 16) + ownership_depth_pts [0-4, cap 20]
D. Achievements and Impact (max 10): quantified_results 0-5 + business_impact 0-5 [cap 10]
E. Education and Certifications (max 10): 10 meets all required | 7 meets preferred | 4 adjacent | 0 missing required
F. Red Flags (0 to -20): missing CRITICAL req -8 each [cap -16]; missing SECONDARY req -3 each [cap -9]; career gap >12mo unexplained -3; overqualified 2+ levels -5; F = sum [floor -20]

raw_score = A + B + C + D + E + F

### STEP 5 — Hard caps (apply AFTER raw_score, lowest ceiling wins)
No relevant experience in role's core function → ceiling 35
Seniority 2+ levels below → ceiling 42
core_match_pct < 35% → ceiling 48
TECHNICAL role: no direct coding/engineering evidence → ceiling 52
TECHNICAL role: required programming language, no coding evidence → ceiling 52
core_match_pct < 55% → ceiling 58
final_score = min(raw_score, ceiling)

### STEP 6 — Sanity gates
score > 75: verify core_match_pct ≥ 65% AND no critical requirements missing → else reduce to 74
score > 85: verify core_match_pct ≥ 80% AND no gaps in central skills → else reduce to 84
90+ = exceptional, near-perfect fit only.

Now call submit_job_evaluations with results for all ${jobs.length} jobs.`;

    let attempt = 0;
    while (true) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ functionDeclarations: [SCORE_FUNCTION] }],
            toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['submit_job_evaluations'] } },
            generationConfig: { temperature: 0.1 },
          }),
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
      const part = data?.candidates?.[0]?.content?.parts?.[0];

      let scored;

      if (part?.functionCall?.args?.evaluations) {
        // Function calling response — typed, no parsing needed
        scored = part.functionCall.args.evaluations;
      } else if (part?.text) {
        // Text fallback — parse whether Gemini returned an array or {evaluations:[...]} object
        let raw = part.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            scored = parsed;
          } else if (parsed?.evaluations) {
            scored = parsed.evaluations;
          } else {
            return res.status(500).json({ error: `Unexpected response shape: ${raw.slice(0, 200)}` });
          }
        } catch(err) {
          return res.status(500).json({ error: `JSON parse failed: ${err.message}. Raw: ${raw.slice(0, 200)}` });
        }
      } else {
        return res.status(500).json({ error: `Unexpected Gemini response: ${JSON.stringify(data).slice(0, 200)}` });
      }

      // Enforce recommendation in code — deterministic from score, not LLM judgment
      scored = scored.map(job => {
        const score = job.relevance_score || 0;
        const rec = score < 45 ? 'Skip' : score >= 70 ? 'Apply' : 'Maybe';
        return {
          ...job,
          experience_years: Math.floor(job.experience_years || 0),
          skills: Array.isArray(job.skills) ? job.skills : [],
          recommendation: rec,
        };
      });

      return res.status(200).json({ scored });
    }

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

