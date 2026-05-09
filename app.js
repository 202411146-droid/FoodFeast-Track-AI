// ============================================================
//  FoodFeast Track AI — app.js
//  Supabase-powered pantry + AI recipe generation
// ============================================================

// ── CONFIGURATION ────────────────────────────────────────────
// Read from Railway environment variables (injected by server.js)
// Fallback to window.ENV for Railway, or hardcoded values for local dev
// Keys must be set as Railway environment variables - no hardcoded fallbacks to avoid mismatch
const SUPABASE_URL = window.ENV?.SUPABASE_URL;
const SUPABASE_ANON_KEY = window.ENV?.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  document.body.innerHTML = '<div style="font-family:sans-serif;padding:40px;text-align:center"><h2>Configuration Error</h2><p>SUPABASE_URL and SUPABASE_ANON_KEY environment variables are not set in Railway.</p></div>';
  throw new Error('Missing Supabase environment variables');
}

// Replace with your Anthropic API key (or set in Railway variables)
const ANTHROPIC_API_KEY = window.ENV?.ANTHROPIC_API_KEY;

// ── INIT ─────────────────────────────────────────────────────
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// App state
let currentUser = null;
let pantryItems  = [];
let scanStream   = null;
let selectedFoodTags = new Set();
let scanCount    = 0;

// ── BOOT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Handle email confirmation redirect from Supabase
  const hash = window.location.hash;
  if (hash && hash.includes('access_token')) {
    const params = new URLSearchParams(hash.substring(1));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (accessToken) {
      const { error } = await db.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      if (!error) {
        window.history.replaceState(null, '', window.location.pathname);
        showToast('Email confirmed! Welcome to FoodFeast!');
      }
    }
  }

  const { data: { session } } = await db.auth.getSession();
  if (session) {
    currentUser = session.user;
    enterApp();
  }

  db.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user ?? null;
    if (currentUser) enterApp();
    else leaveApp();
  });
});

// ── AUTH: SIGN IN ─────────────────────────────────────────────
async function doLogin() {
  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPass').value;
  const errEl    = document.getElementById('loginErr');
  const btn      = document.getElementById('loginBtn');

  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Please fill in all fields.'; return; }

  btn.textContent = 'Signing in…';
  btn.disabled = true;

  const { error } = await db.auth.signInWithPassword({ email, password });

  btn.textContent = 'Sign In';
  btn.disabled = false;

  if (error) errEl.textContent = error.message;
}

// ── AUTH: SIGN UP ─────────────────────────────────────────────
async function doSignUp() {
  const email    = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPass').value;
  const confirm  = document.getElementById('signupConfirm').value;
  const tos      = document.getElementById('tosCheck').checked;
  const errEl    = document.getElementById('signupErr');
  const btn      = document.getElementById('signupBtn');

  errEl.textContent = '';

  if (!email || !password || !confirm) { errEl.textContent = 'Please fill in all fields.'; return; }
  if (password !== confirm)            { errEl.textContent = 'Passwords do not match.'; return; }
  if (password.length < 6)             { errEl.textContent = 'Password must be at least 6 characters.'; return; }
  if (!tos)                            { errEl.textContent = 'Please accept the Terms of Service.'; return; }

  btn.textContent = 'Creating account...';
  btn.disabled = true;

  try {
    const { data, error } = await db.auth.signUp({ email, password });

    if (error) {
      const msg = error.message || '';
      if (msg.toLowerCase().includes('already registered') || msg.toLowerCase().includes('already been registered')) {
        errEl.textContent = 'An account with this email already exists. Try signing in instead.';
      } else {
        errEl.textContent = msg;
      }
    } else {
      // Send verification email via our server (Brevo SMTP)
      // We send a sign-in magic link so user clicks it and gets logged in directly
      try {
        const { data: linkData, error: linkError } = await db.auth.signInWithOtp({
          email,
          options: { shouldCreateUser: false }
        });
        const confirmUrl = window.location.origin;
        await fetch('/api/send-verification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, confirmationUrl: confirmUrl })
        });
      } catch (e) {
        console.warn('Could not send custom email:', e);
      }
      showVerifyScreen(email);
    }
  } catch (err) {
    errEl.textContent = 'Something went wrong. Please try again.';
  } finally {
    btn.textContent = 'Create Account';
    btn.disabled = false;
  }
}

