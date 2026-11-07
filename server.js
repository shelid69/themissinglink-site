// The Missing Link: site + booking request server. No dependencies (Node 18+).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.SITE_DOMAIN || 'themissinglink.co';
const ALERT_TO = process.env.ALERT_TO || 'shelidisher@gmail.com';
const MAIL_FROM = process.env.MAIL_FROM || `Knead by Massage Sheli <booking@${DOMAIN}>`;
const FALLBACK_FROM = 'Knead by Massage Sheli <onboarding@resend.dev>'; // works before the domain is verified, alerts to the Resend account owner only
const PHONE = '732-859-8202';
const PUBLIC = path.join(__dirname, 'public');

const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };

const ROBOTS = `User-agent: *\nAllow: /\nSitemap: https://${DOMAIN}/sitemap.xml\n`;
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${DOMAIN}/</loc></url></urlset>\n`;

// rate limits: 8 per IP per hour, 4 per email per hour
const hits = new Map();
function limited(key, max) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < 3600e3);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const digits = s => { const n = String(s || '').replace(/\D/g, ''); return n.length === 11 && n[0] === '1' ? n.slice(1) : n; };
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); }

async function resend(payload) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');
  const post = body => fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  let r = await post({ from: MAIL_FROM, ...payload });
  if (r.status === 403 || r.status === 422) r = await post({ from: FALLBACK_FROM, ...payload });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  return r.json();
}

function prettyDate(d) {
  const t = new Date(d + 'T12:00:00');
  return isNaN(t) ? d : t.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

const L = 'color:#0b4a55;font-weight:bold;text-decoration:underline';
function linkRow(label, html) { return `<tr><td style="padding:6px 12px 6px 0;color:#4f6366;vertical-align:top;white-space:nowrap">${esc(label)}</td><td style="padding:6px 0">${html}</td></tr>`; }
function row(label, value) {
  return value ? `<tr><td style="padding:6px 12px 6px 0;color:#4f6366;vertical-align:top;white-space:nowrap">${esc(label)}</td><td style="padding:6px 0;color:#14282b">${esc(value).replace(/\n/g, '<br>')}</td></tr>` : '';
}
function wrap(title, inner) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f8f5ef;color:#14282b">
<h2 style="font-family:Georgia,serif;color:#0a2f35;margin:0 0 16px">${esc(title)}</h2>${inner}
<p style="margin-top:24px;font-size:13px;color:#4f6366">Knead by Massage Sheli &middot; The Missing Link &middot; Oakhurst, NJ &middot; Text ${PHONE}</p></div>`;
}

