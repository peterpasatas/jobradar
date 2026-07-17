// api/score-jobs.js
// Architecture: LLM judges facts → code computes scores deterministically.
// The model never does arithmetic. Every score is reproducible and auditable.
// Model: deepseek-v4-flash via DeepSeek's OpenAI-compatible API.

const EVAL_FUNCTION = {
  name: 'submit_job_facts',
  description: 'Submit factual evaluation judgments for all job postings against the candidate resume. Do not compute scores — only classify and judge.',
  parameters: {
    type: 'object',
    properties: {
      evaluations: {
        type: 'array',
        description: 'One evaluation object per job posting, same order as input.',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'Index of the job posting as provided in input.' },
            extracted_title: { type: 'string', description: 'Cleaned, normalised job title.' },
            language_ok: { type: 'boolean', description: 'True if the job description is in English.' },
            role_type: {
              type: 'string',
              enum: ['TECHNICAL', 'HYBRID', 'NON_TECHNICAL'],
              description: 'TECHNICAL: hands-on software/data/AI engineering, coding, or infrastructure is the primary daily work. HYBRID: delivery/architecture/consulting requiring both technical depth and coordination. NON_TECHNICAL: strategy, operations, enablement, change management, stakeholder/resource/programme management, HR, recruiting. A role mentioning Excel or Power BI as secondary tools is NOT technical — classify by primary daily work.',
            },
            core_requirements: {
              type: 'array',
              description: 'Every CORE requirement extracted from the posting. CORE = under a Requirements/Must-have/Essential heading, phrased as required/must-have/essential/proven-experience, mentioned 2+ times, or tied to daily responsibilities. Nice-to-haves are NOT core.',
              items: {
                type: 'object',
                properties: {
                  requirement: { type: 'string', description: 'The requirement, briefly stated.' },
                  criticality: { type: 'string', enum: ['CRITICAL', 'SECONDARY'], description: 'CRITICAL if explicitly essential/must-have or central to the role function. SECONDARY otherwise.' },
                  match: {
                    type: 'string',
                    enum: ['DIRECT', 'ADJACENT', 'NONE'],
                    description: 'DIRECT: explicit hands-on evidence in a real work context in the resume. For TECHNICAL requirements this means production code/deployed systems/engineering ownership — low-code tools, configuration, prompt engineering, workshops, or "Basic" self-ratings are NEVER direct. For NON_TECHNICAL requirements, operational evidence counts: stakeholder management, capacity planning, change management, project delivery, conflict resolution, recruitment support, process establishment, data reporting. ADJACENT: transferable but not the same. NONE: no evidence. Shared buzzwords (agentic, AI, automation, orchestration) are NOT evidence — judge what was actually done.',
                  },
                },
                required: ['requirement', 'criticality', 'match'],
              },
            },
            candidate_years: { type: 'integer', description: 'Years of experience relevant to THIS role the candidate has, from resume evidence.' },
            required_years: { type: 'integer', description: 'Years required by the posting. 0 if not stated.' },
            seniority_fit: { type: 'string', enum: ['MATCH', 'ONE_LEVEL_OFF', 'TWO_PLUS_OFF'], description: 'Candidate seniority vs role seniority, in either direction.' },
            industry_fit: { type: 'string', enum: ['SAME', 'ADJACENT', 'UNRELATED'], description: 'Candidate industry background vs role industry.' },
            responsibility_overlap_pct: { type: 'integer', minimum: 0, maximum: 100, description: 'Percentage of the listed day-to-day responsibilities the candidate has directly performed before.' },
            ownership_depth: { type: 'integer', minimum: 0, maximum: 4, description: 'Depth of ownership shown in matching responsibilities: 0=none, 2=contributor, 4=owned end-to-end with outcomes.' },
            quantified_results: { type: 'integer', minimum: 0, maximum: 5, description: 'Evidence of measurable outcomes in resume relevant to this role (0=none, 5=strong throughout).' },
            business_impact: { type: 'integer', minimum: 0, maximum: 5, description: 'Evidence of business outcomes relevant to this role.' },
            education_fit: { type: 'string', enum: ['MEETS_REQUIRED', 'MEETS_PREFERRED', 'ADJACENT', 'MISSING_REQUIRED'], description: 'Candidate qualifications vs posting requirements.' },
            career_gap_over_12mo: { type: 'boolean', description: 'Unexplained career gap over 12 months visible in resume.' },
            overqualified_two_plus_levels: { type: 'boolean', description: 'Candidate is 2+ seniority levels ABOVE the role.' },
            has_core_function_experience: { type: 'boolean', description: 'Candidate has any relevant experience in the core function of this role.' },
            skills: {
              type: 'array', maxItems: 5,
              items: { type: 'string' },
              description: 'Top 5 DIRECT-match skills relevant to THIS role. For NON_TECHNICAL roles surface operational/management skills, not tools.',
            },
            summary: {
              type: 'string',
              description: "Format: '[Role type 2-4 words]. You're strong in [2-3 evidenced strengths relevant to this role]. You're weak in [2-3 genuine gaps the role requires].' Strengths/gaps must match the role type — operational skills for NON_TECHNICAL roles.",
            },
          },
          required: ['index', 'extracted_title', 'language_ok', 'role_type', 'core_requirements', 'candidate_years', 'required_years', 'seniority_fit', 'industry_fit', 'responsibility_overlap_pct', 'ownership_depth', 'quantified_results', 'business_impact', 'education_fit', 'career_gap_over_12mo', 'overqualified_two_plus_levels', 'has_core_function_experience', 'skills', 'summary'],
        },
      },
    },
    required: ['evaluations'],
  },
};

