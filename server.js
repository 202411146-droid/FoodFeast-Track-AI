const express = require('express');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname), {
  index: false  // Prevent express from serving index.html directly so our route can inject ENV
}));

// ── EMAIL TRANSPORTER (Brevo SMTP) ────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com',
  port: parseInt(process.env.BREVO_SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_PASS,
  },
});

// ── SEND VERIFICATION EMAIL ───────────────────────────────────
app.post('/api/send-verification', async (req, res) => {
  const { email, confirmationUrl } = req.body;

  if (!email || !confirmationUrl) {
    return res.status(400).json({ error: 'Missing email or confirmationUrl' });
  }

  // Debug: log what env vars are available (remove after testing)
  console.log('BREVO_SMTP_USER:', process.env.BREVO_SMTP_USER ? 'SET' : 'MISSING');
  console.log('BREVO_SMTP_PASS:', process.env.BREVO_SMTP_PASS ? 'SET' : 'MISSING');
  console.log('BREVO_SENDER_EMAIL:', process.env.BREVO_SENDER_EMAIL || 'MISSING');
  console.log('Sending to:', email);

  if (!process.env.BREVO_SMTP_USER || !process.env.BREVO_SMTP_PASS) {
    return res.status(500).json({ error: 'SMTP not configured - BREVO_SMTP_USER or BREVO_SMTP_PASS missing' });
  }

  try {
    await transporter.sendMail({
      from: `"${process.env.BREVO_SENDER_NAME || 'FoodFeast Track AI'}" <${process.env.BREVO_SENDER_EMAIL || process.env.BREVO_SMTP_USER}>`,
      to: email,
      subject: 'Welcome to FoodFeast Track AI!',
      html: `
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
      `,
    });

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
