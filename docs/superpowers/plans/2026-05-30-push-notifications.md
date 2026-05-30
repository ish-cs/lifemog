# Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daily push notifications reminding users to log meals, with multiple configurable reminders per day (time + label), delivered via Web Push even when the app is closed.

**Architecture:** Netlify scheduled function (`notify.js`, cron every 15min) queries Firestore for all users with push subscriptions, finds reminders whose time window matches the user's local time, sends Web Push via the `web-push` npm package. Client subscribes via SW push manager, stores subscription + timezone + reminders in Firestore through a `subscribe.js` Netlify function.

**Tech Stack:** Web Push API, `web-push` npm package, VAPID keys, Netlify scheduled functions, Firebase Firestore, Service Worker Push API.

---

## Files

| File | Action | Purpose |
|---|---|---|
| `netlify.toml` | Create | Build config + cron schedule for `notify` function |
| `netlify/functions/package.json` | Create | `web-push` dependency for functions |
| `netlify/functions/subscribe.js` | Create | Store push subscription + reminders in Firestore |
| `netlify/functions/unsubscribe.js` | Create | Delete push subscription from Firestore |
| `netlify/functions/notify.js` | Create | Scheduled cron — send due push notifications |
| `sw.js` | Modify | Add `push` event listener + `notificationclick` handler |
| `index.html` | Modify | Settings UI (toggle + reminder list) + JS subscribe logic |

---

## Task 1: Generate VAPID keys and create netlify.toml

**Files:**
- Create: `netlify.toml`

- [ ] **Step 1: Install web-push globally to generate keys**

```bash
npm install -g web-push
web-push generate-vapid-keys
```

Expected output:
```
=======================================
Public Key:
BExamplePublicKeyBase64UrlEncoded...

Private Key:
ExamplePrivateKeyBase64UrlEncoded...
=======================================
```

- [ ] **Step 2: Set env vars in Netlify dashboard**

Go to: app.netlify.com/projects/coolforthesummer → Site configuration → Environment variables

Add:
- `VAPID_PUBLIC_KEY` = the public key from above
- `VAPID_PRIVATE_KEY` = the private key from above
- `VAPID_EMAIL` = `mailto:ishp@berkeley.edu`

- [ ] **Step 3: Also set in local .env for netlify dev**

```bash
# append to .env (create if missing — already gitignored)
echo 'VAPID_PUBLIC_KEY=<your-public-key>' >> .env
echo 'VAPID_PRIVATE_KEY=<your-private-key>' >> .env
echo 'VAPID_EMAIL=mailto:ishp@berkeley.edu' >> .env
```

- [ ] **Step 4: Create netlify.toml**

```toml
[build]
  functions = "netlify/functions"
  publish = "."

[functions."notify"]
  schedule = "*/15 * * * *"
```

- [ ] **Step 5: Commit**

```bash
git add netlify.toml
git commit -m "feat: add netlify.toml with notify cron schedule"
```

---

## Task 2: Add web-push dependency

**Files:**
- Create: `netlify/functions/package.json`

- [ ] **Step 1: Create package.json in functions directory**

```json
{
  "name": "lifemog-functions",
  "version": "1.0.0",
  "dependencies": {
    "web-push": "^3.6.7"
  }
}
```

- [ ] **Step 2: Install**

```bash
cd netlify/functions && npm install && cd ../..
```

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/package.json netlify/functions/package-lock.json
git commit -m "feat: add web-push dependency for push notifications"
```

---

## Task 3: Create subscribe.js

**Files:**
- Create: `netlify/functions/subscribe.js`

- [ ] **Step 1: Create the function**

```js
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { idToken, subscription, timezone, reminders } = body;

  if (!idToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

  let uid;
  try { uid = await verifyFirebaseToken(idToken); }
  catch (e) { return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: ' + e.message }) }; }

  if (!subscription?.endpoint || !subscription?.keys) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid subscription object' }) };
  }
  if (!timezone || typeof timezone !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'timezone required' }) };
  }
  if (!Array.isArray(reminders) || reminders.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'reminders array required' }) };
  }

  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    timezone,
    reminders: reminders.map(r => ({
      id: r.id || 'r_' + Math.random().toString(36).slice(2, 9),
      time: r.time || '10:00',
      label: (r.label || '').slice(0, 50),
      lastNotified: r.lastNotified || null,
    })),
  };

  try {
    await firestoreSet(uid, pushSubscription);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

async function verifyFirebaseToken(idToken) {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error('FIREBASE_API_KEY not configured');
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  const data = await res.json();
  if (!res.ok || !data.users?.length) throw new Error('Invalid or expired token');
  return data.users[0].localId;
}

async function firestoreSet(uid, pushSubscription) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID not configured');
  const token = await getServiceAccountToken();
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=pushSubscription`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      fields: {
        pushSubscription: { mapValue: { fields: toFirestoreFields(pushSubscription) } },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore error ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function getServiceAccountToken() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const sig = await signJWT(`${header}.${payload}`, sa.private_key);
  const jwt = `${header}.${payload}.${sig}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get service account token');
  return data.access_token;
}

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

