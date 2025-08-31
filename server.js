// server.js — API only, CORS hard-coded, POST+GET streaming SSE
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// ---------- CORS hard-coded ----------
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server / Postman
    if (
      origin === 'https://upmanage.it' ||
      origin === 'https://www.upmanage.it' ||
      origin === 'http://localhost:3000' || // opzionale test
    ) return cb(null, true);
    return cb(new Error(`Origin non autorizzata: ${origin}`), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'], // <-- GET necessario per EventSource
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ---------- OpenAI + Prompt ----------
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('❌ Mancante OPENAI_API_KEY. Impostala nelle Environment Variables (Render).');
  process.exit(1);
}

let SYSTEM_PROMPT = '';
async function loadSystemPrompt() {
  const promptPath = path.join(__dirname, 'prompts', 'egeria-system-prompt.txt');
  SYSTEM_PROMPT = await fs.readFile(promptPath, 'utf-8');
  console.log('✅ System prompt caricato da file.');
}

function buildMessages(prompt, history = []) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: prompt }
  ];
}

function setSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // riduce buffering su proxy
  res.flushHeaders?.();
  res.write(':\n\n'); // primo pacchetto per sbloccare proxy
}

async function pipeOpenAIStream(messages, res) {
  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-5',
      stream: true,
      messages
    })
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text();
    console.error('OpenAI stream error:', errText);
    res.write(`data: ${JSON.stringify({ error: 'Errore OpenAI', details: errText })}\n\n`);
    res.end();
    return;
  }

  // Heartbeat per tenere viva la connessione
  const keepAlive = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 15000);

  const reader  = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8');

  try {
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
          clearInterval(keepAlive);
          res.end();
          return;
        }
        try {
          const json  = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content ?? '';
          if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        } catch {
          // keepalive/non-JSON: ignora
        }
      }
    }
    res.write('data: {"done": true}\n\n');
  } catch (e) {
    try { res.write(`data: ${JSON.stringify({ error: 'Errore di streaming interno' })}\n\n`); } catch {}
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
}

// ---------- NON-STREAM (POST) ----------
app.post('/api/egeria', async (req, res) => {
  try {
    const { prompt, history } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt mancante o non valido.' });
    }

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-5',
        messages: buildMessages(prompt, history)
      })
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('OpenAI error:', errText);
      return res.status(upstream.status).json({ error: 'Errore OpenAI', details: errText });
    }

    const data = await upstream.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    return res.json({ response: text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore nel backend' });
  }
});

// ---------- STREAM (POST) ----------
app.post('/api/egeria/stream', async (req, res) => {
  try {
    const { prompt, history } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      res.status(400);
      setSseHeaders(res);
      res.write(`data: ${JSON.stringify({ error: 'Prompt mancante o non valido.' })}\n\n`);
      return res.end();
    }
    setSseHeaders(res);
    await pipeOpenAIStream(buildMessages(prompt, history), res);
  } catch (err) {
    console.error(err);
    try { setSseHeaders(res); res.write(`data: ${JSON.stringify({ error: 'Errore di streaming' })}\n\n`); } catch {}
    res.end();
  }
});

// ---------- STREAM (GET) per EventSource ----------
app.get('/api/egeria/stream', async (req, res) => {
  try {
    const prompt = (req.query.prompt ?? '').toString();
    const historyB64 = (req.query.history ?? '').toString();

    if (!prompt) {
      res.status(400);
      setSseHeaders(res);
      res.write(`data: ${JSON.stringify({ error: 'Prompt mancante o non valido.' })}\n\n`);
      return res.end();
    }

    let history = [];
    try {
      if (historyB64) {
        const json = Buffer.from(historyB64, 'base64').toString('utf-8');
        history = JSON.parse(json);
      }
    } catch {
      // storia malformata: ignora
      history = [];
    }

    setSseHeaders(res);
    await pipeOpenAIStream(buildMessages(prompt, history), res);
  } catch (err) {
    console.error(err);
    try { setSseHeaders(res); res.write(`data: ${JSON.stringify({ error: 'Errore di streaming' })}\n\n`); } catch {}
    res.end();
  }
});

// ---------- Endpoint test streaming ----------
app.get('/api/test-stream', (req, res) => {
  setSseHeaders(res);
  let i = 0;
  const t = setInterval(() => {
    i++;
    res.write(`data: ${JSON.stringify({ tick: i })}\n\n`);
    if (i >= 5) {
      clearInterval(t);
      res.write('data: {"done": true}\n\n');
      res.end();
    }
  }, 800);
});

// ---------- Start ----------
await loadSystemPrompt();
const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`✅ Backend Egeria in ascolto sulla porta ${port}`);
});
