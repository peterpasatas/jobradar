// api/chat.js
// Mistral Nemo chat — server-side, key never exposed to browser
// Model: open-mistral-nemo-2407 — $0.02/M input, $0.04/M output

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { messages, systemPrompt } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages required' });

    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'open-mistral-nemo-2407',
        messages: [
          { role: 'system', content: systemPrompt || 'You are a straight-to-the-point career assistant.' },
          ...messages,
        ],
        max_tokens: 600,
        temperature: 0.4,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `Mistral error: ${err.slice(0, 200)}` });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({ reply });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