async function signJWT(input, pemKey) {
  const crypto = require('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(input);
  return sign.sign(pemKey, 'base64url');
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      fields[k] = { nullValue: null };
    } else if (typeof v === 'string') {
      fields[k] = { stringValue: v };
    } else if (typeof v === 'boolean') {
      fields[k] = { booleanValue: v };
    } else if (typeof v === 'number') {
      fields[k] = { integerValue: v };
    } else if (Array.isArray(v)) {
      fields[k] = { arrayValue: { values: v.map(item =>
        typeof item === 'object' ? { mapValue: { fields: toFirestoreFields(item) } }
        : typeof item === 'string' ? { stringValue: item }
        : { nullValue: null }
      )}};
    } else if (typeof v === 'object') {
      fields[k] = { mapValue: { fields: toFirestoreFields(v) } };
    }
  }
  return fields;
}
```

- [ ] **Step 2: Add FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT env vars**

`FIREBASE_PROJECT_ID` = your Firebase project ID (find in Firebase console → Project settings).

`FIREBASE_SERVICE_ACCOUNT` = JSON contents of a service account key:
1. Firebase console → Project settings → Service accounts → Generate new private key
2. Download JSON
3. Set the entire JSON as the env var value in Netlify dashboard (and local .env)

```bash
echo 'FIREBASE_PROJECT_ID=your-project-id' >> .env
echo 'FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}' >> .env
```

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/subscribe.js
git commit -m "feat: add subscribe Netlify function for push subscriptions"
```

---

## Task 4: Create unsubscribe.js

**Files:**
- Create: `netlify/functions/unsubscribe.js`

- [ ] **Step 1: Create the function**

```js
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { idToken } = body;
  if (!idToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

  let uid;
  try { uid = await verifyFirebaseToken(idToken); }
  catch (e) { return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: ' + e.message }) }; }

  try {
    await deleteField(uid);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

async function verifyFirebaseToken(idToken) {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error('FIREBASE_API_KEY not configured');
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  const data = await res.json();
  if (!res.ok || !data.users?.length) throw new Error('Invalid or expired token');
  return data.users[0].localId;
}

async function deleteField(uid) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const token = await getServiceAccountToken();
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=pushSubscription`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: { pushSubscription: { nullValue: null } } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore error ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function getServiceAccountToken() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const sig = await signJWT(`${header}.${payload}`, sa.private_key);
  const jwt = `${header}.${payload}.${sig}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get service account token');
  return data.access_token;
}

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

async function signJWT(input, pemKey) {
  const crypto = require('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(input);
  return sign.sign(pemKey, 'base64url');
}
```

- [ ] **Step 2: Commit**

```bash
git add netlify/functions/unsubscribe.js
git commit -m "feat: add unsubscribe Netlify function"
```

---

## Task 5: Create notify.js (scheduled cron)

**Files:**
- Create: `netlify/functions/notify.js`

- [ ] **Step 1: Create the function**

