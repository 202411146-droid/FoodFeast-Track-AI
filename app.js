// ============================================================
//  FoodFeast Track AI — app.js
//  Supabase-powered pantry + AI recipe generation
// ============================================================

// ── Password strength indicator ──────────────────────────────
function updateStrength(val) {
  const bar   = document.getElementById('strengthBar');
  const fill  = document.getElementById('strengthFill');
  const label = document.getElementById('strengthLabel');
  const hLen  = document.getElementById('hint-len');
  const hUp   = document.getElementById('hint-upper');
  const hNum  = document.getElementById('hint-num');
  if (!bar) return;

  const hasLen   = val.length >= 8;
  const hasUpper = /[A-Z]/.test(val);
  const hasNum   = /[0-9]/.test(val);
  const hasSpec  = /[^a-zA-Z0-9]/.test(val);

  hLen.style.color  = hasLen   ? '#22c55e' : '#aaa';
  hUp.style.color   = hasUpper ? '#22c55e' : '#aaa';
  hNum.style.color  = hasNum   ? '#22c55e' : '#aaa';

  const score = [hasLen, hasUpper, hasNum, hasSpec, val.length >= 12].filter(Boolean).length;

  bar.style.display = val.length ? 'block' : 'none';
  const configs = [
    { w:'20%', bg:'#ef4444', txt:'Weak' },
    { w:'40%', bg:'#f97316', txt:'Fair' },
    { w:'60%', bg:'#eab308', txt:'Good' },
    { w:'80%', bg:'#84cc16', txt:'Strong' },
    { w:'100%',bg:'#22c55e', txt:'Very Strong' },
  ];
  const cfg = configs[Math.max(0, score - 1)] || configs[0];
  fill.style.width      = val.length ? cfg.w  : '0%';
  fill.style.background = val.length ? cfg.bg : 'transparent';
  label.textContent     = val.length ? cfg.txt : '';
  label.style.color     = val.length ? cfg.bg : 'var(--muted)';
}

// ── CONFIGURATION ────────────────────────────────────────────
// Read from Railway environment variables (injected by server.js)
// Fallback to window.ENV for Railway, or hardcoded values for local dev
const SUPABASE_URL = window.ENV?.SUPABASE_URL || 'https://jrnvnmchfmdkgcsvytli.supabase.co';
const SUPABASE_ANON_KEY = window.ENV?.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpybnZubWNoZm1ka2djc3Z5dGxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1NDUyMDMsImV4cCI6MjA5MzEyMTIwM30.Kw--5RXc2n7VFZ6jidceXS5W8Z6UOPvkcXg5Z3FOnsg';

// Gemini API key (set GEMINI_API_KEY in Railway environment variables)
const GEMINI_API_KEY = window.ENV?.GEMINI_API_KEY;

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
  const { data: { session } } = await db.auth.getSession();
  if (session) {
    // Only restore session if email is verified
    if (session.user.email_confirmed_at) {
      currentUser = session.user;
      enterApp();
    } else {
      await db.auth.signOut();
    }
  }

  db.auth.onAuthStateChange((event, session) => {
    // Ignore automatic SIGNED_IN right after signUp()
    if (event === 'SIGNED_IN' && window._justSignedUp) {
      window._justSignedUp = false;
      return;
    }
    currentUser = session?.user ?? null;
    if (currentUser && currentUser.email_confirmed_at) enterApp();
    else if (!currentUser) leaveApp();
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

  const { data, error } = await db.auth.signInWithPassword({ email, password });

  btn.textContent = 'Sign In';
  btn.disabled = false;

  if (error) { errEl.textContent = error.message; return; }

  // Block login if email not yet verified
  const user = data?.user;
  if (user && !user.email_confirmed_at) {
    await db.auth.signOut();
    errEl.textContent = 'Please verify your email before signing in.';
  }
}

// ── AUTH: SIGN UP — Step 1: validate & send OTP ───────────────
// Nothing is created in the database here. Only sends a code.
async function doSignUp() {
  const username = document.getElementById('signupUsername').value.trim();
  const email    = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPass').value;
  const confirm  = document.getElementById('signupConfirm').value;
  const tos      = document.getElementById('tosCheck').checked;
  const errEl    = document.getElementById('signupErr');
  const btn      = document.getElementById('signupBtn');

  errEl.textContent = '';
  if (!username)                       { errEl.textContent = 'Please enter a username.'; return; }
  if (username.length < 3)             { errEl.textContent = 'Username must be at least 3 characters.'; return; }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) { errEl.textContent = 'Username can only contain letters, numbers, and underscores.'; return; }
  if (!email || !password || !confirm) { errEl.textContent = 'Please fill in all fields.'; return; }
  if (password !== confirm)            { errEl.textContent = 'Passwords do not match.'; return; }
  if (password.length < 8)             { errEl.textContent = 'Password must be at least 8 characters.'; return; }
  if (!/[A-Z]/.test(password))         { errEl.textContent = 'Password must contain at least one uppercase letter.'; return; }
  if (!/[0-9]/.test(password))         { errEl.textContent = 'Password must contain at least one number.'; return; }
  if (!tos)                            { errEl.textContent = 'Please accept the Terms of Service.'; return; }

  btn.textContent = 'Sending code…';
  btn.disabled = true;

  try {
    const resp = await fetch('/api/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const result = await resp.json();

    if (!resp.ok || !result.success) {
      errEl.textContent = result.error || 'Could not send verification email. Please try again.';
      return;
    }

    // Hold credentials in memory only — NOT in DB yet
    window._pendingVerifyEmail    = email;
    window._pendingVerifyPassword = password;
    window._pendingVerifyUsername = username;

    // Show OTP screen
    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('verifyScreen').classList.remove('hidden');
    document.getElementById('verifyEmailAddr').textContent = email;
    document.getElementById('otpInput').value = '';
    document.getElementById('otpErr').textContent = '';

  } catch (err) {
    errEl.textContent = 'Network error. Please check your connection.';
  } finally {
    btn.textContent = 'Send Verification Code';
    btn.disabled = false;
  }
}

// ── AUTH: SIGN UP — Step 2: verify OTP then create account ────
// db.auth.signUp() is ONLY called here, after the code is confirmed.
// This is the first moment any record is written to the database.
async function confirmOTP() {
  const otp   = document.getElementById('otpInput').value.trim();
  const errEl = document.getElementById('otpErr');
  const btn   = document.getElementById('otpBtn');

  errEl.textContent = '';
  if (!otp || otp.length !== 6) { errEl.textContent = 'Please enter the 6-digit code.'; return; }

  btn.textContent = 'Verifying…';
  btn.disabled = true;

  try {
    // Confirm OTP with server
    const resp = await fetch('/api/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: window._pendingVerifyEmail, otp })
    });
    const result = await resp.json();

    if (!resp.ok || !result.verified) {
      errEl.textContent = result.error || 'Invalid code. Please try again.';
      btn.textContent = 'Verify & Create Account';
      btn.disabled = false;
      return;
    }

    // OTP confirmed — NOW create the Supabase account
    btn.textContent = 'Creating account…';
    window._justSignedUp = true;

    const { error } = await db.auth.signUp({
      email: window._pendingVerifyEmail,
      password: window._pendingVerifyPassword,
      options: {
        data: { username: window._pendingVerifyUsername }
      }
    });

    if (error) {
      errEl.textContent = error.message.includes('already registered')
        ? 'An account with this email already exists. Please sign in.'
        : error.message;
      window._justSignedUp = false;
      btn.textContent = 'Verify & Create Account';
      btn.disabled = false;
      return;
    }

    // Success — sign out and go to sign-in
    await db.auth.signOut();
    window._pendingVerifyPassword = null;

    document.getElementById('verifyScreen').classList.add('hidden');
    document.getElementById('authScreen').classList.remove('hidden');
    switchAuthTab('signin');
    document.getElementById('loginEmail').value = window._pendingVerifyEmail;
    showToast('✅ Email verified! Account created. Please sign in.');

  } catch (err) {
    errEl.textContent = 'Something went wrong. Please try again.';
    btn.textContent = 'Verify & Create Account';
    btn.disabled = false;
  }
}

