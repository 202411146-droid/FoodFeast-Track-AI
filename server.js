const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname), {
  index: false  // Prevent express from serving index.html directly so our route can inject ENV
}));

// ── EMAIL via Brevo HTTP API (avoids SMTP port blocking) ─────
async function sendBrevoEmail(to, subject, htmlContent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      sender: {
        name: process.env.BREVO_SENDER_NAME || 'FoodFeast Track AI',
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
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Brevo API error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── SEND VERIFICATION EMAIL ───────────────────────────────────
app.post('/api/send-verification', async (req, res) => {
  const { email, confirmationUrl } = req.body;

  if (!email || !confirmationUrl) {
    return res.status(400).json({ error: 'Missing email or confirmationUrl' });
  }

  // Debug: log what env vars are available (remove after testing)
  console.log('BREVO_API_KEY:', process.env.BREVO_API_KEY ? 'SET' : 'MISSING');
  console.log('BREVO_SENDER_EMAIL:', process.env.BREVO_SENDER_EMAIL || 'MISSING');
  console.log('Sending to:', email);

  if (!process.env.BREVO_API_KEY) {
    return res.status(500).json({ error: 'BREVO_API_KEY not configured' });
  }

  try {
    await sendBrevoEmail(email, 'Welcome to FoodFeast Track AI!', `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"></head>
        <body style="margin:0;padding:0;background:#FAF6F0;font-family:'Helvetica Neue',Arial,sans-serif">
          <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2D0BB">
            <div style="background:#C85A2A;padding:32px;text-align:center">
              <h1 style="color:#fff;margin:0;font-size:26px;font-weight:800;letter-spacing:-0.5px">
                FoodFeast <span style="font-weight:400">Track AI</span>
              </h1>
            </div>
            <div style="padding:40px 36px">
              <h2 style="color:#2C1A0E;font-size:20px;margin:0 0 12px">Welcome aboard! 🎉</h2>
              <p style="color:#8C6A4E;font-size:15px;line-height:1.6;margin:0 0 28px">
                Your account has been created successfully. You can now sign in and start tracking your pantry, reducing food waste, and getting AI-powered recipe suggestions.
              </p>
              <div style="text-align:center;margin-bottom:28px">
                <a href="${confirmationUrl}"
                   style="display:inline-block;background:#C85A2A;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:700">
                  Go to FoodFeast
                </a>
              </div>
              <p style="color:#B89A80;font-size:12px;line-height:1.6;margin:0;text-align:center">
                If you didn't create this account, please ignore this email.
              </p>
            </div>
            <div style="background:#FAF6F0;padding:20px;text-align:center;border-top:1px solid #E2D0BB">
              <p style="color:#B89A80;font-size:12px;margin:0">FoodFeast Track AI &mdash; Personalized nutrition &amp; food waste reduction</p>
            </div>
          </div>
        </body>
        </html>
      `);

    res.json({ success: true });
  } catch (err) {
    console.error('Email send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── INJECT ENV VARS INTO HTML ─────────────────────────────────
function injectEnv(html) {
  const envScript = `
    <script>
      window.ENV = {
        SUPABASE_URL: "${process.env.SUPABASE_URL || ''}",
        SUPABASE_ANON_KEY: "${process.env.SUPABASE_ANON_KEY || ''}",
        ANTHROPIC_API_KEY: "${process.env.ANTHROPIC_API_KEY || ''}"
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
  console.log(`FoodFeast Track AI running on http://localhost:${PORT}`);
});
