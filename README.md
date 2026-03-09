# Bahis Asistanı Backend Paketi

Bu paket, GitHub Pages üzerinde çalışan ön yüzü gerçek bir backend'e bağlamak için hazırlandı.

## Ne yapar?

- `/health` ile servis durumunu döner
- `/analyze` ile:
  - seçili günün maçlarını çeker
  - son 5 H2H verisini alır
  - son 10 maçlık takım formunu toplar
  - puan durumu / sıra bağlamını toplar
  - OpenAI modeline temiz veri verip JSON analiz çıktısı üretir

## Gerekenler

- Node.js 18+
- OpenAI API key
- API-Football API key

## Kurulum

```bash
npm install
cp .env.example .env
```

`.env` dosyasını doldur.

## Lokal çalıştırma

```bash
npm run dev
```

veya

```bash
npm start
```

Sunucu varsayılan olarak:

```text
http://localhost:3000
```

## Test

Tarayıcıda:

```text
http://localhost:3000/health
```

## Frontend bağlantısı

HTML dosyandaki backend alanına şunu yaz:

```text
https://senin-render-adresin.onrender.com/analyze
```

Lokal testte:

```text
http://localhost:3000/analyze
```

## Render deploy

1. Bu klasörü GitHub'a yükle
2. Render'da **New Web Service**
3. Repo seç
4. Build Command:
   `npm install`
5. Start Command:
   `npm start`
6. Environment Variables bölümüne şunları gir:
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL`
   - `API_FOOTBALL_KEY`
   - `API_FOOTBALL_BASE_URL`

## Notlar

- Frontend tarafına API key koyma.
- GitHub Pages yalnızca statik yayın içindir; backend ayrı çalışmalıdır.
- Eğer maç yoksa backend boş dizi döner:
  `{ "tips": [] }`

## Beklenen istek gövdesi

```json
{
  "date": "2026-03-09",
  "match_limit": 10,
  "league_mode": "major",
  "custom_leagues": [],
  "extra_prompt": "Analiz aşamasında mutlaka form, H2H ve risk dengesi öne çıksın."
}
```