// ── RESEND OTP ────────────────────────────────────────────────
async function resendOTP() {
  const btn   = document.getElementById('resendBtn');
  const errEl = document.getElementById('otpErr');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  errEl.textContent = '';
  try {
    const resp = await fetch('/api/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: window._pendingVerifyEmail })
    });
    const result = await resp.json();
    if (resp.ok && result.success) {
      showToast('New code sent! Check your inbox.');
    } else {
      errEl.textContent = result.error || 'Failed to resend. Please try again.';
    }
  } catch (e) {
    errEl.textContent = 'Network error. Please try again.';
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = 'Resend Code'; }, 5000);
}

// ── AUTH: SIGN OUT ────────────────────────────────────────────
async function doLogout() {
  stopCamera();
  await db.auth.signOut();
}

function backToSignIn() {
  document.getElementById('verifyScreen').classList.add('hidden');
  document.getElementById('authScreen').classList.remove('hidden');
  switchAuthTab('signin');
  window._pendingVerifyEmail    = null;
  window._pendingVerifyPassword = null;
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
}

// ── APP ENTER / LEAVE ─────────────────────────────────────────
function enterApp() {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('mainApp').classList.remove('hidden');

  // Populate user chip
  const username = currentUser.user_metadata?.username || currentUser.email?.split('@')[0] || 'User';
  document.getElementById('userEmailDisplay').textContent = username;
  document.getElementById('userAvatar').textContent = username.charAt(0).toUpperCase();

  setGreeting();
  pantryItems = [];
  recipeStore = {};
  loadPantry();
  loadFavorites();
}

function leaveApp() {
  document.getElementById('mainApp').classList.add('hidden');
  document.getElementById('authScreen').classList.remove('hidden');
  pantryItems = [];
  recipeStore = {};
  favoriteIds = new Set();
}

// ── GREETING ──────────────────────────────────────────────────
function setGreeting() {
  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const username = currentUser?.user_metadata?.username || '';
  document.getElementById('dashGreeting').textContent = username ? `${greet}, ${username} ✦` : `${greet} ✦`;
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

/* ===================================================
   NOTIFICATION SYSTEM
   =================================================== */

let notifications = [];
let notifIdCounter = 0;

function toggleNotifPanel() {
  const panel  = document.getElementById('notifPanel');
  const btn    = document.getElementById('notifBtn');
  const hidden = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !hidden);
  btn.classList.toggle('active', hidden);
  if (hidden) markAllRead();
}

function markAllRead() {
  notifications.forEach(n => n.unread = false);
  renderNotifList();
  updateNotifBadge();
}

