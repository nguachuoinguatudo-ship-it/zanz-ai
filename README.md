# Zanz Ai — Deploy (Vercel / Netlify)

Mirror Zanz Ai siap deploy dengan keamanan maksimal. API key Gemini TIDAK pernah
dikirim ke browser — hanya disimpan sebagai environment variable di server.

## Isi folder

- `index.html` + `zanz.js` — halaman & shim (versi deploy: flag `window.ZANZ_API_PROXY`)
- `dist/zanzai-dist/`, `font/`, `favicon*`, `zanz-logo.jpeg`, `site.webmanifest` — aset statis
- `api/chat.js` — serverless proxy Gemini (format Vercel)
- `netlify/functions/chat.js` — serverless proxy Gemini (format Netlify)
- `vercel.json` — config Vercel (rewrites + security headers)
- `netlify.toml` — config Netlify (redirects + security headers)

## Cara deploy

### Vercel (recommended)
1. Push folder ini ke GitHub (atau gunakan `vercel` CLI: `vercel --prod`).
2. Set environment variable: `GEMINI_API_KEY` = kunci API Gemini kamu.
3. Deploy. Selesai — key tidak pernah terlihat di client.

### Netlify
1. Drag & drop folder ini ke https://app.netlify.com/drop (Build command: kosong / `echo`).
2. Set environment variable: `GEMINI_API_KEY`.
3. Pastikan fungsi terdeteksi di `netlify/functions/chat.js`.

## Keamanan

- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
- CSP ketat (frame-ancestors 'none', object-src 'none')
- HSTS + Permissions-Policy
- Cache immutable untuk aset ber-hash (`/dist/*`, `/font/*`)
- API key hanya di env server; proxy pakai header `x-goog-api-key` (tidak bocor lewat URL)

## Catatan

- Tanpa key: chat menampilkan pesan "Atur API Key Gemini dulu" (401 dari shim).
- Mode lokal (tanpa serverless): `ZANZ_API_PROXY` tidak diset → chat langsung ke Gemini dengan key dari localStorage.