// ── EMAIL VERIFY SCREEN ──────────────────────────────────────
function showVerifyScreen(email) {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('verifyScreen').classList.remove('hidden');
  document.getElementById('verifyEmailAddr').textContent = email;
  // Store email for resend
  window._pendingVerifyEmail = email;
  window._pendingVerifyPassword = document.getElementById('signupPass').value;
}

async function resendVerification() {
  const btn = document.getElementById('resendBtn');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  const { error } = await db.auth.resend({
    type: 'signup',
    email: window._pendingVerifyEmail
  });
  if (error) {
    showToast('Failed to resend: ' + error.message, 'danger');
  } else {
    showToast('Verification email resent!');
  }
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = 'Resend Email';
  }, 5000);
}

function backToSignIn() {
  document.getElementById('verifyScreen').classList.add('hidden');
  document.getElementById('authScreen').classList.remove('hidden');
  switchAuthTab('signin');
}

// ── AUTH: SIGN OUT ────────────────────────────────────────────
async function doLogout() {
  stopCamera();
  await db.auth.signOut();
}

// ── AUTH TAB SWITCH ───────────────────────────────────────────
function switchAuthTab(tab) {
  const isSignIn = tab === 'signin';
  document.getElementById('formSignIn').classList.toggle('hidden', !isSignIn);
  document.getElementById('formSignUp').classList.toggle('hidden', isSignIn);
  document.getElementById('tabSignIn').classList.toggle('active', isSignIn);
  document.getElementById('tabSignUp').classList.toggle('active', !isSignIn);
  document.getElementById('loginErr').textContent   = '';
  document.getElementById('signupErr').textContent  = '';
  // Always re-enable buttons when switching tabs (prevents stuck disabled state)
  const loginBtn  = document.getElementById('loginBtn');
  const signupBtn = document.getElementById('signupBtn');
  if (loginBtn)  { loginBtn.disabled  = false; loginBtn.textContent  = 'Sign In'; }
  if (signupBtn) { signupBtn.disabled = false; signupBtn.textContent = 'Create Account'; }
}

// ── APP ENTER / LEAVE ─────────────────────────────────────────
function enterApp() {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('mainApp').classList.remove('hidden');

  // Populate user chip
  const email = currentUser.email || '';
  document.getElementById('userEmailDisplay').textContent = email;
  document.getElementById('userAvatar').textContent = email.charAt(0).toUpperCase();

  setGreeting();
  loadPantry();
}

function leaveApp() {
  document.getElementById('mainApp').classList.add('hidden');
  document.getElementById('authScreen').classList.remove('hidden');
  pantryItems = [];
}

// ── GREETING ──────────────────────────────────────────────────
function setGreeting() {
  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning ✦' : h < 17 ? 'Good afternoon ✦' : 'Good evening ✦';
  document.getElementById('dashGreeting').textContent = greet;
}

// ── TABS ──────────────────────────────────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (btn) btn.classList.add('active');

  if (name !== 'scan') stopCamera();
}

// ── TOGGLE PASSWORD VISIBILITY ────────────────────────────────
function togglePass(inputId, btn) {
  const input = document.getElementById(inputId);
  const show  = input.type === 'password';
  input.type  = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
}

// ── MODALS ────────────────────────────────────────────────────
function showModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// Close modal on backdrop click
document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) backdrop.classList.add('hidden');
  });
});

// ── TOAST ─────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ── LOAD PANTRY ───────────────────────────────────────────────
async function loadPantry() {
  const { data, error } = await db
    .from('pantry_items')
    .select('*')
    .order('added_at', { ascending: false });

  if (error) { showToast('Failed to load pantry: ' + error.message, 'danger'); return; }

  pantryItems = data || [];
  renderPantryGrid(pantryItems);
  updateDashboard();
}

