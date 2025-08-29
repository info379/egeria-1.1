import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({
  origin: [
    // In produzione metti i tuoi domini, es: "https://upmanage.it"
    "*"
  ]
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('❌ OPENAI_API_KEY mancante. Impostala nelle Environment Variables (su Render).');
  process.exit(1);
}

let SYSTEM_PROMPT = '';
async function loadSystemPrompt() {
  const promptPath = path.join(__dirname, 'prompts', 'egeria-system-prompt.txt');
  SYSTEM_PROMPT = await fs.readFile(promptPath, 'utf-8');
  console.log('✅ System prompt caricato da file.');
}

// costruiamo i messaggi
function buildMessages(userPrompt, history = []) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userPrompt }
  ];
  return messages;
}

app.post('/api/egeria', async (req, res) => {
  try {
    const { prompt, history } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt mancante o non valido.' });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5',
        temperature: 1,
        messages: buildMessages(prompt, history),
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenAI error:', errText);
      return res.status(response.status).json({ error: 'Errore OpenAI', details: errText });
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    return res.json({ response: text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore nel backend' });
  }
});

app.post('/api/egeria/stream', async (req, res) => {
  try {
    const { prompt, history } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      res.writeHead(400, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
      });
      res.write('Prompt mancante o non valido.');
      return res.end();
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5',
        temperature: 0.7,
        stream: true,
        messages: buildMessages(prompt, history),
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text();
      console.error('OpenAI stream error:', errText);
      res.write(`data: ${JSON.stringify({ error: 'Errore OpenAI', details: errText })}\n\n`);
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.replace(/^data:\s*/, '');
        if (payload === '[DONE]') {
          res.write('data: {"done": true}\n\n');
          res.end();
          return;
        }
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content ?? '';
          if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        } catch {}
      }
    }

    res.write('data: {"done": true}\n\n');
    res.end();
  } catch (err) {
    console.error(err);
    try { res.write(`data: ${JSON.stringify({ error: 'Errore di streaming' })}\n\n`);} catch {}
    res.end();
  }
});

await loadSystemPrompt();

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`✅ Backend in ascolto sulla porta ${port}`);
});
