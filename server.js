// Email Sender — server.js
// Satu server Express kecil: melayani UI statis + POST /api/send, /api/test, GET /api/history.
// KREDENSIAL TIDAK PERNAH DISIMPAN DI SERVER: kredensial dikirim browser di tiap
// request, dipakai sekali untuk mengirim, lalu dibuang. Kalau kredensial diisi
// lewat environment variable (.env di hosting), itu yang dipakai sebagai default.
// Jangan pernah commit file .env berisi kunci asli ke GitHub.
const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { SESClient, SendEmailCommand, SendRawEmailCommand } = require('@aws-sdk/client-ses');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const APP_PASSWORD = process.env.APP_PASSWORD || '';
const MAX_RECIPIENTS = 50; // batas keamanan: kirim massal besar dilarang dari tool ini
const MAX_ATTACH_TOTAL = 5 * 1024 * 1024; // 5 MB total lampiran

// ---------- riwayat kirim (log lokal, tanpa kredensial) ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'send-log.json');
let sendLog = [];
try {
  if (fs.existsSync(LOG_FILE)) sendLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  if (!Array.isArray(sendLog)) sendLog = [];
} catch (e) { sendLog = []; }
function saveLog() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(LOG_FILE, JSON.stringify(sendLog, null, 2)); } catch (e) { /* hosting serverless: log hanya di memori */ }
}
function logAttempt(entry) {
  sendLog.unshift({ time: new Date().toISOString(), ...entry });
  if (sendLog.length > 200) sendLog.length = 200;
  saveLog();
}

