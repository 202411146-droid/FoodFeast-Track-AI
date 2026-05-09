const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static(path.join(__dirname)));

// Serve index.html with environment variables injected
app.get('/', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
  
  // Inject environment variables as a script
  const envScript = `
    <script>
      window.ENV = {
        SUPABASE_URL: "${process.env.SUPABASE_URL}",
        SUPABASE_ANON_KEY: "${process.env.SUPABASE_ANON_KEY}",
        ANTHROPIC_API_KEY: "${process.env.ANTHROPIC_API_KEY || ''}"
      };
    </script>
  `;
  
  html = html.replace('</head>', envScript + '</head>');
  res.send(html);
});

// Catch-all for client-side routing
app.get('*', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
  const envScript = `
    <script>
      window.ENV = {
        SUPABASE_URL: "${process.env.SUPABASE_URL}",
        SUPABASE_ANON_KEY: "${process.env.SUPABASE_ANON_KEY}",
        ANTHROPIC_API_KEY: "${process.env.ANTHROPIC_API_KEY || ''}"
      };
    </script>
  `;
  html = html.replace('</head>', envScript + '</head>');
  res.send(html);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 FoodFeast Track AI running on http://localhost:${PORT}`);
});
