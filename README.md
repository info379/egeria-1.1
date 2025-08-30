# Egeria Starter (UpManage)

Progetto minimale per far girare Egeria su Render collegato a GitHub.

## 1) Cosa c'è dentro
- `server.js` — backend Node/Express con due endpoint (`/api/egeria` e `/api/egeria/stream`)
- `public/index.html` — interfaccia chat semplice con storico e streaming (messo ora in front end HTML)
- `prompts/egeria-system-prompt.txt` — system prompt esterno
- `package.json` — dipendenze e script
- `.env.example` — esempio di variabili
- `render.yaml` — (opzionale) deploy come Blueprint su Render

## 2) Come usarlo
1. Carica questi file su un nuovo repo GitHub.
2. Su Render: New → Web Service → collega il repo.
3. Build Command: `npm ci` — Start Command: `node server.js`.
4. Aggiungi l'env `OPENAI_API_KEY` nel pannello di Render.
5. Apri l'URL pubblico del servizio: vedrai la chat.

> Non caricare `.env` su GitHub. Imposta la chiave direttamente su Render.
