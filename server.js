const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname), { index: false }));

// ── IN-MEMORY OTP STORE ───────────────────────────────────────
// { email -> { otp, expiresAt, attempts } }
// No DB record is created until the OTP is confirmed.
const pendingOTPs = new Map();
const OTP_TTL_MS  = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

setInterval(() => {
  const now = Date.now();
  for (const [email, r] of pendingOTPs.entries()) {
    if (r.expiresAt < now) pendingOTPs.delete(email);
  }
}, 15 * 60 * 1000);

// ── EMAIL via Brevo ───────────────────────────────────────────
async function sendBrevoEmail(to, subject, htmlContent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      sender: {
        name:  process.env.BREVO_SENDER_NAME  || 'FoodFeast Track AI',
        email: process.env.BREVO_SENDER_EMAIL
      },
      to: [{ email: to }],
      subject,
      htmlContent
    });
    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'api-key':        process.env.BREVO_API_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error('Brevo ' + res.statusCode + ': ' + data));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── STEP 1: SEND OTP (no account created yet) ─────────────────
app.post('/api/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  if (!process.env.BREVO_API_KEY) return res.status(500).json({ error: 'Email service not configured' });

  const otp       = String(crypto.randomInt(100000, 999999));
  const expiresAt = Date.now() + OTP_TTL_MS;
  pendingOTPs.set(email.toLowerCase(), { otp, expiresAt, attempts: 0 });

  console.log('OTP for ' + email + ': ' + otp);

  try {
    await sendBrevoEmail(email, 'Your FoodFeast verification code', `
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"></head>
      <body style="margin:0;padding:0;background:#FAF6F0;font-family:'Helvetica Neue',Arial,sans-serif">
        <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2D0BB">
          <div style="background:#C85A2A;padding:32px;text-align:center">
            <h1 style="color:#fff;margin:0;font-size:26px;font-weight:800">FoodFeast <span style="font-weight:400">Track AI</span></h1>
          </div>
          <div style="padding:40px 36px;text-align:center">
            <h2 style="color:#2C1A0E;font-size:20px;margin:0 0 8px">Verify your email</h2>
            <p style="color:#8C6A4E;font-size:15px;line-height:1.6;margin:0 0 24px">Enter this code in the app to complete your registration:</p>
            <div style="background:#FAF6F0;border:2px dashed #C85A2A;border-radius:12px;padding:24px;margin-bottom:24px">
              <span style="font-size:42px;font-weight:900;letter-spacing:10px;color:#C85A2A;font-family:monospace">${otp}</span>
            </div>
            <p style="color:#B89A80;font-size:13px">This code expires in <strong>10 minutes</strong>.<br>If you didn't request this, ignore this email.</p>
          </div>
          <div style="background:#FAF6F0;padding:20px;text-align:center;border-top:1px solid #E2D0BB">
            <p style="color:#B89A80;font-size:12px;margin:0">FoodFeast Track AI &mdash; Personalized nutrition &amp; food waste reduction</p>
          </div>
        </div>
      </body></html>
    `);
    res.json({ success: true });
  } catch (err) {
    console.error('OTP send error:', err);
    pendingOTPs.delete(email.toLowerCase());
    res.status(500).json({ error: 'Failed to send verification email. Please try again.' });
  }
});

// ── STEP 2: VERIFY OTP ────────────────────────────────────────
// Returns { verified: true } on success.
// The client then calls db.auth.signUp() — first DB write happens there.
app.post('/api/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Missing email or code' });

  const record = pendingOTPs.get(email.toLowerCase());
  if (!record) return res.status(400).json({ error: 'No pending verification. Please request a new code.' });

  if (Date.now() > record.expiresAt) {
    pendingOTPs.delete(email.toLowerCase());
    return res.status(400).json({ error: 'Code expired. Please request a new one.' });
  }

  record.attempts += 1;
  if (record.attempts > MAX_ATTEMPTS) {
    pendingOTPs.delete(email.toLowerCase());
    return res.status(429).json({ error: 'Too many attempts. Please request a new code.' });
  }

  if (record.otp !== String(otp).trim()) {
    const left = MAX_ATTEMPTS - record.attempts;
    return res.status(400).json({ error: 'Incorrect code. ' + left + ' attempt' + (left !== 1 ? 's' : '') + ' remaining.' });
  }

  pendingOTPs.delete(email.toLowerCase()); // single use
  res.json({ verified: true });
});

// ── INJECT ENV & SERVE HTML ───────────────────────────────────
// ── ANTHROPIC API PROXY ──────────────────────────────────────
// Proxies requests to Anthropic API so the API key stays server-side
const { createProxyMiddleware } = require('http-proxy-middleware');

app.post('/api/anthropic', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not configured on server.' } });
  }
  try {
    const https = require('https');
    const body = JSON.stringify(req.body);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const proxyReq = https.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', c => data += c);
      proxyRes.on('end', () => {
        res.status(proxyRes.statusCode).json(JSON.parse(data));
      });
    });
    proxyReq.on('error', (err) => res.status(500).json({ error: { message: err.message } }));
    proxyReq.write(body);
    proxyReq.end();
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

function injectEnv(html) {
  const envScript = `
    <script>
      window.ENV = {
        SUPABASE_URL: "${process.env.SUPABASE_URL || ''}",
        SUPABASE_ANON_KEY: "${process.env.SUPABASE_ANON_KEY || ''}"
      };
    </script>
  `;
  return html.replace('</head>', envScript + '</head>');
}

app.get('/', (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
  res.send(injectEnv(html));
});

app.get('*', (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
  res.send(injectEnv(html));
});

app.listen(PORT, () => {
  console.log('FoodFeast Track AI running on http://localhost:' + PORT);
});