// ── DASHBOARD ─────────────────────────────────────────────────
function updateDashboard() {
  const today  = new Date();
  const week   = new Date(); week.setDate(week.getDate() + 7);

  const expiring = pantryItems.filter(i => {
    if (!i.expiry_date) return false;
    const d = new Date(i.expiry_date);
    return d >= today && d <= week;
  });

  document.getElementById('statTotal').textContent    = pantryItems.length;
  document.getElementById('statExpiring').textContent  = expiring.length;
  document.getElementById('statRecipes').textContent   = Math.floor(pantryItems.length / 3);
  document.getElementById('statScanned').textContent   = scanCount;

  // Expiry list
  const expiryEl = document.getElementById('expiryList');
  if (expiring.length === 0) {
    expiryEl.innerHTML = '<p class="empty-state">No items expiring soon 🎉</p>';
  } else {
    expiryEl.innerHTML = expiring.map(i => {
      const d    = new Date(i.expiry_date);
      const days = Math.ceil((d - today) / 86400000);
      const cls  = days <= 2 ? 'red' : days <= 4 ? 'yellow' : 'green';
      return `<div class="activity-item">
        <span>${i.emoji || '🥫'} ${i.name}</span>
        <span class="exp-badge ${cls}">${days === 0 ? 'Today' : days + 'd'}</span>
      </div>`;
    }).join('');
  }

  // Activity list (5 most recent)
  const actEl = document.getElementById('activityList');
  if (pantryItems.length === 0) {
    actEl.innerHTML = '<p class="empty-state">No recent activity yet</p>';
  } else {
    actEl.innerHTML = pantryItems.slice(0, 5).map(i => `
      <div class="activity-item">
        <span>${i.emoji || '🥫'} ${i.name} <small style="color:var(--muted)">${i.quantity}</small></span>
        <span style="font-size:11px;color:var(--muted2)">${formatDate(i.added_at)}</span>
      </div>`).join('');
  }
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - d) / 60000);
  if (diff < 1)   return 'just now';
  if (diff < 60)  return diff + 'm ago';
  if (diff < 1440) return Math.floor(diff / 60) + 'h ago';
  return d.toLocaleDateString();
}

// ── PANTRY RENDER ─────────────────────────────────────────────
function renderPantryGrid(items) {
  const grid = document.getElementById('pantryGrid');
  if (!items.length) {
    grid.innerHTML = '<p class="empty-state">Your pantry is empty. Add items or scan food!</p>';
    return;
  }

  const today = new Date();
  grid.innerHTML = items.map(item => {
    let badgeHtml = '';
    if (item.expiry_date) {
      const d    = new Date(item.expiry_date);
      const days = Math.ceil((d - today) / 86400000);
      const cls  = days < 0 ? 'red' : days <= 3 ? 'red' : days <= 7 ? 'yellow' : 'green';
      const label = days < 0 ? 'Expired' : days === 0 ? 'Today' : days + 'd left';
      badgeHtml = `<span class="exp-badge ${cls}">${label}</span>`;
    }
    return `<div class="pantry-card">
      ${badgeHtml}
      <div class="food-emoji">${item.emoji || '🥫'}</div>
      <div class="food-name">${item.name}</div>
      <div class="food-qty">${item.quantity} · ${item.category}</div>
      <button class="del-btn" onclick="deleteItem(${item.id})" title="Delete">✕</button>
    </div>`;
  }).join('');
}

// ── PANTRY FILTER ─────────────────────────────────────────────
function filterPantry(query) {
  const cat = document.getElementById('catFilter').value;
  applyFilters(query, cat);
}

function filterByCategory(cat) {
  const q = document.getElementById('pantrySearch').value;
  applyFilters(q, cat);
}

function applyFilters(query, cat) {
  const q = query.toLowerCase();
  const filtered = pantryItems.filter(i => {
    const matchQ   = !q || i.name.toLowerCase().includes(q);
    const matchCat = cat === 'all' || i.category === cat;
    return matchQ && matchCat;
  });
  renderPantryGrid(filtered);
}

// ── ADD ITEM MODAL ────────────────────────────────────────────
function openAddModal() {
  document.getElementById('mName').value = '';
  document.getElementById('mQty').value  = '1';
  document.getElementById('mExp').value  = '';
  document.getElementById('mCat').value  = 'produce';
  showModal('addItemModal');
  setTimeout(() => document.getElementById('mName').focus(), 80);
}