function updateNotifBadge() {
  const unread = notifications.filter(n => n.unread).length;
  const badge  = document.getElementById('notifBadge');
  if (!badge) return;
  if (unread > 0) {
    badge.textContent = unread > 9 ? '9+' : unread;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function renderNotifList() {
  const list = document.getElementById('notifList');
  if (!list) return;
  if (notifications.length === 0) {
    list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
    return;
  }
  list.innerHTML = notifications.map(n => `
    <div class="notif-item ${n.unread ? 'unread' : ''}" id="notif-${n.id}">
      <div class="notif-icon ${n.type}">${n.emoji}</div>
      <div class="notif-body">
        <div class="notif-msg">${n.message}</div>
        <div class="notif-time">${n.time}</div>
      </div>
      ${n.unread ? '<div class="notif-unread-dot"></div>' : ''}
      <button class="notif-dismiss" onclick="dismissNotification(${n.id})" title="Dismiss">✕</button>
    </div>
  `).join('');
}

function addNotification(message, type = 'info', emoji = '🔔') {
  const id = ++notifIdCounter;
  notifications.unshift({
    id, message, type, emoji,
    unread: true,
    time: formatNotifTime(new Date()),
  });
  // Keep max 20 notifications
  if (notifications.length > 20) notifications.pop();
  renderNotifList();
  updateNotifBadge();
}

function dismissNotification(id) {
  notifications = notifications.filter(n => n.id !== id);
  renderNotifList();
  updateNotifBadge();
}

function clearAllNotifications() {
  notifications = [];
  renderNotifList();
  updateNotifBadge();
}

function formatNotifTime(date) {
  const now  = new Date();
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60)  return 'Just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* ── Auto-scan pantry on load & fire relevant notifications ── */
function checkExpiryNotifications(items) {
  const today = new Date();
  today.setHours(0,0,0,0);

  const expired   = [];
  const critical  = []; // ≤ 1 day
  const soon      = []; // 2-7 days

  items.forEach(item => {
    if (!item.expiry_date) return;
    const exp = new Date(item.expiry_date);
    exp.setHours(0,0,0,0);
    const days = Math.round((exp - today) / 86400000);
    if (days < 0)       expired.push({ ...item, days });
    else if (days <= 1) critical.push({ ...item, days });
    else if (days <= 7) soon.push({ ...item, days });
  });

  // Fire notifications (oldest first so most critical appears on top)
  if (expired.length) {
    addNotification(
      `<strong>${expired.length} item${expired.length > 1 ? 's' : ''}</strong> in your pantry ${expired.length > 1 ? 'have' : 'has'} expired — consider removing them.`,
      'danger', '🗑️'
    );
  }
  if (critical.length) {
    const names = critical.slice(0, 2).map(i => `<strong>${i.name}</strong>`).join(', ');
    const extra = critical.length > 2 ? ` +${critical.length - 2} more` : '';
    addNotification(
      `${names}${extra} expire${critical.length === 1 ? 's' : ''} today or tomorrow — use it soon!`,
      'danger', '⚠️'
    );
  }
  if (soon.length) {
    const names = soon.slice(0, 2).map(i => `<strong>${i.name}</strong>`).join(', ');
    const extra = soon.length > 2 ? ` +${soon.length - 2} more` : '';
    addNotification(
      `${names}${extra} expir${soon.length === 1 ? 'es' : 'e'} within 7 days.`,
      'warn', '🕐'
    );
  }
  if (items.length > 0 && expired.length === 0 && critical.length === 0 && soon.length === 0) {
    addNotification('All pantry items are fresh — great job! 🥬', 'success', '✅');
  }
}

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
  const readyCount = 0;
  document.getElementById('statRecipes').textContent = readyCount;
  document.getElementById('statScanned').textContent   = scanCount;

  // Expiry list
  checkExpiryNotifications(pantryItems);
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
  addNotification(`${emoji} <strong>${name}</strong> was added to your pantry.`, 'success', emoji);
}

// ── DELETE ITEM ───────────────────────────────────────────────
async function deleteItem(id) {
  const { error } = await db.from('pantry_items').delete().eq('id', id);
  if (error) { showToast('Delete failed: ' + error.message, 'danger'); return; }

  pantryItems = pantryItems.filter(i => i.id !== id);
  renderPantryGrid(pantryItems);
  updateDashboard();
  showToast('Item removed.');
  addNotification('A pantry item was removed.', 'info', '🗑️');
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

    // Clear any previous captured image preview and scan overlay
    document.getElementById('imgPreview')?.remove();
    document.getElementById('scanOverlay')?.remove();

    video.srcObject = scanStream;
    video.style.display = 'block';
    // Hide only the placeholder content, keep the camera-box visible
    const placeholder = document.getElementById('cameraPlaceholder');
    if (placeholder) placeholder.style.display = 'none';
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
    let msg = 'Camera access denied.';
    if (err.name === 'NotAllowedError')  msg = 'Camera permission denied. Please allow camera access in your browser settings and reload.';
    if (err.name === 'NotFoundError')    msg = 'No camera found on this device.';
    if (err.name === 'NotReadableError') msg = 'Camera is in use by another app. Please close it and try again.';
    if (err.name === 'OverconstrainedError') msg = 'Camera not available. Try Upload Photo instead.';
    showToast(msg, 'danger');
  }
}

function stopCamera() {
  if (scanStream) {
    scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
  }
  const video = document.getElementById('videoEl');
  video.style.display = 'none';
  video.srcObject = null;
  // Restore placeholder
  const placeholder = document.getElementById('cameraPlaceholder');
  if (placeholder) placeholder.style.display = '';
  const btn = document.getElementById('camToggleBtn');
  if (btn) btn.textContent = '▶ Start Camera';
  document.getElementById('captureBtn')?.remove();
}

function captureFrame() {
  const video  = document.getElementById('videoEl');
  const canvas = document.getElementById('canvasEl');
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  // Stop camera stream but show the captured frame as preview
  if (scanStream) {
    scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
  }
  video.style.display = 'none';
  const placeholder = document.getElementById('cameraPlaceholder');
  if (placeholder) placeholder.style.display = 'none';
  document.getElementById('captureBtn')?.remove();
  document.getElementById('camToggleBtn').textContent = '▶ Start Camera';
  showImagePreview(dataUrl);
  analyzeImage(dataUrl.split(',')[1], dataUrl);
}

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    showImagePreview(e.target.result);
    analyzeImage(e.target.result.split(',')[1], e.target.result);
  };
  reader.readAsDataURL(file);
}