```js
const webpush = require('web-push');

exports.handler = async () => {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL, FIREBASE_PROJECT_ID } = process.env;

  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const token = await getServiceAccountToken();
  const users = await getAllUsersWithSubscriptions(token, FIREBASE_PROJECT_ID);

  const now = new Date();
  const updates = [];

  for (const user of users) {
    const { uid, pushSubscription } = user;
    const { endpoint, keys, timezone, reminders } = pushSubscription;

    if (!endpoint || !keys || !timezone || !Array.isArray(reminders)) continue;

    const localNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    const localHHMM = `${String(localNow.getHours()).padStart(2,'0')}:${String(localNow.getMinutes()).padStart(2,'0')}`;
    const localDate = `${localNow.getFullYear()}-${String(localNow.getMonth()+1).padStart(2,'0')}-${String(localNow.getDate()).padStart(2,'0')}`;

    let changed = false;
    for (const reminder of reminders) {
      if (reminder.lastNotified === localDate) continue;
      if (!isInWindow(localHHMM, reminder.time)) continue;

      const label = reminder.label?.trim();
      const body = label ? `🍽 Log your ${label}!` : `🍽 Time to log your meals!`;

      try {
        await webpush.sendNotification(
          { endpoint, keys },
          JSON.stringify({ title: 'LifeMog', body, icon: '/icon-192.png', url: '/' })
        );
        reminder.lastNotified = localDate;
        changed = true;
      } catch (e) {
        if (e.statusCode === 410) {
          // Subscription expired — delete from Firestore
          await deleteSubscription(uid, token, FIREBASE_PROJECT_ID);
          changed = false;
          break;
        }
        console.error(`Push failed for ${uid}:`, e.message);
      }
    }

    if (changed) {
      updates.push(updateReminders(uid, reminders, token, FIREBASE_PROJECT_ID));
    }
  }

  await Promise.allSettled(updates);
  return { statusCode: 200, body: 'ok' };
};

function isInWindow(currentHHMM, targetHHMM) {
  const [ch, cm] = currentHHMM.split(':').map(Number);
  const [th, tm] = targetHHMM.split(':').map(Number);
  const currentMins = ch * 60 + cm;
  const targetMins = th * 60 + tm;
  return currentMins >= targetMins && currentMins < targetMins + 15;
}

async function getAllUsersWithSubscriptions(token, projectId) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Firestore list error ${res.status}`);
  const data = await res.json();
  if (!data.documents) return [];

  return data.documents
    .map(doc => {
      const uid = doc.name.split('/').pop();
      const fields = doc.fields || {};
      if (!fields.pushSubscription?.mapValue?.fields) return null;
      const ps = fromFirestoreFields(fields.pushSubscription.mapValue.fields);
      return { uid, pushSubscription: ps };
    })
    .filter(Boolean);
}

async function updateReminders(uid, reminders, token, projectId) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=pushSubscription.reminders`;
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      fields: {
        pushSubscription: { mapValue: { fields: {
          reminders: { arrayValue: { values: reminders.map(r => ({ mapValue: { fields: toFirestoreFields(r) } })) } },
        }}},
      },
    }),
  });
}

async function deleteSubscription(uid, token, projectId) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=pushSubscription`;
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: { pushSubscription: { nullValue: null } } }),
  });
}

async function getServiceAccountToken() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const sig = await signJWT(`${header}.${payload}`, sa.private_key);
  const jwt = `${header}.${payload}.${sig}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get service account token');
  return data.access_token;
}

function b64url(str) { return Buffer.from(str).toString('base64url'); }

async function signJWT(input, pemKey) {
  const crypto = require('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(input);
  return sign.sign(pemKey, 'base64url');
}

function fromFirestoreFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) {
    if ('stringValue' in v) obj[k] = v.stringValue;
    else if ('integerValue' in v) obj[k] = Number(v.integerValue);
    else if ('booleanValue' in v) obj[k] = v.booleanValue;
    else if ('nullValue' in v) obj[k] = null;
    else if ('mapValue' in v) obj[k] = fromFirestoreFields(v.mapValue.fields || {});
    else if ('arrayValue' in v) obj[k] = (v.arrayValue.values || []).map(item =>
      item.mapValue ? fromFirestoreFields(item.mapValue.fields || {}) :
      item.stringValue ?? item.integerValue ?? item.nullValue ?? null
    );
  }
  return obj;
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) fields[k] = { nullValue: null };
    else if (typeof v === 'string') fields[k] = { stringValue: v };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (typeof v === 'number') fields[k] = { integerValue: v };
    else if (Array.isArray(v)) fields[k] = { arrayValue: { values: v.map(item =>
      typeof item === 'object' ? { mapValue: { fields: toFirestoreFields(item) } }
      : typeof item === 'string' ? { stringValue: item } : { nullValue: null }
    )}};
    else if (typeof v === 'object') fields[k] = { mapValue: { fields: toFirestoreFields(v) } };
  }
  return fields;
}
```