async function saveItem() {
  const name = document.getElementById('mName').value.trim();
  const cat  = document.getElementById('mCat').value;
  const qty  = document.getElementById('mQty').value.trim() || '1';
  const exp  = document.getElementById('mExp').value || null;

  if (!name) { showToast('Please enter an item name.', 'danger'); return; }

  const emoji = categoryEmoji(cat);

  const { data, error } = await db.from('pantry_items').insert([{
    user_id: currentUser.id,
    name, category: cat, quantity: qty,
    expiry_date: exp, emoji
  }]).select().single();

  if (error) { showToast('Error: ' + error.message, 'danger'); return; }

  pantryItems.unshift(data);
  renderPantryGrid(pantryItems);
  updateDashboard();
  closeModal('addItemModal');
  showToast(`${emoji} ${name} added to pantry!`);
}

// ── DELETE ITEM ───────────────────────────────────────────────
async function deleteItem(id) {
  const { error } = await db.from('pantry_items').delete().eq('id', id);
  if (error) { showToast('Delete failed: ' + error.message, 'danger'); return; }

  pantryItems = pantryItems.filter(i => i.id !== id);
  renderPantryGrid(pantryItems);
  updateDashboard();
  showToast('Item removed.');
}

// ── EMOJI HELPER ──────────────────────────────────────────────
function categoryEmoji(cat) {
  return { produce:'🥬', dairy:'🧀', protein:'🥩', grain:'🌾', other:'🥫' }[cat] || '🥫';
}

// ── CAMERA / SCAN ─────────────────────────────────────────────
async function toggleCamera() {
  const btn = document.getElementById('camToggleBtn');
  if (scanStream) { stopCamera(); return; }

  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = document.getElementById('videoEl');
    video.srcObject = scanStream;
    video.classList.remove('hidden');
    document.getElementById('cameraBox').classList.add('hidden');
    btn.textContent = '⏹ Stop Camera';

    // Add capture button dynamically if not present
    if (!document.getElementById('captureBtn')) {
      const capBtn = document.createElement('button');
      capBtn.id = 'captureBtn';
      capBtn.className = 'btn-scan';
      capBtn.style = 'margin-top:10px;width:100%';
      capBtn.textContent = '📸 Capture & Analyze';
      capBtn.onclick = captureFrame;
      document.querySelector('.scan-controls').insertBefore(capBtn, document.getElementById('camToggleBtn').nextSibling);
    }
  } catch (err) {
    showToast('Camera access denied: ' + err.message, 'danger');
  }
}

function stopCamera() {
  if (scanStream) {
    scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
  }
  const video = document.getElementById('videoEl');
  video.classList.add('hidden');
  video.srcObject = null;
  document.getElementById('cameraBox').classList.remove('hidden');
  const btn = document.getElementById('camToggleBtn');
  if (btn) btn.textContent = '▶ Start Camera';
  document.getElementById('captureBtn')?.remove();
}

function captureFrame() {
  const video  = document.getElementById('videoEl');
  const canvas = document.getElementById('canvasEl');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  analyzeImage(dataUrl.split(',')[1]);
}

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => analyzeImage(e.target.result.split(',')[1]);
  reader.readAsDataURL(file);
}

// ── AI IMAGE ANALYSIS (Claude) ────────────────────────────────
async function analyzeImage(base64Data) {
  if (!ANTHROPIC_API_KEY) {
    showToast('Anthropic API key not configured. Set ANTHROPIC_API_KEY in Railway variables.', 'danger');
    return;
  }

  showScanProgress(true);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: base64Data }
            },
            {
              type: 'text',
              text: `Identify food items in this image. Return ONLY a JSON array of objects. Each object: {"name":"item name","category":"produce|dairy|protein|grain|other","emoji":"single emoji"}. 3-8 items max. No extra text.`
            }
          ]
        }]
      })
    });

    const result = await response.json();
    const raw    = result.content?.[0]?.text || '[]';
    const clean  = raw.replace(/```json|```/g, '').trim();
    const items  = JSON.parse(clean);

    scanCount += items.length;
    document.getElementById('statScanned').textContent = scanCount;

    showDetectedItems(items);
  } catch (err) {
    showToast('Analysis failed: ' + err.message, 'danger');
  } finally {
    showScanProgress(false);
  }
}