async function handleBooking(req, res) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 20000) return json(res, 413, { error: 'Request too large.' }); }
  let b; try { b = JSON.parse(raw); } catch { return json(res, 400, { error: 'Invalid request.' }); }

  if (b.website) return json(res, 200, { ok: true }); // honeypot: pretend success

  const d = {
    name: clip(b.name, 100), phone: clip(b.phone, 40), email: clip(b.email, 200).toLowerCase(),
    length: clip(b.length, 20), date: clip(b.date, 10), time: clip(b.time, 60), alt: clip(b.alt, 200),
    focus: Array.isArray(b.focus) ? b.focus.slice(0, 8).map(f => clip(f, 40)) : [],
    area: clip(b.area, 1500), heard: clip(b.heard, 40)
  };
  if (!d.name || !d.phone) return json(res, 400, { error: 'Please add your name and phone number.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return json(res, 400, { error: 'Please enter a valid email.' });
  if (!['60 min', '90 min', '120 min'].includes(d.length)) return json(res, 400, { error: 'Please pick a session length.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !d.time) return json(res, 400, { error: 'Please choose your preferred date and time.' });
  if (b.ack !== true) return json(res, 400, { error: 'Please check the box to confirm you understand this is a request.' });

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited('ip:' + ip, 8) || limited('em:' + d.email, 4)) return json(res, 429, { error: `Too many requests. Please text ${PHONE}.` });

  const when = `${prettyDate(d.date)} at ${d.time}`;
  const first = d.name.split(' ')[0], num = digits(d.phone);
  const tel = `tel:+1${num}`, txt = `https://${DOMAIN}/text?to=${num}&amp;name=${encodeURIComponent(first)}`;
  const mail = `mailto:${esc(d.email)}?subject=${encodeURIComponent('Your session request with Knead by Massage Sheli')}`;
  const details = row('Name', d.name) +
    linkRow('Phone', `<a href="${tel}" style="${L}">${esc(d.phone)}</a> &nbsp;<a href="${txt}" style="${L}">Text</a>`) +
    linkRow('Email', `<a href="${mail}" style="${L}">${esc(d.email)}</a>`) + row('Session', d.length) +
    row('Preferred', when) + row('Backup', d.alt) + row('Interested in', d.focus.join(', ')) + row('Where they feel it', d.area) + row('Heard via', d.heard);

  try {
    await resend({
      to: [ALERT_TO], reply_to: d.email,
      subject: `New request: ${d.name}, ${d.length}, ${prettyDate(d.date)}`,
      html: wrap('New session request', `<table style="border-collapse:collapse;font-size:15px">${details}</table>
<p style="margin-top:20px"><a href="https://${DOMAIN}/text?to=${digits(d.phone)}&amp;name=${encodeURIComponent(d.name.split(' ')[0])}" style="background:#0b4a55;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:bold">Text ${esc(d.name.split(' ')[0])}</a>
&nbsp; <a href="mailto:${esc(d.email)}?subject=${encodeURIComponent('Your session request with Knead by Massage Sheli')}&amp;body=${encodeURIComponent(`Hi ${d.name.split(' ')[0]},\n\nThanks for your request for a ${d.length} session on ${prettyDate(d.date)} at ${d.time}.\n\n`)}" style="background:#e3bd86;color:#0a2f35;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:bold">Email ${esc(d.name.split(' ')[0])}</a>
&nbsp; <a href="tel:+1${digits(d.phone)}" style="color:#0b4a55;font-weight:bold">Call</a></p>
<p style="font-size:14px;color:#14282b">Phone: <a href="${tel}" style="${L}">${esc(d.phone)}</a> &middot; Email: <a href="${mail}" style="${L}">${esc(d.email)}</a></p>
<p style="font-size:13px;color:#4f6366">Reply to this email to answer them directly. They agreed to the 24-hour cancellation policy.</p>`)
    });
  } catch (e) {
    console.error('alert email failed', e.message);
    return json(res, 502, { error: `We could not send your request. Please text ${PHONE}.` });
  }

  try {
    await resend({
      to: [d.email], reply_to: ALERT_TO,
      subject: 'We got your session request',
      html: wrap(`Thanks, ${d.name.split(' ')[0]}`, `<p>Sheli received your request and will reply within 24 hours or sooner to confirm your time. Your session is not booked until she confirms.</p>
<table style="border-collapse:collapse;font-size:15px">${row('Session', d.length)}${row('Preferred', when)}${row('Backup', d.alt)}</table>
<p><strong>24-hour cancellation policy:</strong> please give at least 24 hours notice to cancel or reschedule.</p>
<p>Questions? Text <a href="sms:+17328598202">${PHONE}</a> for the fastest reply.</p>`)
    });
  } catch (e) { console.error('confirmation email failed', e.message); } // alert already sent, so the request still counts

  json(res, 200, { ok: true });
}

// Google reviews via Places API (New). Success is cached 12 hours (each call is billed); failures are retried after 5 minutes.
let reviewsCache = { at: 0, ok: false, body: null };
async function googleReviews(res) {
  const key = process.env.GOOGLE_PLACES_API_KEY, place = process.env.GOOGLE_PLACE_ID;
  if (!key || !place) return json(res, 503, { error: 'not_configured' });
  const age = Date.now() - reviewsCache.at;
  if (reviewsCache.body && (reviewsCache.ok ? age < 12 * 3600e3 : age < 5 * 60e3)) {
    return reviewsCache.ok
      ? send(res, 200, reviewsCache.body, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' })
      : json(res, 502, { error: 'unavailable' });
  }
  try {
    const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(place)}`, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'displayName,rating,userRatingCount,reviews,googleMapsUri' }
    });
    if (!r.ok) throw new Error(`Places ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const g = await r.json();
    const body = JSON.stringify({
      name: g.displayName && g.displayName.text, rating: g.rating || null, count: g.userRatingCount || 0, url: g.googleMapsUri || null,
      reviews: (g.reviews || []).map(v => ({
        rating: v.rating || 0,
        text: (v.text && v.text.text) || (v.originalText && v.originalText.text) || '',
        author: (v.authorAttribution && v.authorAttribution.displayName) || 'Google reviewer',
        authorUrl: (v.authorAttribution && v.authorAttribution.uri) || null,
        when: v.relativePublishTimeDescription || ''
      })).filter(v => v.text)
    });
    reviewsCache = { at: Date.now(), ok: true, body };
    send(res, 200, body, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
  } catch (e) {
    console.error('google reviews failed', e.message);
    reviewsCache = { at: Date.now(), ok: false, body: 'x' };
    json(res, 502, { error: 'unavailable' });
  }
}

// Gmail strips sms: links from emails, so the Text button opens this page, which hands off to the phone's Messages app.
function textPage(res, url) {
  const to = digits(url.searchParams.get('to'));
  if (!/^\d{10,15}$/.test(to)) return send(res, 400, 'Invalid number', { 'Content-Type': TYPES['.txt'] });
  const name = clip(url.searchParams.get('name'), 40);
  const body = `Hi ${name}, this is Sheli from Knead by Massage Sheli. Thanks for your session request!`;
  const sms = `sms:+1${to}?&body=${encodeURIComponent(body)}`;
  const shown = to.length === 10 ? `${to.slice(0, 3)}-${to.slice(3, 6)}-${to.slice(6)}` : to;
  send(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Text ${esc(name)}</title>
<style>body{margin:0;font-family:Arial,sans-serif;background:#f8f5ef;color:#14282b;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px;box-sizing:border-box}a{display:block;margin:12px auto;max-width:280px;padding:16px;border-radius:999px;font-weight:bold;text-decoration:none;font-size:18px}.t{background:#0b4a55;color:#fff}.c{border:2px solid #0b4a55;color:#0b4a55}</style></head>
<body><div><p>${esc(name)} &middot; ${esc(shown)}</p><a class="t" href="${esc(sms)}">Open Messages</a><a class="c" href="tel:+1${to}">Call Instead</a></div>
<script>location.href=${JSON.stringify(sms)};</script></body></html>`, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
}

const server = http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host || '').toLowerCase();
    const url = new URL(req.url, 'http://x');
    if (host === 'www.' + DOMAIN) return send(res, 301, '', { Location: `https://${DOMAIN}${url.pathname}${url.search}` });

    if (url.pathname === '/api/booking') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
      return await handleBooking(req, res);
    }
    if (url.pathname === '/text') return textPage(res, url);
    if (url.pathname === '/api/google-reviews') return await googleReviews(res);
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname === '/robots.txt') return send(res, 200, ROBOTS, { 'Content-Type': TYPES['.txt'] });
    if (url.pathname === '/sitemap.xml') return send(res, 200, SITEMAP, { 'Content-Type': TYPES['.xml'] });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', { 'Content-Type': TYPES['.txt'] });

    const ext = path.extname(file), stat = fs.statSync(file);
    const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400', 'Accept-Ranges': 'bytes' };
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range && ext === '.mp4') { // video needs range requests for iPhone Safari
      const start = range[1] ? +range[1] : 0, end = range[2] ? Math.min(+range[2], stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) return send(res, 416, '', { 'Content-Range': `bytes */${stat.size}` });
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    return req.method === 'HEAD' ? res.end() : fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Server error.' });
  }
});

if (require.main === module) server.listen(PORT, () => console.log(`The Missing Link on :${PORT}`));
module.exports = server;