function showImagePreview(dataUrl) {
  const box = document.getElementById('cameraBox');
  // Remove old preview if any
  const old = document.getElementById('imgPreview');
  if (old) old.remove();
  const img = document.createElement('img');
  img.id = 'imgPreview';
  img.src = dataUrl;
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:var(--radius);position:absolute;top:0;left:0;z-index:2;';
  box.style.position = 'relative';
  box.appendChild(img);
  // Add scan overlay pulse
  const pulse = document.createElement('div');
  pulse.id = 'scanOverlay';
  pulse.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:3;pointer-events:none;border-radius:var(--radius);';
  pulse.innerHTML = '<div id="scanLine" style="position:absolute;top:0;left:0;width:100%;height:3px;background:linear-gradient(90deg,transparent,#C85A2A,transparent);box-shadow:0 0 8px #C85A2A;animation:scanAnim 1.2s ease-in-out infinite;"></div>';
  box.appendChild(pulse);
}

function clearImagePreview() {
  document.getElementById('imgPreview')?.remove();
  document.getElementById('scanOverlay')?.remove();
}

// ── EXPIRY DATE LOGIC ─────────────────────────────────────────
// Returns suggested expiry date string (YYYY-MM-DD) based on food type
function suggestExpiry(name, category) {
  const n = name.toLowerCase();
  const today = new Date();
  let days = 7; // default

  // Produce
  if (category === 'produce') {
    if (/banana|avocado/.test(n))         days = 5;
    else if (/berry|berries|strawb|rasp|blueb/.test(n)) days = 4;
    else if (/leafy|spinach|lettuce|arugula|kale/.test(n)) days = 5;
    else if (/herb|basil|cilantro|parsley/.test(n)) days = 7;
    else if (/mushroom/.test(n))          days = 7;
    else if (/tomato/.test(n))            days = 7;
    else if (/apple|pear|grape/.test(n))  days = 14;
    else if (/citrus|orange|lemon|lime/.test(n)) days = 21;
    else if (/carrot|beet|potato|onion|garlic/.test(n)) days = 21;
    else if (/broccoli|cauliflower|zucchini/.test(n)) days = 7;
    else days = 7;
  }
  // Dairy
  else if (category === 'dairy') {
    if (/milk/.test(n))                   days = 7;
    else if (/yogurt|yoghurt/.test(n))    days = 14;
    else if (/cream/.test(n))             days = 10;
    else if (/butter/.test(n))            days = 30;
    else if (/hard.*cheese|cheddar|parmesan|gouda/.test(n)) days = 30;
    else if (/soft.*cheese|brie|camembert|ricotta/.test(n)) days = 7;
    else if (/cheese/.test(n))            days = 14;
    else if (/egg/.test(n))               days = 21;
    else days = 10;
  }
  // Protein
  else if (category === 'protein') {
    if (/raw.*chicken|chicken.*raw|ground.*beef|raw.*meat/.test(n)) days = 2;
    else if (/chicken|beef|pork|lamb|turkey|meat/.test(n)) days = 3;
    else if (/fish|salmon|tuna|shrimp|seafood/.test(n)) days = 2;
    else if (/tofu/.test(n))              days = 5;
    else if (/deli|ham|bacon|sausage/.test(n)) days = 5;
    else if (/cooked/.test(n))            days = 4;
    else days = 3;
  }
  // Grain
  else if (category === 'grain') {
    if (/bread/.test(n))                  days = 5;
    else if (/cooked.*rice|leftover/.test(n)) days = 4;
    else days = 30; // dry grains keep long
  }
  // Other
  else {
    if (/leftover|cooked/.test(n))        days = 4;
    else if (/sauce|dressing|condiment/.test(n)) days = 30;
    else if (/juice/.test(n))             days = 7;
    else days = 14;
  }

  const exp = new Date(today);
  exp.setDate(exp.getDate() + days);
  return exp.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ── AI IMAGE ANALYSIS (Gemini) ────────────────────────────────
async function analyzeImage(base64Data, dataUrl) {
  if (!GEMINI_API_KEY) {
    showToast('Gemini API key not configured. Set GEMINI_API_KEY in Railway variables.', 'danger');
    clearImagePreview();
    return;
  }

  showScanProgress(true);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                inline_data: {
                  mime_type: 'image/jpeg',
                  data: base64Data
                }
              },
              {
                text: 'Look at this image and list every food item you can see. Return a JSON array. Each object must have: {"name":"specific food name","category":"produce or dairy or protein or grain or other","emoji":"one emoji","expiry_days":number,"calories_per_100g":number}. expiry_days = realistic days until expiry (banana=5, milk=7, raw chicken=2, cooked rice=4, canned goods=730, eggs=21). calories_per_100g = approximate calories (banana=89, whole milk=61, chicken breast=165, white rice=130, egg=155, bread=265, apple=52, carrot=41, cheddar=402). Return 1-10 items. Start with [ end with ]. No other text.'
              }
            ]
          }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 800 }
        })
      }
    );

    const result = await response.json();

    // Check for API-level errors
    if (result.error) {
      showToast('Gemini API error: ' + result.error.message, 'danger');
      clearImagePreview();
      return;
    }

    const raw = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('Gemini raw response:', raw);

    // Robust JSON extraction — find the first [ ... ] block
    let items = [];
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        items = JSON.parse(match[0]);
      } else {
        // Try parsing the whole thing as JSON
        items = JSON.parse(raw);
      }
    } catch (parseErr) {
      console.error('JSON parse failed:', parseErr, 'Raw:', raw);
      showToast('Could not read AI response. Try a clearer photo.', 'danger');
      clearImagePreview();
      return;
    }

    // Sanitize items — ensure they have required fields
    items = items.filter(item => item && item.name).map(item => {
      const category = ['produce','dairy','protein','grain','other'].includes(item.category) ? item.category : 'other';
      // Use AI-provided expiry_days, fallback to suggestExpiry
      let expiry_date = null;
      if (item.expiry_days && typeof item.expiry_days === 'number' && item.expiry_days > 0) {
        const exp = new Date();
        exp.setDate(exp.getDate() + Math.round(item.expiry_days));
        expiry_date = exp.toISOString().split('T')[0];
      } else {
        expiry_date = suggestExpiry(item.name, category);
      }
      return {
        name: item.name || 'Unknown item',
        category,
        emoji: item.emoji || '🥫',
        expiry_date,
        calories_per_100g: (item.calories_per_100g && typeof item.calories_per_100g === 'number') ? Math.round(item.calories_per_100g) : null
      };
    });

    if (!items.length) {
      showToast('No food items detected. Try a clearer or closer photo.', 'danger');
      clearImagePreview();
      return;
    }

    scanCount += items.length;
    document.getElementById('statScanned').textContent = scanCount;

    // Remove scan overlay, keep image preview
    document.getElementById('scanOverlay')?.remove();

    showDetectedItems(items);
  } catch (err) {
    console.error('analyzeImage error:', err);
    showToast('Analysis failed: ' + err.message, 'danger');
    clearImagePreview();
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

// Store scanned items in memory to avoid HTML attribute encoding issues
let scannedItems = [];

function showDetectedItems(items) {
  const section = document.getElementById('detectedSection');
  const tags    = document.getElementById('foodTags');
  selectedFoodTags.clear();
  scannedItems = items;

  tags.innerHTML = items.map((item, i) => {
    const exp = item.expiry_date ? new Date(item.expiry_date + 'T12:00:00') : null;
    const expStr = exp ? exp.toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '';
    const today = new Date(); today.setHours(0,0,0,0);
    const daysLeft = exp ? Math.round((exp - today) / 86400000) : null;
    const urgency = daysLeft !== null ? (daysLeft <= 3 ? 'exp-urgent' : daysLeft <= 7 ? 'exp-warn' : 'exp-ok') : '';
    const cal = item.calories_per_100g || 0;
    return `<div class="food-tag selected" data-index="${i}" onclick="toggleFoodTag(this, ${i})">
      <span class="tag-emoji">${item.emoji}</span>
      <span class="tag-name">${item.name}</span>
      ${expStr ? `<span class="tag-expiry ${urgency}">exp ${expStr}</span>` : ''}
      <div class="tag-qty-row" onclick="event.stopPropagation()">
        <input
          type="number"
          class="tag-qty-input"
          data-index="${i}"
          value="${item.quantity_amount || 1}"
          min="0.1"
          step="0.1"
          oninput="updateItemQty(${i}, this.value, this.nextElementSibling.value)"
        >
        <select
          class="tag-unit-select"
          data-index="${i}"
          onchange="updateItemQty(${i}, this.previousElementSibling.value, this.value)"
        >
          <option value="pcs" ${!item.quantity_unit || item.quantity_unit==='pcs' ? 'selected':''}>pcs</option>
          <option value="g"   ${item.quantity_unit==='g'   ? 'selected':''}>g</option>
          <option value="kg"  ${item.quantity_unit==='kg'  ? 'selected':''}>kg</option>
          <option value="ml"  ${item.quantity_unit==='ml'  ? 'selected':''}>ml</option>
          <option value="L"   ${item.quantity_unit==='L'   ? 'selected':''}>L</option>
          <option value="tbsp"${item.quantity_unit==='tbsp'? 'selected':''}>tbsp</option>
          <option value="cup" ${item.quantity_unit==='cup' ? 'selected':''}>cup</option>
        </select>
        ${cal ? `<span class="tag-calories" id="calLabel${i}">${Math.round(cal * (item.quantity_amount||1) / 100)} kcal</span>` : ''}
      </div>
    </div>`;
  }).join('');

  // Pre-select all
  items.forEach((_, i) => selectedFoodTags.add(i));
  section.classList.remove('hidden');
}

function updateItemQty(index, amount, unit) {
  const item = scannedItems[index];
  if (!item) return;
  const qty = parseFloat(amount) || 1;
  item.quantity_amount = qty;
  item.quantity_unit   = unit;
  item.quantity        = `${qty} ${unit}`;
  // Update calorie label if present
  const calLabel = document.getElementById(`calLabel${index}`);
  if (calLabel && item.calories_per_100g) {
    const multiplier = unit === 'g' ? qty / 100 : unit === 'kg' ? qty * 10 : qty / 100;
    calLabel.textContent = Math.round(item.calories_per_100g * multiplier) + ' kcal';
  }
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
    if (selectedFoodTags.has(i) && scannedItems[i]) toAdd.push(scannedItems[i]);
  });

  if (!toAdd.length) { showToast('Select at least one item.', 'danger'); return; }

  const rows = toAdd.map(item => ({
    user_id: currentUser.id,
    name: item.name,
    category: item.category || 'other',
    quantity: item.quantity || '1 pcs',
    emoji: item.emoji || '🥫',
    expiry_date: item.expiry_date || null
  }));

  const { data, error } = await db.from('pantry_items').insert(rows).select();
  if (error) { showToast('Error saving: ' + error.message, 'danger'); return; }

  pantryItems = [...(data || []), ...pantryItems];
  renderPantryGrid(pantryItems);
  updateDashboard();
  document.getElementById('detectedSection').classList.add('hidden');
  clearImagePreview();
  showToast(`✦ ${toAdd.length} item(s) added to pantry!`);
  addNotification(`✦ <strong>${toAdd.length} scanned item${toAdd.length > 1 ? 's' : ''}</strong> added to your pantry via AI scan.`, 'info', '📷');
}

