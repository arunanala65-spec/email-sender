# Email Sender — web based

Kirim email lewat browser. Provider: **SMTP generik, AWS SES (API), SendGrid, Mailgun, Mailjet, Brevo, Resend**.
Composer HTML letter + live preview + 3 template surat siap pakai + lampiran (maks 5 MB) + riwayat kirim. Maksimal 50 penerima per kirim.

## Jalankan lokal

```bash
npm install
npm start
# buka http://localhost:3000
```

## Kredensial — PENTING

- Kredensial diisi di halaman web tiap kali kirim. Server **tidak menyimpan** kredensial.
- Opsional: centang "Ingat di browser ini" — tersimpan di localStorage browser sendiri, bukan di server.
- Opsional: isi sebagai environment variable di hosting (lihat `.env.example`) sebagai default.
- **Jangan pernah commit file `.env` berisi kunci asli.** `.gitignore` sudah menolak `.env` dan folder `data/` (log kirim).
- Kalau pakai `APP_PASSWORD`, halaman web minta password itu dulu sebelum bisa kirim. Sangat disarankan kalau URL-nya publik.
- Riwayat kirim tersimpan lokal di `data/send-log.json` (waktu, provider, penerima, subjek, status, message ID / error) — **tanpa kredensial**. Di hosting serverless (Vercel) log hanya bertahan di memori selama instance hidup.

## Hosting gratis (pilihan utama: Render Free)

| Hosting | Gratis | SMTP 465/587 | Catatan |
|---|---|---|---|
| **Render Free (pilihan utama)** | Ya, tanpa kartu, 750 jam/bln | ⚠️ Kadang diblokir di free tier | Tidur setelah 15 mnt idle, bangun 30–60 detik. API provider (HTTPS) tetap jalan. `render.yaml` sudah disiapkan. |
| Vercel Hobby (cadangan) | Ya, tanpa kartu | ✅ Buka (port 25 diblokir) | Serverless Node, `vercel.json` sudah disiapkan. Batas: personal/non-komersial. |
| Railway (alternatif) | Trial $5, lalu bayar | ✅ | Deploy dari GitHub, tambah `APP_PASSWORD` di Variables. |
| Fly.io (alternatif) | Ada free allowance | ✅ | Perlu `flyctl launch` + kartu untuk verifikasi (tidak ditagih di free allowance). |
| Koyeb (alternatif) | Free instance | ✅ | Deploy dari GitHub, pilih instance Free. |

FadeHost Free **tidak bisa** dipakai: jatah 1 Free per akun sudah dipakai bot Telegram IMAP checker.

## Deploy (Render Free, ~5 menit)

1. Push repo ini ke GitHub `arunanala65-spec/email-sender` (publik).
2. Di render.com → New → Web Service → pilih repo → plan **Free** → Deploy (pakai `render.yaml`).
3. Dashboard Render → Environment → tambah `APP_PASSWORD` (pilih sendiri, ingat baik-baik).
4. Buka URL `https://email-sender-xxx.onrender.com`, isi password, pilih provider, isi kredensial, kirim.

## Deploy (Vercel, cadangan)

1. Push ke GitHub, di vercel.com → Add New Project → Import repo → Deploy.
2. Settings → Environment Variables → tambah `APP_PASSWORD`.
3. Buka URL `https://email-sender-xxx.vercel.app`.

## Isi kredensial tiap provider

| Provider | Yang diisi di halaman web | Cara dapat kunci |
|---|---|---|
| SMTP generik | Host, port, TLS, username, password | Dari penyedia emailmu (mis. Gmail pakai App Password) |
| AWS SES (API) | Region, Access Key ID, Secret Access Key | AWS Console → IAM → buat user + kunci, lampirkan policy `ses:SendEmail` / `ses:SendRawEmail`. **Pakai kunci AWS milikmu sendiri** — jangan pakai kunci orang lain dan jangan tempel kunci di chat. |
| SendGrid | API Key | sendgrid.com → Settings → API Keys |
| Mailgun | API Key, domain, region US/EU | mailgun.com → Settings → API Keys; domain di Sending → Domains |
| Mailjet | API Key, Secret Key | mailjet.com → Account Settings → API Keys |
| Brevo | API Key | brevo.com → SMTP & API → API Keys |
| Resend | API Key | resend.com → API Keys |

### ⚠️ Catatan khusus AWS SES

- Region default `ap-south-1` (Mumbai). Kalau akun SES-mu di region lain, ganti di kolom Region. Akun SES Rudy ada di `ap-south-1`, pengirim `mailing@ecell.in`.
- **Sandbox SES:** kalau akun masih sandbox, pengirim DAN penerima harus sudah terverifikasi di SES (SES Console → Verified identities), dan kirim hanya boleh ke alamat terverifikasi. Minta "production access" di SES Console kalau mau kirim ke siapa saja.
- Akun SES ecell.in per 19 Nov 2026: bounce rate **4,3%** (batas jeda SES 5%), complaint rate **0,21%** (ambang 0,1%). Jangan kirim massal — akun berisiko dibatasi. Pakai hanya untuk tes dan kirim seperlunya.
- Access key yang pernah ditempel mentah di chat harus **dirotasi/dicabut** di konsol AWS.

## API

- `GET /api/health` — status + daftar provider.
- `GET /api/history` — riwayat kirim (butuh header `x-app-password` kalau `APP_PASSWORD` aktif).
- `POST /api/test` — `{provider, creds, from}` → tes koneksi (SMTP: verify; API: kirim 1 email tes ke pengirim sendiri).
- `POST /api/send` — `{provider, creds, fromName, from, replyTo, to, cc, bcc, subject, html}` → kirim. Lampiran: kirim sebagai `multipart/form-data` dengan field `attachments` (total maks 5 MB). Header `x-app-password` kalau `APP_PASSWORD` diaktifkan.