// ---------- util ----------
function checkAuth(req, res) {
  if (!APP_PASSWORD) return true;
  if (req.headers['x-app-password'] === APP_PASSWORD) return true;
  res.status(401).json({ ok: false, error: 'Password aplikasi salah atau belum diisi.' });
  return false;
}
function parseList(v) {
  return String(v || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
}
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function htmlToText(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}
function pick(body, envName, fallback = '') {
  const v = body && body[envName] !== undefined && body[envName] !== '' ? body[envName] : process.env[envName];
  return v === undefined || v === null ? fallback : String(v);
}
function formatFrom(name, email) {
  return name ? `${name} <${email}>` : email;
}
// Lampiran dari multer: [{ originalname, mimetype, buffer }]
function totalAttachSize(files) { return (files || []).reduce((n, f) => n + (f.buffer ? f.buffer.length : 0), 0); }
function b64Attachments(files) {
  return (files || []).map(f => ({ filename: f.originalname, content: f.buffer.toString('base64'), type: f.mimetype }));
}

// ---------- pengirim per provider ----------
async function sendViaSmtp(cfg, msg, files) {
  const transporter = nodemailer.createTransport({
    host: cfg.host, port: Number(cfg.port) || 587,
    secure: cfg.secure === true || cfg.secure === 'true' || Number(cfg.port) === 465,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
  });
  await transporter.verify();
  const mail = { from: msg.from, to: msg.to, cc: msg.cc, bcc: msg.bcc,
    replyTo: msg.replyTo, subject: msg.subject, html: msg.html, text: msg.text };
  if (files && files.length) mail.attachments = files.map(f => ({ filename: f.originalname, content: f.buffer, contentType: f.mimetype }));
  return transporter.sendMail(mail);
}

async function sendViaSesApi(cfg, msg, files) {
  const client = new SESClient({ region: cfg.region || 'ap-south-1',
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
  if (files && files.length) {
    // Dengan lampiran: bangun MIME mentah lalu SendRawEmailCommand
    const MailComposer = require('nodemailer/lib/mail-composer');
    const mail = new MailComposer({ from: msg.from, to: msg.to, cc: msg.cc, bcc: msg.bcc,
      replyTo: msg.replyTo, subject: msg.subject, html: msg.html, text: msg.text,
      attachments: files.map(f => ({ filename: f.originalname, content: f.buffer, contentType: f.mimetype })) });
    const raw = await new Promise((resolve, reject) => mail.compile().build((e, b) => e ? reject(e) : resolve(b)));
    const out = await client.send(new SendRawEmailCommand({ RawMessage: { Data: raw } }));
    return { messageId: out.MessageId, accepted: msg.to };
  }
  const cmd = new SendEmailCommand({
    Source: msg.from,
    Destination: { ToAddresses: msg.to || [], CcAddresses: msg.cc || [], BccAddresses: msg.bcc || [] },
    Message: {
      Subject: { Data: msg.subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: msg.html, Charset: 'UTF-8' },
        Text: { Data: msg.text, Charset: 'UTF-8' },
      },
    },
    ReplyToAddresses: msg.replyTo ? [msg.replyTo] : undefined,
  });
  const out = await client.send(cmd);
  return { messageId: out.MessageId, accepted: msg.to };
}

async function sendViaHttp(url, opts) {
  // Timeout 20 detik supaya request yang macet (mis. jaringan diblokir) tidak menggantung selamanya
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  let messageId = '';
  try { const j = JSON.parse(text); messageId = j.id || j.message_id || j.MessageId || j.messageId || ''; } catch (e) { messageId = text.slice(0, 120); }
  return { messageId, accepted: [] };
}

async function dispatch(provider, creds, msg, files) {
  switch (provider) {
    case 'smtp': return sendViaSmtp(creds, msg, files);
    case 'ses': return sendViaSesApi(creds, msg, files);
    case 'sendgrid': {
      const payload = { personalizations: [{ to: (msg.to || []).map(e => ({ email: e })) }],
        from: { email: msg.fromEmail, name: msg.fromName || undefined }, subject: msg.subject,
        content: [{ type: 'text/html', value: msg.html }, { type: 'text/plain', value: msg.text }] };
      if (msg.cc?.length) payload.personalizations[0].cc = msg.cc.map(e => ({ email: e }));
      if (msg.bcc?.length) payload.personalizations[0].bcc = msg.bcc.map(e => ({ email: e }));
      if (msg.replyTo) payload.reply_to = { email: msg.replyTo };
      if (files?.length) payload.attachments = b64Attachments(files);
      return sendViaHttp('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST', headers: { Authorization: `Bearer ${creds.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload) });
    }
    case 'mailgun': {
      const base = creds.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
      const form = new FormData();
      form.set('from', msg.from); form.set('subject', msg.subject);
      form.set('html', msg.html); form.set('text', msg.text);
      (msg.to || []).forEach(e => form.append('to', e));
      (msg.cc || []).forEach(e => form.append('cc', e));
      (msg.bcc || []).forEach(e => form.append('bcc', e));
      if (msg.replyTo) form.set('h:Reply-To', msg.replyTo);
      (files || []).forEach(f => form.append('attachment', new Blob([f.buffer], { type: f.mimetype }), f.originalname));
      return sendViaHttp(`${base}/v3/${creds.domain}/messages`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`api:${creds.apiKey}`).toString('base64') },
        body: form });
    }
    case 'mailjet': {
      const payload = { Messages: [{ From: { Email: msg.fromEmail, Name: msg.fromName || undefined }, Subject: msg.subject,
        HTMLPart: msg.html, TextPart: msg.text,
        To: (msg.to || []).map(e => ({ Email: e })),
        Cc: (msg.cc || []).map(e => ({ Email: e })),
        Bcc: (msg.bcc || []).map(e => ({ Email: e })) }] };
      if (msg.replyTo) payload.Messages[0].ReplyTo = { Email: msg.replyTo };
      if (files?.length) payload.Messages[0].Attachments = (files || []).map(f => ({ ContentType: f.mimetype, Filename: f.originalname, Base64Content: f.buffer.toString('base64') }));
      return sendViaHttp('https://api.mailjet.com/v3.1/send', {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`${creds.apiKey}:${creds.secretKey}`).toString('base64'),
          'Content-Type': 'application/json' },
        body: JSON.stringify(payload) });
    }
    case 'brevo': {
      const payload = { sender: { email: msg.fromEmail, name: msg.fromName || undefined }, subject: msg.subject,
        htmlContent: msg.html, textContent: msg.text,
        to: (msg.to || []).map(e => ({ email: e })),
        cc: (msg.cc || []).map(e => ({ email: e })),
        bcc: (msg.bcc || []).map(e => ({ email: e })) };
      if (msg.replyTo) payload.replyTo = { email: msg.replyTo };
      if (files?.length) payload.attachment = b64Attachments(files).map(a => ({ content: a.content, name: a.filename }));
      return sendViaHttp('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': creds.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload) });
    }
    case 'resend': {
      const payload = { from: msg.from, to: msg.to, subject: msg.subject,
        html: msg.html, text: msg.text };
      if (msg.cc?.length) payload.cc = msg.cc;
      if (msg.bcc?.length) payload.bcc = msg.bcc;
      if (msg.replyTo) payload.reply_to = msg.replyTo;
      if (files?.length) payload.attachments = b64Attachments(files);
      return sendViaHttp('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${creds.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload) });
    }
    default: throw new Error('Provider tidak dikenal: ' + provider);
  }
}

function buildMessage(body) {
  const to = parseList(body.to);
  const cc = parseList(body.cc);
  const bcc = parseList(body.bcc);
  const fromEmail = String(body.from || process.env.DEFAULT_FROM || '').trim();
  const fromName = String(body.fromName || '').trim();
  const subject = String(body.subject || '').trim();
  const html = String(body.html || '').trim();
  if (!fromEmail || !validEmail(fromEmail)) throw new Error('From tidak valid. Isi alamat pengirim yang sudah terverifikasi di provider.');
  if (!to.length) throw new Error('Isi minimal 1 penerima (To).');
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw new Error(`Maksimal ${MAX_RECIPIENTS} penerima per kirim.`);
  for (const e of [...to, ...cc, ...bcc]) if (!validEmail(e)) throw new Error('Alamat tidak valid: ' + e);
  if (!subject) throw new Error('Isi subjek email.');
  if (!html) throw new Error('Isi HTML letter.');
  const replyTo = String(body.replyTo || '').trim();
  if (replyTo && !validEmail(replyTo)) throw new Error('Reply-To tidak valid: ' + replyTo);
  return { from: formatFrom(fromName, fromEmail), fromEmail, fromName, to, cc, bcc, subject, html,
    text: htmlToText(html), replyTo: replyTo || undefined };
}

function credsFor(provider, body) {
  const c = body.creds || {};
  switch (provider) {
    case 'smtp': {
      const host = pick(c, 'SMTP_HOST'), user = pick(c, 'SMTP_USER'), pass = pick(c, 'SMTP_PASS');
      if (!host || !user || !pass) throw new Error('SMTP butuh host, username, dan password. Contoh AWS SES SMTP: email-smtp.ap-south-1.amazonaws.com:587.');
      return { host, port: pick(c, 'SMTP_PORT', '587'), secure: pick(c, 'SMTP_SECURE', 'false'), user, pass };
    }
    case 'ses': {
      const accessKeyId = pick(c, 'AWS_ACCESS_KEY_ID'), secretAccessKey = pick(c, 'AWS_SECRET_ACCESS_KEY');
      if (!accessKeyId || !secretAccessKey) throw new Error('AWS SES butuh Access Key ID dan Secret Access Key.');
      return { region: pick(c, 'AWS_REGION', 'ap-south-1'), accessKeyId, secretAccessKey };
    }
    case 'sendgrid': case 'brevo': case 'resend': {
      const apiKey = pick(c, provider === 'sendgrid' ? 'SENDGRID_API_KEY' : provider === 'brevo' ? 'BREVO_API_KEY' : 'RESEND_API_KEY');
      if (!apiKey) throw new Error('API key ' + provider + ' belum diisi.');
      return { apiKey };
    }
    case 'mailgun': {
      const apiKey = pick(c, 'MAILGUN_API_KEY'), domain = pick(c, 'MAILGUN_DOMAIN');
      if (!apiKey || !domain) throw new Error('Mailgun butuh API key dan domain pengirim.');
      return { apiKey, domain, region: pick(c, 'MAILGUN_REGION', 'us') };
    }
    case 'mailjet': {
      const apiKey = pick(c, 'MAILJET_API_KEY'), secretKey = pick(c, 'MAILJET_SECRET_KEY');
      if (!apiKey || !secretKey) throw new Error('Mailjet butuh API key dan Secret key.');
      return { apiKey, secretKey };
    }
    default: throw new Error('Provider tidak dikenal: ' + provider);
  }
}

// ---------- routes ----------
app.get('/api/health', (req, res) => res.json({ ok: true, providers: ['smtp', 'ses', 'sendgrid', 'mailgun', 'mailjet', 'brevo', 'resend'], passwordSet: Boolean(APP_PASSWORD) }));

app.get('/api/history', (req, res) => {
  if (!checkAuth(req, res)) return;
  res.json({ ok: true, history: sendLog });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACH_TOTAL } });
// Terima JSON biasa ATAU multipart (kalau ada lampiran)
app.use('/api/send', (req, res, next) => {
  if (req.is('multipart/form-data')) {
    upload.array('attachments', 10)(req, res, (err) => {
      if (err) return res.status(400).json({ ok: false, error: 'Lampiran gagal dibaca: ' + err.message });
      try { req.body.creds = JSON.parse(req.body.creds || '{}'); } catch (e) { req.body.creds = {}; }
      next();
    });
  } else next();
});

app.post('/api/test', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const provider = req.body.provider || 'smtp';
    if (provider === 'smtp') {
      const creds = credsFor('smtp', req.body);
      const t = nodemailer.createTransport({ host: creds.host, port: Number(creds.port) || 587,
        secure: Number(creds.port) === 465, auth: { user: creds.user, pass: creds.pass },
        connectionTimeout: 15000, greetingTimeout: 15000 });
      await t.verify();
      return res.json({ ok: true, message: 'Koneksi SMTP OK.' });
    }
    // Provider API: tes dengan mengirim 1 email tes ke pengirim sendiri
    const msg = buildMessage({ ...req.body, to: req.body.from, subject: 'Tes koneksi Email Sender', html: '<p>Tes koneksi berhasil.</p>' });
    const creds = credsFor(provider, req.body);
    const out = await dispatch(provider, creds, msg, []);
    res.json({ ok: true, message: 'Tes terkirim ke ' + msg.fromEmail, messageId: out.messageId || '' });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

app.post('/api/send', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const files = req.files || [];
  if (totalAttachSize(files) > MAX_ATTACH_TOTAL) {
    return res.status(400).json({ ok: false, error: 'Total lampiran maksimal 5 MB.' });
  }
  const provider = req.body.provider || 'smtp';
  let msg;
  try { msg = buildMessage(req.body); } catch (e) {
    logAttempt({ provider, to: String(req.body.to || ''), subject: String(req.body.subject || ''), status: 'gagal', error: String(e.message || e) });
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }
  try {
    const creds = credsFor(provider, req.body);
    const out = await dispatch(provider, creds, msg, files);
    logAttempt({ provider, to: msg.to.join(', '), subject: msg.subject, status: 'terkirim',
      messageId: out.messageId || '', attachments: files.map(f => f.originalname) });
    res.json({ ok: true, message: `Terkirim ke ${msg.to.length} penerima via ${provider}.`, messageId: out.messageId || '' });
  } catch (e) {
    logAttempt({ provider, to: msg.to.join(', '), subject: msg.subject, status: 'gagal', error: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => console.log('Email Sender jalan di port ' + PORT));
module.exports = app;