// ── DEMO SCAN ─────────────────────────────────────────────────
// ── RECIPE GENERATION (Gemini) ────────────────────────────────
// ── DEFAULT RECIPES ───────────────────────────────────────────
function loadDefaultRecipes() {
  const defaults = [
    {
      name: "Garlic Fried Rice",
      emoji: "🍳",
      time: "15 min",
      difficulty: "Easy",
      servings: 2,
      usedIngredients: ["Rice", "Garlic", "Egg"],
      missingIngredients: ["Soy sauce"],
      steps: [
        "Cook rice ahead and let it cool (day-old rice works best).",
        "Heat oil in a pan over medium-high heat and sauté minced garlic until golden.",
        "Push garlic to the side, crack in eggs and scramble lightly.",
        "Add rice and mix everything together, breaking up clumps.",
        "Season with soy sauce and salt. Stir-fry for 3–4 minutes until heated through.",
        "Serve hot, topped with a fried egg if desired."
      ]
    },
    {
      name: "Vegetable Omelette",
      emoji: "🥚",
      time: "10 min",
      difficulty: "Easy",
      servings: 1,
      usedIngredients: ["Eggs", "Onion", "Tomato"],
      missingIngredients: [],
      steps: [
        "Beat 2–3 eggs with a pinch of salt and pepper.",
        "Dice onion and tomato into small pieces.",
        "Heat butter or oil in a non-stick pan over medium heat.",
        "Sauté onion for 1–2 minutes, then add tomato and cook briefly.",
        "Pour egg mixture over the vegetables and let it set on the edges.",
        "Fold the omelette in half and slide onto a plate."
      ]
    },
    {
      name: "Creamy Pasta",
      emoji: "🍝",
      time: "25 min",
      difficulty: "Medium",
      servings: 2,
      usedIngredients: ["Pasta", "Garlic", "Onion"],
      missingIngredients: ["Cream", "Parmesan"],
      steps: [
        "Boil pasta in salted water until al dente, reserve ½ cup pasta water.",
        "Sauté diced onion and garlic in butter until soft and fragrant.",
        "Add cream and let it simmer for 3–4 minutes until slightly thickened.",
        "Toss in drained pasta and mix well, adding pasta water to loosen if needed.",
        "Season with salt, pepper, and grated Parmesan.",
        "Serve immediately with extra cheese on top."
      ]
    }
  ];

  // Store in recipeStore and render
  defaults.forEach(r => { recipeStore[r.name] = r; });
  const grid = document.getElementById('recipeGrid');
  const note = document.getElementById('recipeNote');
  renderRecipes(defaults);
  note.textContent = 'Here are some quick ideas — or generate from your pantry!';
}