function showScanProgress(show) {
  const prog = document.getElementById('scanProgress');
  prog.classList.toggle('hidden', !show);
  if (show) animateProgressBar();
}

function animateProgressBar() {
  const fill = document.getElementById('progressFill');
  let w = 0;
  fill.style.width = '0%';
  const iv = setInterval(() => {
    w = Math.min(w + Math.random() * 8, 92);
    fill.style.width = w + '%';
    if (w >= 92) clearInterval(iv);
  }, 120);
}

function showDetectedItems(items) {
  const section = document.getElementById('detectedSection');
  const tags    = document.getElementById('foodTags');
  selectedFoodTags.clear();

  if (!items.length) {
    showToast('No food items detected. Try a clearer photo.', 'danger');
    return;
  }

  tags.innerHTML = items.map((item, i) => `
    <div class="food-tag selected" data-index="${i}"
         onclick="toggleFoodTag(this, ${i})"
         data-item='${JSON.stringify(item)}'>
      ${item.emoji} ${item.name}
    </div>`).join('');

  // Pre-select all
  items.forEach((_, i) => selectedFoodTags.add(i));
  section.classList.remove('hidden');
}

function toggleFoodTag(el, i) {
  if (selectedFoodTags.has(i)) { selectedFoodTags.delete(i); el.classList.remove('selected'); }
  else                          { selectedFoodTags.add(i);    el.classList.add('selected'); }
}

async function addSelectedToPantry() {
  const tags = document.querySelectorAll('.food-tag');
  const toAdd = [];

  tags.forEach(tag => {
    const i = parseInt(tag.dataset.index);
    if (selectedFoodTags.has(i)) toAdd.push(JSON.parse(tag.dataset.item));
  });

  if (!toAdd.length) { showToast('Select at least one item.', 'danger'); return; }

  const rows = toAdd.map(item => ({
    user_id: currentUser.id,
    name: item.name,
    category: item.category || 'other',
    quantity: '1',
    emoji: item.emoji || '🥫'
  }));

  const { data, error } = await db.from('pantry_items').insert(rows).select();
  if (error) { showToast('Error saving: ' + error.message, 'danger'); return; }

  pantryItems = [...(data || []), ...pantryItems];
  renderPantryGrid(pantryItems);
  updateDashboard();
  document.getElementById('detectedSection').classList.add('hidden');
  showToast(`✦ ${toAdd.length} item(s) added to pantry!`);
}

// ── DEMO SCAN ─────────────────────────────────────────────────
function runDemoScan() {
  const demoItems = [
    { name: 'Spinach',   category: 'produce', emoji: '🥬' },
    { name: 'Eggs',      category: 'protein', emoji: '🥚' },
    { name: 'Cheddar',   category: 'dairy',   emoji: '🧀' },
    { name: 'Tomatoes',  category: 'produce', emoji: '🍅' },
    { name: 'Bread',     category: 'grain',   emoji: '🍞' }
  ];
  showDetectedItems(demoItems);
  showToast('Demo scan complete — select items to add!');
}

