// Save as /api/email.js in your Vercel project. Needs package.json (firebase-admin + nodemailer).
// Routes:  POST ?a=welcome   (called by the app after registration, with the user's Firebase ID token)
//          GET  ?a=remind    (called every hour by a scheduler, with your CRON_SECRET)
//          GET  ?a=unsub     (the Unsubscribe link inside every email)
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = admin.firestore();
const SITE = (process.env.SITE_URL || 'https://sprint-notification.vercel.app').replace(/\/$/, '');
const SECRET = process.env.CRON_SECRET || '';
const RAW_FROM = process.env.MAIL_FROM || process.env.SMTP_USER || '';
const FROM = { name: 'Sprint Learning Challenge', address: ((RAW_FROM.match(/<([^>]+)>/) || [null, RAW_FROM])[1]).trim() }; // shows as: Sprint Learning Challenge
const SLOTS = { morning: 8, evening: 18, late: 21 }; // local hour (24h) in each person's own timezone
const PORT = +(process.env.SMTP_PORT || 465);
const tx = nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: PORT, secure: PORT === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sign = (uid) => crypto.createHmac('sha256', SECRET).update(uid).digest('hex').slice(0, 32);

const zone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch (e) { return 'UTC'; } };
const localDate = (ts, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
const dayNum = (ts, tz) => { const p = localDate(ts, tz).split('-').map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 864e5); };
const localHour = (ts, tz) => +new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(ts);

// Same rules as the app: a new day opens at 12am, but only after the previous day is completed.
function status(st, tz, now) {
  const days = st.days || {};
  const done = (n) => !!(days[n] && days[n].done);
  let first = 31;
  for (let i = 1; i <= 30; i++) if (!done(i)) { first = i; break; }
  const cal = dayNum(now, tz) - dayNum(st.start, tz) + 1;
  const cur = Math.max(1, Math.min(30, cal, first));
  return { cur, doneToday: done(cur), finished: first === 31, behind: Math.max(0, cal - cur) };
}

const layout = (uid, title, body, btn) => `<!doctype html><html><body style="margin:0;background:#fff8ee;font-family:Arial,Helvetica,sans-serif;color:#1b1720">
<div style="max-width:520px;margin:0 auto;padding:24px">
<span style="background:#fbb73b;padding:4px 12px;border-radius:10px;font-weight:800;font-size:20px">30</span> <b style="font-size:18px;vertical-align:2px">Days Sprint</b>
<div style="background:#fff;border:1px solid #eadfee;border-radius:16px;padding:24px;margin-top:16px">
<h2 style="margin:0 0 12px;font-size:22px">${title}</h2>${body}
<p style="margin:24px 0 0"><a href="${SITE}" style="background:#fbb73b;color:#111;font-weight:700;text-decoration:none;padding:14px 26px;border-radius:999px;display:inline-block">${btn}</a></p></div>
<p style="color:#625a68;font-size:12px;margin-top:16px">You receive this because you joined the 30 Days Sprint. <a href="${SITE}/api/email?a=unsub&u=${uid}&t=${sign(uid)}" style="color:#b5149a">Unsubscribe</a></p>
</div></body></html>`;

const COPY = {
  morning: (n) => ({ s: `Day ${n} of 30: your Sprint is waiting`, h: 'Your Sprint is waiting', p: `Good morning! Day ${n} is open. Learn a little, build something, and add your proof.` }),
  evening: (n) => ({ s: `Day ${n}: you still have time`, h: 'You still have time', p: 'You still have time to complete today’s mission. Even a small build counts.' }),
  late: (n) => ({ s: 'Don’t let today become a zero', h: 'Don’t let today become a zero', p: `Day ${n} is almost over. A few focused minutes now keeps your streak and your points.` }),
};

const send = (to, subject, html) => tx.sendMail({ from: FROM, to, subject, html });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const a = req.query.a;
  try {
    if (a === 'unsub') {
      const uid = String(req.query.u || '');
      if (!uid || sign(uid) !== req.query.t) return res.status(403).send('Invalid link');
      await db.doc('users/' + uid).set({ emailOff: true }, { merge: true });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send('<body style="font-family:Arial;text-align:center;padding:48px"><h2>You’re unsubscribed</h2><p>You can switch reminders back on in the app: Rules, then Your account.</p></body>');
    }

    if (a === 'welcome') {
      if (req.method !== 'POST') return res.status(405).end();
      const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
      const uid = (await admin.auth().verifyIdToken(tok)).uid;
      const ref = db.doc('users/' + uid), d = await ref.get();
      if (!d.exists) return res.json({ ok: false });
      const u = d.data();
      if (u.welcomed || u.emailOff || !u.email) return res.json({ ok: true, skipped: true });
      const st = JSON.parse(u.s), p = st.p || {};
      const body = `<p>Hi ${esc(p.name)}, you’re in.</p><p><b>Your goal:</b> ${esc(p.goal)}</p><p>Day 1 is open now. Each new day opens at 12am, but only after you complete the previous one. Learn a little, build something, and add proof every day.</p>`;
      await send(u.email, 'You’re in! Your 30 Days Sprint starts now', layout(uid, 'Welcome to your 30 Days Sprint', body, 'Start Day 1'));
      await ref.set({ welcomed: true }, { merge: true });
      return res.json({ ok: true });
    }

    if (a === 'remind') {
      const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!SECRET || (auth !== SECRET && req.query.key !== SECRET)) return res.status(401).json({ error: 'Unauthorized' });
      const force = SLOTS[req.query.slot] ? req.query.slot : null; // ?slot=morning sends right now (for testing)
      const now = Date.now();
      const snap = await db.collection('users').get();
      const jobs = [];
      snap.forEach((doc) => {
        const u = doc.data();
        if (!u.email || !u.s || u.emailOff) return;
        let st; try { st = JSON.parse(u.s); } catch (e) { return; }
        if (!st.start) return;
        const tz = zone(u.tz || 'UTC'), hour = localHour(now, tz), date = localDate(now, tz);
        const slot = force || Object.keys(SLOTS).find((k) => SLOTS[k] === hour);
        if (!slot) return;
        if (!force && u.lastSent && u.lastSent[slot] === date) return; // already sent this slot today
        const s = status(st, tz, now);
        if (s.finished || s.doneToday || s.behind >= 7) return; // done for today, finished, or gone quiet for a week
        const c = COPY[slot](s.cur);
        jobs.push(async () => {
          await send(u.email, c.s, layout(doc.id, c.h, `<p>Hi ${esc((st.p || {}).name)},</p><p>${c.p}</p>`, 'Open today’s mission'));
          if (!force) await doc.ref.set({ lastSent: { [slot]: date } }, { merge: true });
        });
      });
      let sent = 0, failed = 0;
      for (let i = 0; i < jobs.length; i += 10) {
        const r = await Promise.allSettled(jobs.slice(i, i + 10).map((j) => j()));
        r.forEach((x) => (x.status === 'fulfilled' ? sent++ : failed++));
      }
      return res.json({ sent, failed });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
};