// ── DETERMINISTIC SCORING — all arithmetic lives here, not in the LLM ─────────
function computeScore(ev) {
  if (!ev.language_ok) return { score: 0, breakdown: { reason: 'non-English posting' } };

  const reqs = ev.core_requirements || [];
  const total = Math.max(reqs.length, 1);
  const direct = reqs.filter(r => r.match === 'DIRECT').length;
  const adjacent = reqs.filter(r => r.match === 'ADJACENT').length;
  const corePct = direct / total;

  // A. Skills Match — max 35
  const A = Math.min(35, (corePct * 25) + Math.min((adjacent / total) * 10, 7));

  // B. Experience Relevance — max 25
  const yearsPts = ev.required_years > 0
    ? Math.min(ev.candidate_years / ev.required_years, 1) * 12
    : 8;
  const seniorityPts = { MATCH: 8, ONE_LEVEL_OFF: 4, TWO_PLUS_OFF: 0 }[ev.seniority_fit] ?? 0;
  const industryPts = { SAME: 5, ADJACENT: 3, UNRELATED: 0 }[ev.industry_fit] ?? 0;
  const B = Math.min(25, yearsPts + seniorityPts + industryPts);

  // C. Responsibilities Alignment — max 20
  const C = Math.min(20, (ev.responsibility_overlap_pct / 100) * 16 + (ev.ownership_depth || 0));

  // D. Achievements & Impact — max 10
  const D = Math.min(10, (ev.quantified_results || 0) + (ev.business_impact || 0));

  // E. Education — max 10
  const E = { MEETS_REQUIRED: 10, MEETS_PREFERRED: 7, ADJACENT: 4, MISSING_REQUIRED: 0 }[ev.education_fit] ?? 4;

  // F. Red Flags — 0 to -20
  const missCrit = reqs.filter(r => r.criticality === 'CRITICAL' && r.match === 'NONE').length;
  const missSec  = reqs.filter(r => r.criticality === 'SECONDARY' && r.match === 'NONE').length;
  let F = Math.max(-16, missCrit * -8) + Math.max(-9, missSec * -3);
  if (ev.career_gap_over_12mo) F -= 3;
  if (ev.overqualified_two_plus_levels) F -= 5;
  F = Math.max(-20, F);

  let raw = A + B + C + D + E + F;

  // Hard caps — lowest ceiling wins
  let ceiling = 100;
  if (!ev.has_core_function_experience) ceiling = Math.min(ceiling, 35);
  if (ev.seniority_fit === 'TWO_PLUS_OFF' && !ev.overqualified_two_plus_levels) ceiling = Math.min(ceiling, 42);
  if (corePct < 0.35) ceiling = Math.min(ceiling, 48);
  if (ev.role_type === 'TECHNICAL') {
    const techDirect = reqs.some(r => r.match === 'DIRECT');
    if (!techDirect) ceiling = Math.min(ceiling, 52);
  }
  if (corePct < 0.55) ceiling = Math.min(ceiling, 58);

  let score = Math.min(Math.round(raw), ceiling);

  // Sanity gates
  if (score > 75 && (corePct < 0.65 || missCrit > 0)) score = 74;
  if (score > 85 && corePct < 0.80) score = 84;

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    breakdown: {
      A: +A.toFixed(1), B: +B.toFixed(1), C: +C.toFixed(1), D, E, F,
      core_match_pct: +(corePct * 100).toFixed(0),
      missing_critical: missCrit, missing_secondary: missSec,
      ceiling,
    },
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { jobs, resumeText } = req.body;
    if (!jobs || !resumeText) return res.status(400).json({ error: 'jobs and resumeText are required' });

    const postingsJson = JSON.stringify(jobs.map((j, i) => ({
      index: i, title: j.title, company: j.company,
      location: j.location, description: j.description,
    })), null, 2);

    const prompt = `You are a senior hiring evaluator performing strict, evidence-based comparison of a candidate resume against job postings. You judge facts only — you never compute scores. Scores are computed downstream from your judgments, so precision in classification is everything.

Principles:
- Evidence over vocabulary. Shared buzzwords are not skill matches. Judge what the candidate actually did.
- When uncertain whether a requirement match is DIRECT, choose ADJACENT. When uncertain between ADJACENT and NONE, choose ADJACENT.
- When uncertain whether a requirement is CORE, exclude it. A shorter accurate list beats a padded one.
- Do not fill gaps with assumptions. Missing information means no evidence.
- Judge each job independently and completely.

## CANDIDATE RESUME
${resumeText.slice(0, 6000)}

## JOB POSTINGS
${postingsJson}

Call submit_job_facts with complete factual judgments for all ${jobs.length} jobs. Every field matters — the scoring formulas consume each one.`;

    const apiKey = process.env.DEEPSEEK_API_KEY || process.env.GEMINI_API_KEY;

    let attempt = 0;
    while (true) {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: prompt }],
          tools: [{ type: 'function', function: EVAL_FUNCTION }],
          tool_choice: { type: 'function', function: { name: 'submit_job_facts' } },
          temperature: 0.1,
        }),
      });

      if (response.status === 429 && attempt < 3) {
        attempt++;
        await new Promise(r => setTimeout(r, attempt * 10000));
        continue;
      }
      if (!response.ok) {
        const err = await response.text();
        return res.status(response.status).json({ error: `DeepSeek ${response.status}: ${err.slice(0, 300)}` });
      }

      const data = await response.json();
      const msg = data?.choices?.[0]?.message;

      let evals;
      const toolArgs = msg?.tool_calls?.[0]?.function?.arguments;
      if (toolArgs) {
        // OpenAI-style tool call — arguments arrive as a JSON string
        try {
          const parsed = JSON.parse(toolArgs);
          evals = parsed?.evaluations;
        } catch (err) {
          return res.status(500).json({ error: `Tool args parse failed: ${err.message}. Raw: ${String(toolArgs).slice(0, 200)}` });
        }
      } else if (msg?.content) {
        // Text fallback
        let raw = msg.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        try {
          const parsed = JSON.parse(raw);
          evals = Array.isArray(parsed) ? parsed : parsed?.evaluations;
        } catch (err) {
          return res.status(500).json({ error: `JSON parse failed: ${err.message}. Raw: ${raw.slice(0, 200)}` });
        }
      }
      if (!evals) {
        return res.status(500).json({ error: `Unexpected DeepSeek response: ${JSON.stringify(data).slice(0, 200)}` });
      }

      // Deterministic scoring + recommendation from judged facts
      const scored = evals.map(ev => {
        const { score, breakdown } = computeScore(ev);
        const rec = score < 45 ? 'Skip' : score >= 70 ? 'Apply' : 'Maybe';
        return {
          index: ev.index,
          extracted_title: ev.extracted_title,
          skills: Array.isArray(ev.skills) ? ev.skills : [],
          experience_years: Math.floor(ev.candidate_years || 0),
          summary: ev.summary || '',
          relevance_score: score,
          recommendation: rec,
          score_breakdown: breakdown,
        };
      });

      return res.status(200).json({ scored });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
