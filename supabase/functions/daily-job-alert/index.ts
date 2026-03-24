// supabase/functions/daily-job-alert/index.ts
// Daily scheduled job alert — fetches, scores, and emails results to each user
// Triggered by pg_cron at 9:00 AM and 23:59 UTC daily

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GEMINI_KEY       = Deno.env.get('GEMINI_API_KEY')!;
const ADZUNA_ID        = Deno.env.get('ADZUNA_APP_ID')!;
const ADZUNA_KEY       = Deno.env.get('ADZUNA_APP_KEY')!;
const SERPAPI_KEY      = Deno.env.get('SERPAPI_KEY')!;
const RESEND_KEY       = Deno.env.get('RESEND_API_KEY')!;
const FROM_EMAIL       = Deno.env.get('FROM_EMAIL') || 'alerts@jobradar.app';

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE);

// ── ENTRY POINT ───────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const currentHour = new Date().getUTCHours();
  const currentMin  = new Date().getUTCMinutes();
  const currentTime = `${String(currentHour).padStart(2,'0')}:${String(currentMin).padStart(2,'0')}`;

  const url = new URL(req.url);
  const force = url.searchParams.get('force') === 'true';

  console.log(`daily-job-alert triggered at ${currentTime} UTC${force ? ' (FORCED)' : ''}`);

  try {
    const { data: profiles, error } = await sb
      .from('profiles')
      .select('id, email, resume_text, schedule_config')
      .not('schedule_config', 'is', null);

    if (error) throw new Error(`Failed to fetch profiles: ${error.message}`);
    if (!profiles?.length) return new Response('No scheduled users found.', { status: 200 });

    console.log(`Processing ${profiles.length} scheduled user(s)`);

    const results = [];
    for (const profile of profiles) {
      const config = profile.schedule_config;
      if (!config) continue;

      if (!force && config.time && !timeMatches(config.time, currentTime)) {
        console.log(`Skipping ${profile.email} — scheduled for ${config.time}, current time ${currentTime}`);
        continue;
      }

      try {
        console.log(`Processing ${profile.email}...`);
        const result = await processUser(profile, config);
        results.push({ email: profile.email, status: 'sent', jobs: result.jobCount });
      } catch (e) {
        console.error(`Error processing ${profile.email}:`, e.message);
        results.push({ email: profile.email, status: 'error', error: e.message });
      }
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (e) {
    console.error('Fatal error:', e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
});

function timeMatches(scheduledTime: string, currentTime: string): boolean {
  const [sh, sm] = scheduledTime.split(':').map(Number);
  const [ch, cm] = currentTime.split(':').map(Number);
  const scheduledMins = sh * 60 + sm;
  const currentMins   = ch * 60 + cm;
  return Math.abs(scheduledMins - currentMins) <= 5;
}

// ── PROCESS ONE USER ──────────────────────────────────────────────────────────
async function processUser(profile: any, config: any) {
  if (!profile.resume_text) throw new Error('No resume on file');

  const jobs = config.source === 'serp'
    ? await fetchSerpJobs(config)
    : await fetchAdzunaJobs(config);

  if (!jobs.length) throw new Error('No jobs found');
  console.log(`  Fetched ${jobs.length} jobs`);

  const scored = await scoreJobs(jobs, profile.resume_text);
  console.log(`  Scored ${scored.length} jobs`);

  const applyJobs = scored.filter(j => j.recommendation === 'Apply')
    .sort((a, b) => b.relevance_score - a.relevance_score);

  const maybeJobs = scored.filter(j => j.recommendation === 'Maybe')
    .sort((a, b) => b.relevance_score - a.relevance_score);

  const top20PctMaybe = maybeJobs.slice(0, Math.max(1, Math.ceil(maybeJobs.length * 0.2)));

  const emailJobs = [...applyJobs, ...top20PctMaybe];
  if (!emailJobs.length) throw new Error('No Apply or Maybe jobs to send');

  console.log(`  Apply: ${applyJobs.length}, Top Maybe: ${top20PctMaybe.length}`);

  const runId = Date.now().toString();
  const today = new Date().toISOString().slice(0, 10);
  const dbRows = scored.map(j => ({
    user_id: profile.id,
    run_id: runId,
    run_date: today,
    job_id: j.job_id || `sched_${Math.random().toString(36).slice(2)}`,
    title: j.extracted_title || j.title,
    company: j.company,
    location: j.location,
    summary: j.summary || '',
    extracted_skills: j.skills || [],
    experience_years: j.experience_years || 0,
    relevance_score: j.relevance_score || 0,
    recommendation: j.recommendation || 'Skip',
    salary_min: j.salary_min || null,
    salary_max: j.salary_max || null,
    url: j.url || '',
    via: j.via || '',
  }));

  await sb.from('job_results').insert(dbRows);

  await sendEmail(profile.email, emailJobs, applyJobs.length, top20PctMaybe.length, today);

  return { jobCount: emailJobs.length };
}

// ── FETCH ADZUNA ──────────────────────────────────────────────────────────────
async function fetchAdzunaJobs(config: any): Promise<any[]> {
  const queries   = config.queries   || [];
  const countries = config.countries || [];
  const results   = config.results   || 10;
  const days      = config.days      || '3';

  const dayMap: Record<string, number> = { '1': 1, '3': 3, '7': 7 };
  const maxDaysOld = dayMap[String(days)] || 3;

  const jobs: any[] = [];
  const seen = new Set<string>();

  for (const query of queries) {
    for (const country of countries) {
      try {
        const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`);
        url.searchParams.set('app_id',           ADZUNA_ID);
        url.searchParams.set('app_key',          ADZUNA_KEY);
        url.searchParams.set('what',             query);
        url.searchParams.set('results_per_page', String(results));
        url.searchParams.set('max_days_old',     String(maxDaysOld));

        const res  = await fetch(url.toString());
        const data = await res.json();

        for (const job of (data.results || [])) {
          const key = job.id || job.title + job.company;
          if (seen.has(key)) continue;
          seen.add(key);
          jobs.push({
            id:          job.id,
            title:       job.title,
            company:     job.company?.display_name || 'N/A',
            location:    job.location?.display_name || 'N/A',
            description: job.description || '',
            url:         job.redirect_url || '',
            salary_min:  job.salary_min || null,
            salary_max:  job.salary_max || null,
            via:         'Adzuna',
          });
        }
      } catch (e) {
        console.error(`  Adzuna error (${query}/${country}):`, e.message);
      }
    }
  }

  return jobs;
}

// ── FETCH SERP ────────────────────────────────────────────────────────────────
async function fetchSerpJobs(config: any): Promise<any[]> {
  const queries   = config.queries   || [];
  const cities    = config.cities    || config.countries || [];
  const countries = config.countries || [];
  const dateRange = config.dateRange || '3days';
  const locations = cities.length ? cities : countries;

  const jobs: any[] = [];
  const seen = new Set<string>();

  for (const query of queries) {
    for (const location of locations) {
      try {
        const url = new URL('https://serpapi.com/search');
        url.searchParams.set('engine',   'google_jobs');
        url.searchParams.set('q',        `${query} ${location}`);
        url.searchParams.set('location', location);
        url.searchParams.set('gl',       'gb');
        url.searchParams.set('hl',       'en');
        url.searchParams.set('ltype',    'l');
        url.searchParams.set('chips',    `date_posted:${dateRange},employment_type:FULLTIME`);
        url.searchParams.set('api_key',  SERPAPI_KEY);

        const res  = await fetch(url.toString());
        const data = await res.json();

        for (const job of (data.jobs_results || [])) {
          const key = job.job_id || job.title + job.company_name;
          if (seen.has(key)) continue;
          seen.add(key);
          const ext = job.detected_extensions || {};
          jobs.push({
            id:          job.job_id || `serp_${Math.random().toString(36).slice(2)}`,
            title:       job.title,
            company:     job.company_name || 'N/A',
            location:    job.location || 'N/A',
            description: job.description || '',
            url:         job.apply_options?.[0]?.link || job.share_link || '',
            salary_min:  ext.salary_min || null,
            salary_max:  ext.salary_max || null,
            via:         job.via || 'Google Jobs',
          });
        }
      } catch (e) {
        console.error(`  SerpAPI error (${query}/${location}):`, e.message);
      }
    }
  }

  return jobs;
}

// ── SCORE JOBS WITH GEMINI ────────────────────────────────────────────────────
async function scoreJobs(jobs: any[], resumeText: string): Promise<any[]> {
  const BATCH = 10;
  const all: any[] = [];

  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch  = jobs.slice(i, i + BATCH);
    const scored = await scoreBatch(batch, resumeText, i);
    all.push(...scored);
  }

  return all;
}

async function scoreBatch(jobs: any[], resumeText: string, offset: number): Promise<any[]> {
  const postingsJson = JSON.stringify(jobs.map((j, i) => ({
    index: i + offset, title: j.title, company: j.company,
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

Adjacent skills count only toward nice-to-haves, never toward core requirements.

Ask: "Could this candidate perform the core responsibilities on day one?" — not "Do they use similar words?"

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
  No relevant experience in the role's core function          → max 40
  Candidate seniority 2+ levels below role                   → max 45
  core_match_pct < 40%                                        → max 50
  Role requires software/backend/cloud/data engineering and candidate has no direct evidence → max 55
  core_match_pct < 60%                                        → max 60
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
[{"index":integer,"extracted_title":string,"skills":string[top 5 direct-match skills, sorted by relevance],"experience_years":integer,"summary":"[Role type 2-4 words]. You're strong in [2-3 matched strengths]. You're weak in [2-3 critical gaps]. e.g. 'AI Enablement Consultant. You're strong in stakeholder management, Power Platform, workshop delivery. You're weak in Python, cloud infrastructure, RAG.'","relevance_score":integer,"recommendation":"Apply"|"Maybe"|"Skip","company":string,"location":string,"url":string,"salary_min":number|null,"salary_max":number|null,"via":string}]

Evaluate all ${jobs.length} jobs now.`;

  let attempt = 0;
  while (attempt < 3) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );

    if (res.status === 429) {
      attempt++;
      await new Promise(r => setTimeout(r, attempt * 10000));
      continue;
    }

    if (!res.ok) throw new Error(`Gemini ${res.status}`);

    const data = await res.json();
    let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const start = raw.indexOf('[');
    const end   = raw.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('No JSON array in Gemini response');

    const scored = JSON.parse(raw.slice(start, end + 1));

    // Merge original job data back in — preserve original URL, company, location from fetch
    return scored.map((s: any) => {
      const orig = jobs[s.index - offset] || {};
      return {
        ...orig,
        ...s,
        url:        orig.url || '',
        company:    orig.company || s.company || 'N/A',
        location:   s.location || orig.location || 'N/A',
        via:        orig.via || '',
        salary_min: orig.salary_min || null,
        salary_max: orig.salary_max || null,
      };
    });
  }

  throw new Error('Gemini rate limit exceeded after 3 retries');
}

// ── SEND EMAIL VIA RESEND ─────────────────────────────────────────────────────
async function sendEmail(
  toEmail: string,
  jobs: any[],
  applyCount: number,
  maybeCount: number,
  date: string
) {
  const formattedDate = new Date(date + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  const html = buildEmailHtml(jobs, applyCount, maybeCount, formattedDate);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RESEND_KEY}`,
    },
    body: JSON.stringify({
      from: `JobRadar <${FROM_EMAIL}>`,
      to:   [toEmail],
      subject: `Your JobRadar Alert — ${applyCount} Apply, ${maybeCount} Maybe · ${formattedDate}`,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${err.slice(0, 200)}`);
  }

  console.log(`  Email sent to ${toEmail}`);
}

// ── EMAIL TEMPLATE ────────────────────────────────────────────────────────────
function buildEmailHtml(jobs: any[], applyCount: number, maybeCount: number, date: string): string {
  const applyJobs = jobs.filter(j => j.recommendation === 'Apply');
  const maybeJobs = jobs.filter(j => j.recommendation === 'Maybe');

  function jobRow(job: any, rec: 'Apply' | 'Maybe'): string {
    const color       = rec === 'Apply' ? '#00a36c' : '#e08c00';
    const bgColor     = rec === 'Apply' ? '#f0faf5' : '#fdf6e8';
    const borderColor = rec === 'Apply' ? '#b8e8d0' : '#f0d99a';
    const salary      = (job.salary_min && job.salary_max)
      ? `£${Math.round(job.salary_min / 1000)}k–£${Math.round(job.salary_max / 1000)}k`
      : '';
    const validUrl  = job.url && job.url !== 'N/A' && job.url.startsWith('http');
    const viewLink  = validUrl
      ? `<a href="${job.url}" style="display:inline-block;padding:6px 14px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-size:12px;font-weight:600;">View →</a>`
      : '';

    return `
    <tr>
      <td style="padding:16px 0;border-bottom:1px solid #e8e8e8;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:top;">
              <div style="display:inline-block;padding:3px 9px;background:${bgColor};border:1px solid ${borderColor};border-radius:20px;font-size:10px;font-weight:600;color:${color};letter-spacing:0.5px;text-transform:uppercase;margin-bottom:6px;">${rec}</div>
              <div style="font-family:'Georgia',serif;font-size:17px;font-weight:bold;color:#111;margin-bottom:4px;line-height:1.3;">${job.extracted_title || job.title}</div>
              <div style="font-size:13px;color:#555;margin-bottom:4px;font-weight:600;">${job.company}</div>
              <div style="font-size:12px;color:#999;font-family:monospace;margin-bottom:8px;">${job.location}${salary ? ' · ' + salary : ''}</div>
              ${job.summary ? `<div style="font-size:13px;color:#555;line-height:1.6;margin-bottom:10px;">${job.summary}</div>` : ''}
            </td>
            <td style="vertical-align:top;text-align:right;white-space:nowrap;padding-left:16px;">
              <div style="font-family:monospace;font-size:22px;font-weight:bold;color:${color};margin-bottom:4px;">${job.relevance_score}</div>
              <div style="font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">score</div>
              ${viewLink}
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="padding:28px 32px 20px;border-bottom:1px solid #e8e8e8;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <div style="font-family:'Georgia',serif;font-size:22px;font-weight:bold;color:#111;">Job<span style="color:#00a36c;">Radar</span></div>
                <div style="font-size:13px;color:#999;margin-top:3px;">${date}</div>
              </td>
              <td style="text-align:right;">
                <div style="display:inline-block;padding:4px 10px;background:#f0faf5;border:1px solid #b8e8d0;border-radius:20px;font-size:12px;font-weight:600;color:#00a36c;">${applyCount} Apply</div>
                &nbsp;
                <div style="display:inline-block;padding:4px 10px;background:#fdf6e8;border:1px solid #f0d99a;border-radius:20px;font-size:12px;font-weight:600;color:#e08c00;">${maybeCount} Maybe</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:0 32px 24px;">

          ${applyJobs.length ? `
          <!-- Apply section -->
          <div style="margin-top:24px;margin-bottom:4px;">
            <span style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#00a36c;">Apply — ${applyJobs.length} role${applyJobs.length !== 1 ? 's' : ''}</span>
          </div>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${applyJobs.map(j => jobRow(j, 'Apply')).join('')}
          </table>` : ''}

          ${maybeJobs.length ? `
          <!-- Maybe section -->
          <div style="margin-top:28px;margin-bottom:4px;">
            <span style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#e08c00;">Top Maybe — ${maybeJobs.length} role${maybeJobs.length !== 1 ? 's' : ''}</span>
          </div>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${maybeJobs.map(j => jobRow(j, 'Maybe')).join('')}
          </table>` : ''}

        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 32px;background:#fafafa;border-top:1px solid #e8e8e8;">
          <div style="font-size:12px;color:#aaa;line-height:1.6;">
            You're receiving this because you set up a daily alert on <a href="https://jobradar-mu.vercel.app" style="color:#00a36c;text-decoration:none;">JobRadar</a>.
            Results are scored against your saved resume using AI.
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