async function generateRecipes() {
  if (!GEMINI_API_KEY) {
    showToast('Gemini API key not configured. Set GEMINI_API_KEY in Railway variables.', 'danger');
    return;
  }

  if (pantryItems.length === 0) {
    showToast('Add items to your pantry first!', 'danger');
    return;
  }

  const grid = document.getElementById('recipeGrid');
  const note = document.getElementById('recipeNote');
  grid.innerHTML = '<p class="empty-state" style="color:var(--accent)">✦ Generating recipes…</p>';
  note.textContent = 'Asking Gemini…';

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
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are a smart chef assistant. Given these pantry items: ${itemList}

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
- "imageQuery": 2-3 word english food search term for this dish (e.g. "grilled salmon", "beef stew")

Start with [ and end with ]. No extra text, no markdown fences.`
            }]
          }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
        })
      }
    );

    const result = await response.json();
    if (result.error) throw new Error(result.error.message);

    const raw     = result.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const match   = raw.match(/\[[\s\S]*\]/);
    const clean   = match ? match[0] : raw.replace(/```json|```/g, '').trim();
    const recipes = JSON.parse(clean);

    renderRecipes(recipes);
    note.textContent = `${recipes.length} recipes generated from your pantry`;
    // Update dashboard stat
    const readyCount = recipes.filter(r => r.missingIngredients?.length === 0).length;
    document.getElementById('statRecipes').textContent = readyCount;
  } catch (err) {
    grid.innerHTML = '<p class="empty-state">Recipe generation failed. Check your Gemini API key.</p>';
    note.textContent = '';
    showToast('Error: ' + err.message, 'danger');
  }
}

// ── RECIPE IMAGE GENERATION (Unsplash — no API key needed) ──────
const recipeImageCache = {};

// Track used image URLs across recipe generation so no duplicates
const usedRecipeImages = new Set();

async function getRecipeImageUrl(recipe) {
  const query = (recipe.imageQuery || recipe.name)
    .replace(/[^a-zA-Z0-9 ]/g, '').trim().split(' ').slice(0, 3).join(' ');

  // Helper: pick first unused meal image from a results array
  function pickUnused(meals) {
    if (!meals?.length) return null;
    for (const meal of meals) {
      const url = meal.strMealThumb;
      if (url && !usedRecipeImages.has(url)) {
        usedRecipeImages.add(url);
        return url;
      }
    }
    // All used — just return first anyway
    return meals[0]?.strMealThumb || null;
  }

  // 1. Exact query match
  try {
    const res = await fetch(`https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(query)}`);
    const data = await res.json();
    const url = pickUnused(data.meals);
    if (url) return url;
  } catch(e) {}

  // 2. Each keyword in query tried individually
  for (const word of query.split(' ').filter(w => w.length > 3)) {
    try {
      const res = await fetch(`https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(word)}`);
      const data = await res.json();
      const url = pickUnused(data.meals);
      if (url) return url;
    } catch(e) {}
  }

  // 3. Category fallback — cycle through multiple categories to avoid repeats
  const categories = ['Seafood','Beef','Chicken','Pork','Pasta','Lamb','Vegetarian','Miscellaneous'];
  const catIdx = [...recipe.name].reduce((a,c) => a + c.charCodeAt(0), 0) % categories.length;
  for (let i = 0; i < categories.length; i++) {
    const cat = categories[(catIdx + i) % categories.length];
    try {
      const res = await fetch(`https://www.themealdb.com/api/json/v1/1/filter.php?c=${cat}`);
      const data = await res.json();
      // Shuffle deterministically using name hash so different recipes pick different meals
      const meals = data.meals || [];
      const offset = [...recipe.name].reduce((a,c) => a + c.charCodeAt(0), 0);
      const rotated = [...meals.slice(offset % meals.length), ...meals.slice(0, offset % meals.length)];
      const url = pickUnused(rotated);
      if (url) return url;
    } catch(e) {}
  }

  return null;
}


