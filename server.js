const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

/* ─────────────────────────────────────────────
   SUPABASE CLIENTS
───────────────────────────────────────────── */

// Regular client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Admin client
const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

/* ─────────────────────────────────────────────
   EXPRESS SETUP
───────────────────────────────────────────── */

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname), { index: false }));

/* ─────────────────────────────────────────────
   OTP STORAGE
───────────────────────────────────────────── */

const pendingOTPs = new Map();
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

setInterval(() => {
  const now = Date.now();

  for (const [email, record] of pendingOTPs.entries()) {
    if (record.expiresAt < now) {
      pendingOTPs.delete(email);
    }
  }
}, 15 * 60 * 1000);

/* ─────────────────────────────────────────────
   BREVO EMAIL
───────────────────────────────────────────── */

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

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Brevo ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ─────────────────────────────────────────────
   SEND OTP
───────────────────────────────────────────── */

app.post('/api/send-otp', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      error: 'Missing email'
    });
  }

  const otp = String(
    crypto.randomInt(100000, 999999)
  );

  const expiresAt = Date.now() + OTP_TTL_MS;

  pendingOTPs.set(email.toLowerCase(), {
    otp,
    expiresAt,
    attempts: 0
  });

  try {
    await sendBrevoEmail(
      email,
      'Your FoodFeast verification code',
      `<h2>Your OTP Code</h2>
       <p>Your verification code is:</p>
       <h1>${otp}</h1>
       <p>This code expires in 10 minutes.</p>`
    );

    res.json({
      success: true
    });

  } catch (err) {
    console.error(err);
    pendingOTPs.delete(email.toLowerCase());

    res.status(500).json({
      error: 'Failed to send OTP'
    });
  }
});

/* ─────────────────────────────────────────────
   VERIFY OTP
───────────────────────────────────────────── */

app.post('/api/verify-otp', (req, res) => {
  const { email, otp } = req.body;

  const record = pendingOTPs.get(
    email.toLowerCase()
  );

  if (!record) {
    return res.status(400).json({
      error: 'No pending verification found'
    });
  }

  if (Date.now() > record.expiresAt) {
    pendingOTPs.delete(email.toLowerCase());

    return res.status(400).json({
      error: 'OTP expired'
    });
  }

  record.attempts++;

  if (record.attempts > MAX_ATTEMPTS) {
    pendingOTPs.delete(email.toLowerCase());

    return res.status(429).json({
      error: 'Too many attempts'
    });
  }

  if (record.otp !== String(otp).trim()) {
    return res.status(400).json({
      error: 'Invalid OTP'
    });
  }

  pendingOTPs.delete(email.toLowerCase());

  res.json({
    verified: true
  });
});

/* ─────────────────────────────────────────────
   FORGOT PASSWORD EMAIL
───────────────────────────────────────────── */

const pendingResets = new Map();
const RESET_TTL_MS = 15 * 60 * 1000;

app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      error: 'Missing email'
    });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + RESET_TTL_MS;

  pendingResets.set(token, {
    email: email.toLowerCase(),
    expiresAt
  });

  const resetUrl =
    (process.env.APP_URL ||
      'https://foodfeast-track-ai.up.railway.app') +
    `/reset-password?token=${token}`;

  try {
    await sendBrevoEmail(
      email,
      'Reset your password',
      `
      <h2>Reset Password</h2>
      <p>Click below:</p>
      <a href="${resetUrl}">Reset Password</a>
      `
    );

    res.json({
      success: true
    });

  } catch (err) {
    console.error(err);

    pendingResets.delete(token);

    res.status(500).json({
      error: 'Failed to send reset email'
    });
  }
});

/* ─────────────────────────────────────────────
   VERIFY RESET TOKEN
───────────────────────────────────────────── */

app.get('/api/verify-reset-token', (req, res) => {
  const { token } = req.query;

  const record = pendingResets.get(token);

  if (!record) {
    return res.status(400).json({
      error: 'Invalid reset token'
    });
  }

  if (Date.now() > record.expiresAt) {
    pendingResets.delete(token);

    return res.status(400).json({
      error: 'Reset token expired'
    });
  }

  res.json({
    email: record.email
  });
});

/* ─────────────────────────────────────────────
   RESET PASSWORD
───────────────────────────────────────────── */

app.post('/api/reset-password', async (req, res) => {
  try {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
      return res.status(400).json({
        error: 'Missing required fields'
      });
    }

    const { data, error } =
      await admin.auth.admin.listUsers();

    if (error) {
      console.error(error);

      return res.status(500).json({
        error: 'Failed to lookup users'
      });
    }

    const user = data.users.find(
      user =>
        user.email?.toLowerCase() ===
        email.toLowerCase()
    );

    if (!user) {
      return res.status(400).json({
        error: 'User not found'
      });
    }

    const { error: updateError } =
      await admin.auth.admin.updateUserById(
        user.id,
        {
          password: newPassword
        }
      );

    if (updateError) {
      console.error(updateError);

      return res.status(500).json({
        error: 'Failed to update password'
      });
    }

    res.json({
      success: true,
      message: 'Password updated successfully'
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

/* ─────────────────────────────────────────────
   HTML ROUTES
───────────────────────────────────────────── */

function injectEnv(html) {
  const envScript = `
    <script>
      window.ENV = {
        SUPABASE_URL: "${process.env.SUPABASE_URL || ''}",
        SUPABASE_ANON_KEY: "${process.env.SUPABASE_ANON_KEY || ''}",
        GEMINI_API_KEY: "${process.env.GEMINI_API_KEY || ''}"
      };
    </script>
  `;

  return html.replace(
    '</head>',
    envScript + '</head>'
  );
}

app.get('/reset-password', (req, res) => {
  const html = fs.readFileSync(
    path.join(__dirname, 'index.html'),
    'utf8'
  );

  res.send(injectEnv(html));
});

app.get('/', (req, res) => {
  const html = fs.readFileSync(
    path.join(__dirname, 'landing.html'),
    'utf8'
  );

  res.send(injectEnv(html));
});

app.get('/app', (req, res) => {
  const html = fs.readFileSync(
    path.join(__dirname, 'index.html'),
    'utf8'
  );

  res.send(injectEnv(html));
});

app.get('*', (req, res) => {
  const html = fs.readFileSync(
    path.join(__dirname, 'index.html'),
    'utf8'
  );

  res.send(injectEnv(html));
});

/* ─────────────────────────────────────────────
   START SERVER
───────────────────────────────────────────── */

app.listen(PORT, () => {
  console.log(
    `FoodFeast Track AI running on port ${PORT}`
  );
});