// ── RECIPE GENERATION (Claude) ────────────────────────────────
async function generateRecipes() {
  if (!ANTHROPIC_API_KEY) {
    showToast('Anthropic API key not configured. Set ANTHROPIC_API_KEY in Railway variables.', 'danger');
    return;
  }

  if (pantryItems.length === 0) {
    showToast('Add items to your pantry first!', 'danger');
    return;
  }

  const grid = document.getElementById('recipeGrid');
  const note = document.getElementById('recipeNote');
  grid.innerHTML = '<p class="empty-state" style="color:var(--accent)">✦ Generating recipes…</p>';
  note.textContent = 'Asking Claude…';

  // Prioritize expiring items
  const today   = new Date();
  const sorted  = [...pantryItems].sort((a, b) => {
    if (!a.expiry_date) return 1;
    if (!b.expiry_date) return -1;
    return new Date(a.expiry_date) - new Date(b.expiry_date);
  });

  const itemList = sorted.map(i =>
    `${i.name} (${i.category}${i.expiry_date ? ', expires ' + i.expiry_date : ''})`
  ).join(', ');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1800,
        messages: [{
          role: 'user',
          content: `You are a smart chef assistant. Given these pantry items: ${itemList}

Generate 4 recipes that use these ingredients (prioritize items expiring soon).
Return ONLY a JSON array. Each recipe object must have:
- "name": string
- "emoji": single food emoji
- "time": string like "20 min"
- "difficulty": "Easy" | "Medium" | "Hard"
- "servings": number
- "usedIngredients": string[] (items from pantry)
- "missingIngredients": string[] (extra items needed, max 3)
- "steps": string[] (4-6 concise cooking steps)

No extra text, no markdown fences.`
        }]
      })
    });

    const result = await response.json();
    const raw    = result.content?.[0]?.text || '[]';
    const clean  = raw.replace(/```json|```/g, '').trim();
    const recipes = JSON.parse(clean);

    renderRecipes(recipes);
    note.textContent = `${recipes.length} recipes generated from your pantry`;
  } catch (err) {
    grid.innerHTML = '<p class="empty-state">Recipe generation failed. Check your API key.</p>';
    note.textContent = '';
    showToast('Error: ' + err.message, 'danger');
  }
}

function renderRecipes(recipes) {
  const grid = document.getElementById('recipeGrid');
  if (!recipes.length) {
    grid.innerHTML = '<p class="empty-state">No recipes could be generated.</p>';
    return;
  }

  grid.innerHTML = recipes.map((r, i) => {
    const full    = r.missingIngredients?.length === 0;
    const matchCls = full ? 'full' : 'partial';
    const matchTxt = full
      ? '✓ All ingredients available'
      : `⚠ ${r.missingIngredients?.length || 0} ingredient(s) missing`;

    const usedTags    = (r.usedIngredients || []).map(x => `<span class="rtag use">${x}</span>`).join('');
    const missingTags = (r.missingIngredients || []).map(x => `<span class="rtag missing">${x}</span>`).join('');

    return `<div class="recipe-card" onclick="openRecipe(${i})" data-index="${i}" data-recipe='${JSON.stringify(r).replace(/'/g, '&#39;')}'>
      <div class="recipe-img">${r.emoji || '🍽️'}</div>
      <div class="recipe-body">
        <div class="recipe-name">${r.name}</div>
        <div class="recipe-meta">
          <span>⏱ ${r.time}</span>
          <span>👤 ${r.servings} servings</span>
          <span>${r.difficulty}</span>
        </div>
        <div class="recipe-match ${matchCls}">${matchTxt}</div>
        <div class="recipe-tags">${usedTags}${missingTags}</div>
      </div>
    </div>`;
  }).join('');
}

function openRecipe(index) {
  const card   = document.querySelector(`.recipe-card[data-index="${index}"]`);
  const r      = JSON.parse(card.dataset.recipe);
  const pantryNames = pantryItems.map(i => i.name.toLowerCase());

  const ingredientRows = [
    ...(r.usedIngredients || []).map(x => `<li class="have">✓ ${x}</li>`),
    ...(r.missingIngredients || []).map(x => `<li class="missing-item">✗ ${x} <span style="color:var(--muted2);font-size:11px">— need to buy</span></li>`)
  ].join('');

  const stepRows = (r.steps || []).map(s => `<li>${s}</li>`).join('');

  document.getElementById('recipeModalContent').innerHTML = `
    <div class="recipe-detail-header">
      <div class="recipe-detail-emoji">${r.emoji || '🍽️'}</div>
      <div class="recipe-detail-info">
        <h2>${r.name}</h2>
        <div class="recipe-detail-meta">
          <span>⏱ ${r.time}</span>
          <span>👤 ${r.servings} servings</span>
          <span>${r.difficulty}</span>
        </div>
      </div>
    </div>
    <div class="recipe-section">
      <h3>Ingredients</h3>
      <ul class="ingredient-list">${ingredientRows}</ul>
    </div>
    <div class="recipe-section">
      <h3>Instructions</h3>
      <ol class="step-list">${stepRows}</ol>
    </div>`;

  showModal('recipeModal');
}

// ── KEYBOARD SHORTCUTS ────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach(m => m.classList.add('hidden'));
  }
});