async function loadRecipeImages(recipes) {
  for (let i = 0; i < recipes.length; i++) {
    const r = recipes[i];
    const card = document.querySelector(`.recipe-card[data-index="${i}"]`);
    if (!card) continue;
    const imgBox = card.querySelector('.recipe-img');
    if (!imgBox) continue;

    const imgUrl = await getRecipeImageUrl(r);
    r._imgUrl = imgUrl;
    if (recipeStore[r.name]) recipeStore[r.name]._imgUrl = imgUrl;

    imgBox.classList.remove('loading');
    if (imgUrl) {
      imgBox.innerHTML = `<img src="${imgUrl}" alt="${r.name}" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.textContent='${r.emoji || '🍽️'}'">`;
    } else {
      imgBox.textContent = r.emoji || '🍽️';
    }
  }
}

// ── FAVORITES ─────────────────────────────────────────────────
let favoriteIds  = new Set(); // recipe names that are saved
let recipeStore  = {};        // name -> recipe object, populated on generate

async function loadFavorites() {
  if (!currentUser) return;
  const { data, error } = await db.from('saved_recipes').select('*').eq('user_id', currentUser.id);
  if (error) { console.error('loadFavorites error:', error); return; }
  favoriteIds = new Set((data || []).map(r => r.recipe_name));
  renderFavoritesGrid(data || []);
}

async function toggleFavorite(recipeName, btnEl) {
  if (!currentUser) return;

  if (favoriteIds.has(recipeName)) {
    // Remove
    const { error } = await db.from('saved_recipes').delete().eq('user_id', currentUser.id).eq('recipe_name', recipeName);
    if (error) { showToast('Error removing recipe: ' + error.message, 'danger'); return; }
    favoriteIds.delete(recipeName);
    // Update all matching buttons
    document.querySelectorAll('.fav-btn').forEach(b => {
      if (b.dataset.recipe === recipeName) { b.textContent = '🤍'; b.classList.remove('saved'); }
    });
    showToast('Recipe removed from saved.');
    loadFavorites();
  } else {
    // Save — look up recipe from store
    const recipeData = recipeStore[recipeName];
    if (!recipeData) { showToast('Could not save recipe. Try again.', 'danger'); return; }
    const { error } = await db.from('saved_recipes').insert([{
      user_id: currentUser.id,
      recipe_name: recipeName,
      recipe_data: recipeData
    }]);
    if (error) { showToast('Error saving recipe: ' + error.message, 'danger'); return; }
    favoriteIds.add(recipeName);
    document.querySelectorAll('.fav-btn').forEach(b => {
      if (b.dataset.recipe === recipeName) { b.textContent = '❤️'; b.classList.add('saved'); }
    });
    showToast('Recipe saved! ❤️');
    loadFavorites();
  }
}

// Re-check missingIngredients against current pantry in real time
function recalcRecipeIngredients(recipe) {
  const pantryNames = pantryItems.map(p => p.name.toLowerCase().trim());

  // An ingredient is "available" if any pantry item name contains it (or vice versa)
  function inPantry(ingredient) {
    const ing = ingredient.toLowerCase().trim();
    return pantryNames.some(p => p.includes(ing) || ing.includes(p));
  }

  const allIngredients = [
    ...(recipe.usedIngredients || []),
    ...(recipe.missingIngredients || [])
  ];

  recipe.usedIngredients    = allIngredients.filter(i => inPantry(i));
  recipe.missingIngredients = allIngredients.filter(i => !inPantry(i));
  return recipe;
}


async function loadSavedRecipeImages(recipes) {
  for (let i = 0; i < recipes.length; i++) {
    const r = recipes[i];
    const card = document.querySelector(`.recipe-card[data-saved-index="${i}"]`);
    if (!card) continue;
    const imgBox = card.querySelector('.recipe-img');
    if (!imgBox) continue;

    // Use cached image if already fetched (e.g. from Recipes page)
    const imgUrl = r._imgUrl || await getRecipeImageUrl(r);
    r._imgUrl = imgUrl;
    if (recipeStore[r.name]) recipeStore[r.name]._imgUrl = imgUrl;

    imgBox.classList.remove('loading');
    if (imgUrl) {
      imgBox.innerHTML = `<img src="${imgUrl}" alt="${r.name}" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.textContent='${r.emoji || '🍽️'}'">`;
    } else {
      imgBox.textContent = r.emoji || '🍽️';
    }
  }
}

