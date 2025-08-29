// server.js — API only, CORS hard-coded, streaming migliorato
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// -------------------- Setup base --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// -------------------- CORS: domini consentiti SCRITTI nel codice --------------------
const corsOptions = {
  origin(origin, cb) {
    // Consenti richieste server-to-server / Postman (senza header Origin)
    if (!origin) return cb(null, true);

    // ✅ Metti qui i tuoi domini frontend
    if (
      origin === 'https://upmanage.it' ||
      origin === 'https://www.upmanage.it' ||
      origin === 'http://localhost:3000' || // opzionale: test locale
      origin === 'http://localhost:5173'    // opzionale: test locale (Vite)
    ) {
      return cb(null, true);
    }
    return cb(new Error(`Origin non autorizzata: ${origin}`), false);
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // preflight

// -------------------- OpenAI + System Prompt --------------------
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
function buildMessages(userPrompt, history = []) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userPrompt }
  ];
}

// -------------------- Endpoint NON-STREAM --------------------
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
        temperature: 0.7,
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

// -------------------- Endpoint STREAM (SSE) --------------------
app.post('/api/egeria/stream', async (req, res) => {
  try {
    const { prompt, history } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      res.writeHead(400, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked'
      });
      res.write('Prompt mancante o non valido.');
      return res.end();
    }

    // Intestazioni per SSE + anti-buffering
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // riduce buffering su proxy tipo nginx
    res.flushHeaders?.(); // invia subito gli header se disponibile

    // Sblocca lo stream su alcuni proxy inviando un primo pacchetto
    res.write(':\n\n'); // comment/heartbeat SSE

    // Heartbeat periodico per tenere viva la connessione
    const keepAlive = setInterval(() => {
      try { res.write(':\n\n'); } catch {}
    }, 15000);

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-5',
        temperature: 0.7,
        stream: true,
        messages: buildMessages(promp