- [ ] **Step 2: Commit**

```bash
git add netlify/functions/notify.js
git commit -m "feat: add notify scheduled function — cron push delivery every 15min"
```

---

## Task 6: Update sw.js — push event handler

**Files:**
- Modify: `sw.js`

- [ ] **Step 1: Add push and notificationclick handlers to sw.js**

Append to end of `sw.js`:

```js
self.addEventListener('push', e => {
  let data = { title: 'LifeMog', body: '🍽 Time to log your meals!', icon: '/icon-192.png', url: '/' };
  try { if (e.data) data = { ...data, ...JSON.parse(e.data.text()) }; } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: '/icon-192.png',
      data: { url: data.url },
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
```

- [ ] **Step 2: Commit**

```bash
git add sw.js
git commit -m "feat: add push and notificationclick handlers to service worker"
```

---

## Task 7: Settings UI — reminders section

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add CSS for reminder UI**

Find the existing `.btn-save` CSS block and add after it:

```css
.reminder-row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.reminder-row input[type="time"]{flex:0 0 auto;width:110px;background:var(--card);border:1px solid var(--border);border-radius:8px;color:var(--fg);padding:6px 8px;font-size:13px}
.reminder-row input[type="text"]{flex:1;background:var(--card);border:1px solid var(--border);border-radius:8px;color:var(--fg);padding:6px 8px;font-size:13px}
.reminder-row .rm-del{background:none;border:none;color:var(--dim);font-size:18px;cursor:pointer;padding:0 4px;line-height:1}
.reminder-row .rm-del:hover{color:#ff6b6b}
#addReminderBtn{background:none;border:1px dashed var(--border);border-radius:8px;color:var(--mid);font-size:12px;padding:7px 12px;cursor:pointer;width:100%;margin-top:4px}
#addReminderBtn:hover{border-color:var(--lime);color:var(--lime)}
.notif-toggle-row{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.notif-toggle-row label{font-size:13px;color:var(--mid);cursor:pointer}
```

- [ ] **Step 2: Add reminders HTML section to Settings panel**

Find in `index.html`:
```html
        <button class="btn-save" onclick="saveSettings()">Save Settings</button>
```

Add before it:

```html
        <div class="settings-group" id="notifGroup">
          <div class="sg-title">Reminders</div>
          <div class="sg-row">
            <div class="notif-toggle-row">
              <input type="checkbox" id="notifToggle" onchange="onNotifToggle(this)">
              <label for="notifToggle">Daily meal reminders</label>
            </div>
            <div id="reminderList" style="display:none"></div>
            <button id="addReminderBtn" onclick="addReminder()" style="display:none">+ Add reminder</button>
          </div>
        </div>
```

- [ ] **Step 3: Add JS — state, render, subscribe logic**

Find the `renderSettings()` function and add this block of JS **before** it:

```js
// ════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS
// ════════════════════════════════════════════════════════════
const VAPID_PUBLIC_KEY = ''; // filled at deploy time via env — see Task 7 Step 4

let G_reminders = []; // local copy while editing
let G_notifEnabled = false;
let _reminderSaveTimer = null;

function renderReminderList() {
  const list = document.getElementById('reminderList');
  const addBtn = document.getElementById('addReminderBtn');
  if (!G_notifEnabled) {
    list.style.display = 'none';
    addBtn.style.display = 'none';
    return;
  }
  list.style.display = 'block';
  addBtn.style.display = 'block';
  list.innerHTML = G_reminders.map((r, i) => `
    <div class="reminder-row">
      <input type="time" value="${esc(r.time)}" onchange="updateReminder(${i},'time',this.value)" aria-label="Reminder time">
      <input type="text" value="${esc(r.label)}" placeholder="e.g. Breakfast" maxlength="50"
        oninput="updateReminder(${i},'label',this.value)" aria-label="Reminder label">
      <button class="rm-del" onclick="removeReminder(${i})" aria-label="Remove reminder">×</button>
    </div>
  `).join('');
}

function addReminder() {
  G_reminders.push({ id: 'r_' + Math.random().toString(36).slice(2, 9), time: '10:00', label: '', lastNotified: null });
  renderReminderList();
  scheduleReminderSave();
}

function removeReminder(idx) {
  if (G_reminders.length <= 1) { showToast('Need at least one reminder', 'error'); return; }
  G_reminders.splice(idx, 1);
  renderReminderList();
  scheduleReminderSave();
}

function updateReminder(idx, key, val) {
  G_reminders[idx][key] = val;
  scheduleReminderSave();
}

function scheduleReminderSave() {
  clearTimeout(_reminderSaveTimer);
  _reminderSaveTimer = setTimeout(saveReminders, 800);
}

async function saveReminders() {
  if (!G_notifEnabled || !G.user) return;
  const idToken = await firebase.auth().currentUser?.getIdToken();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  try {
    const res = await fetch('/.netlify/functions/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, subscription: sub.toJSON(), timezone, reminders: G_reminders }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
  } catch (e) {
    showToast('Failed to save reminders: ' + e.message, 'error');
  }
}

async function onNotifToggle(checkbox) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    showToast('Push notifications not supported in this browser', 'error');
    checkbox.checked = false;
    return;
  }
  if (checkbox.checked) {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      showToast('Enable notifications in browser settings', 'error');
      checkbox.checked = false;
      return;
    }
    await enableNotifications();
  } else {
    await disableNotifications();
  }
}

async function enableNotifications() {
  if (!VAPID_PUBLIC_KEY) { showToast('Push not configured (missing VAPID key)', 'error'); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    if (!G_reminders.length) {
      G_reminders = [{ id: 'r_' + Math.random().toString(36).slice(2, 9), time: '10:00', label: '', lastNotified: null }];
    }
    G_notifEnabled = true;
    document.getElementById('notifToggle').checked = true;
    renderReminderList();
    await saveReminders();
  } catch (e) {
    showToast('Failed to enable notifications: ' + e.message, 'error');
    document.getElementById('notifToggle').checked = false;
  }
}

async function disableNotifications() {
  G_notifEnabled = false;
  renderReminderList();
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
    const idToken = await firebase.auth().currentUser?.getIdToken();
    await fetch('/.netlify/functions/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
  } catch (e) {
    showToast('Failed to disable notifications: ' + e.message, 'error');
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function loadNotifState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    document.getElementById('notifGroup')?.remove();
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  G_notifEnabled = !!sub && Notification.permission === 'granted';
  // Load reminders from Firestore user doc (already in G.settings or fetch separately)
  const savedReminders = G.pushReminders || [];
  G_reminders = savedReminders.length ? savedReminders : [];
  document.getElementById('notifToggle').checked = G_notifEnabled;
  renderReminderList();
}
```

- [ ] **Step 4: Set VAPID_PUBLIC_KEY inline**

Replace `const VAPID_PUBLIC_KEY = '';` with the actual public key generated in Task 1:

```js
const VAPID_PUBLIC_KEY = 'BYourActualPublicKeyHere...';
```

- [ ] **Step 5: Load pushReminders from Firestore in loadUserData**

Find in `index.html` where `G.settings` is populated from Firestore (around the `loadUserData` function). Add:

```js
G.pushReminders = d.pushSubscription?.reminders || [];
```

- [ ] **Step 6: Call loadNotifState in renderSettings**

Find `function renderSettings()` and add at the end:

```js
loadNotifState();
```

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: push notification settings UI — toggle, reminder list, add/remove/edit"
```

---

## Task 8: Wire up and deploy

- [ ] **Step 1: Push to GitHub to trigger auto-deploy**

```bash
git push
```

- [ ] **Step 2: Verify env vars set in Netlify dashboard**

Confirm all 5 are present:
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_EMAIL`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_SERVICE_ACCOUNT`

- [ ] **Step 3: Verify notify function appears as scheduled**

Netlify dashboard → Functions → `notify` should show schedule `*/15 * * * *`.

- [ ] **Step 4: Test end-to-end**

1. Open coolforthesummer.netlify.app as PWA (Add to Home Screen if not already)
2. Go to Settings → enable "Daily reminders" → grant permission
3. Set a reminder time ~2 minutes from now
4. Wait for next 15-min cron tick (check Netlify Functions logs)
5. Notification should appear on device even with app closed

- [ ] **Step 5: Verify 410 cleanup**

In Netlify Functions logs after a send, confirm no errors. If subscription is stale, log should show deletion.