function renderFavoritesGrid(rows) {
  const grid = document.getElementById('favoritesGrid');
  if (!rows.length) {
    grid.innerHTML = '<p class="empty-state">No saved recipes yet. Hit ❤ on any recipe to save it!</p>';
    return;
  }
  const recipes = rows.map(r => r.recipe_data);
  // Store in recipeStore so unsave works
  recipes.forEach(r => { recipeStore[r.name] = r; });

  grid.innerHTML = recipes.map((r, i) => {
    recalcRecipeIngredients(r); // re-check against current pantry
    const full = r.missingIngredients?.length === 0;
    const matchCls = full ? 'full' : 'partial';
    const matchTxt = full ? '✓ All ingredients available' : `⚠ ${r.missingIngredients?.length || 0} ingredient(s) missing`;
    const usedTags    = (r.usedIngredients || []).map(x => `<span class="rtag use">${x}</span>`).join('');
    const missingTags = (r.missingIngredients || []).map(x => `<span class="rtag missing">${x}</span>`).join('');
    return `<div class="recipe-card" onclick="openRecipeData('${r.name.replace(/'/g,"\\'").replace(/"/g,'&quot;')}')" style="cursor:pointer" data-saved-index="${i}">
      <div class="recipe-img loading">${r.emoji || '🍽️'}</div>
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
      <button class="fav-btn saved" data-recipe="${r.name.replace(/"/g,'&quot;')}" title="Remove from saved"
        onclick="event.stopPropagation(); toggleFavorite(this.dataset.recipe, this)">❤️</button>
    </div>`;
  }).join('');

  // Load unique food images for each saved recipe card
  usedRecipeImages.clear();
  loadSavedRecipeImages(recipes);
}

function renderRecipes(recipes) {
  const grid = document.getElementById('recipeGrid');
  if (!recipes.length) {
    grid.innerHTML = '<p class="empty-state">No recipes could be generated.</p>';
    return;
  }

  // Store all recipes so toggleFavorite can find them by name
  recipes.forEach(r => { recipeStore[r.name] = r; });

  grid.innerHTML = recipes.map((r, i) => {
    recalcRecipeIngredients(r); // re-check against current pantry
    const full    = r.missingIngredients?.length === 0;
    const matchCls = full ? 'full' : 'partial';
    const matchTxt = full
      ? '✓ All ingredients available'
      : `⚠ ${r.missingIngredients?.length || 0} ingredient(s) missing`;

    const usedTags    = (r.usedIngredients || []).map(x => `<span class="rtag use">${x}</span>`).join('');
    const missingTags = (r.missingIngredients || []).map(x => `<span class="rtag missing">${x}</span>`).join('');
    const isSaved = favoriteIds.has(r.name);

    return `<div class="recipe-card" onclick="openRecipe(${i})" data-index="${i}" data-recipe='${JSON.stringify(r).replace(/'/g, '&#39;')}'>
      <div class="recipe-img loading">${r.emoji || '🍽️'}</div>
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
      <button class="fav-btn ${isSaved ? 'saved' : ''}" data-recipe="${r.name.replace(/"/g,'&quot;')}"
        title="${isSaved ? 'Remove from saved' : 'Save recipe'}"
        onclick="event.stopPropagation(); toggleFavorite(this.dataset.recipe, this)">
        ${isSaved ? '❤️' : '🤍'}
      </button>
    </div>`;
  }).join('');

  // Reset used images tracker and fire async image loading
  usedRecipeImages.clear();
  loadRecipeImages(recipes);
}

function openRecipeData(recipeName) {
  const r = recipeStore[recipeName];
  if (!r) { showToast('Recipe data not found.', 'danger'); return; }
  _renderRecipeModal(r);
}

function openRecipe(index) {
  const card = document.querySelector(`.recipe-card[data-index="${index}"]`);
  const r    = JSON.parse(card.dataset.recipe);
  _renderRecipeModal(r);
}

function _renderRecipeModal(r) {
  recalcRecipeIngredients(r); // ensure modal reflects current pantry
  const isSaved = favoriteIds.has(r.name);

  const ingredientRows = [
    ...(r.usedIngredients || []).map(x => `<li class="have">✓ ${x}</li>`),
    ...(r.missingIngredients || []).map(x => `<li class="missing-item">✗ ${x} <span style="color:var(--muted2);font-size:11px">— need to buy</span></li>`)
  ].join('');

  const stepRows = (r.steps || []).map(s => `<li>${s}</li>`).join('');

  document.getElementById('recipeModalContent').innerHTML = `
    <div class="recipe-detail-header">
      <div class="recipe-detail-emoji">${r._imgUrl
        ? `<img src="${r._imgUrl}" alt="${r.name}" style="width:100%;height:100%;object-fit:cover;border-radius:10px;">`
        : (r.emoji || '🍽️')}</div>
      <div class="recipe-detail-info">
        <h2>${r.name}</h2>
        <div class="recipe-detail-meta">
          <span>⏱ ${r.time}</span>
          <span>👤 ${r.servings} servings</span>
          <span>${r.difficulty}</span>
        </div>
      </div>
      <button class="fav-btn modal-fav ${isSaved ? 'saved' : ''}"
        data-recipe="${r.name.replace(/"/g,'&quot;')}"
        title="${isSaved ? 'Remove from saved' : 'Save recipe'}"
        onclick="toggleFavorite(this.dataset.recipe, this)">
        ${isSaved ? '❤️' : '🤍'}
      </button>
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
