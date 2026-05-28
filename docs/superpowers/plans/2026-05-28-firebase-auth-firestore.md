# Firebase Auth + Firestore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace demo login and localStorage with Firebase Google Auth and Firestore so multiple users can sign in and have data persisted across devices.

**Architecture:** Single `index.html` app; Firebase JS SDK loaded via CDN. Firebase Auth handles Google sign-in and session. Firestore stores per-user settings (on the user doc) and meals (subcollection). Security rules enforce `request.auth.uid == uid` on all reads/writes.

**Tech Stack:** Firebase JS SDK v10 compat build (CDN), Firestore, Firebase Auth, Netlify (deploy unchanged)

**Spec:** `docs/superpowers/specs/2026-05-28-firebase-auth-firestore-design.md`

---

## Firestore Data Shape

```
users/{uid}                           ← settings fields live here
  .calorieGoal  number
  .proteinGoal  number
  .apiKey       string
  .groupId      string

users/{uid}/meals/{mealId}            ← one doc per meal
  .id           string
  .date         string (YYYY-MM-DD)
  .ts           string (ISO)
  .thumb        string (base64 JPEG, resized to ≤800px)
  .foods        array
  .totals       object
  .hiddenNotes  string
  .confidence   number
```

---

## Task 1: Create Firebase Project + Enable Services

**Files:** none (Firebase console / MCP setup)

- [ ] **Step 1: Create project via Firebase MCP**

  Use the `mcp__plugin_firebase_firebase__firebase_create_project` tool:
  - `projectId`: `macrolens-app` (or `macrolens-[random]` if taken)
  - `displayName`: `MacroLens`

- [ ] **Step 2: Create web app and get SDK config**

  Use `mcp__plugin_firebase_firebase__firebase_create_app` with platform `WEB`, then `mcp__plugin_firebase_firebase__firebase_get_sdk_config` to retrieve the config object. Save the output — you'll need it in Task 2.

  Expected shape:
  ```js
  {
    apiKey: "AIza...",
    authDomain: "macrolens-app.firebaseapp.com",
    projectId: "macrolens-app",
    storageBucket: "macrolens-app.appspot.com",
    messagingSenderId: "...",
    appId: "1:...:web:..."
  }
  ```

- [ ] **Step 3: Enable Google Auth provider**

  In Firebase console → Authentication → Sign-in method → Google → Enable.
  Add `macrolens-app.netlify.app` to Authorized domains (Authentication → Settings → Authorized domains).

- [ ] **Step 4: Enable Firestore**

  Firebase console → Firestore Database → Create database → Start in **production mode** → choose region `us-central1`.

---

## Task 2: Add Firebase SDK + Init to index.html

**Files:**
- Modify: `index.html` — add SDK scripts before closing `</head>`, add init block at top of `<script>`

- [ ] **Step 1: Add CDN script tags**

  In `index.html`, immediately before `</head>`, add (SRI hashes protect against CDN compromise):
  ```html
  <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"
          integrity="sha384-sEVIly94UBRLKWdkYoPpSG7GD/e79YHMrxVyZaOk712Ga7+EAw6w1EFi+xBzBdd+"
          crossorigin="anonymous"></script>
  <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js"
          integrity="sha384-EkqK+ezBWJuvO3hfrSx2iVqr3YQbhmnzn8kPhOpBZ+0GMVU5oGSgptwIu8D84HjE"
          crossorigin="anonymous"></script>
  <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js"
          integrity="sha384-M481iNZJtbpypKgvlvZ+78Giq0BsewFLk5r2k+MOcGXlwKCc27DQRZ+WCV/zpmpC"
          crossorigin="anonymous"></script>
  ```

- [ ] **Step 2: Add Firebase init at top of `<script>` block**

  Replace the `// ════ STATE ════` comment with the init block first, then keep STATE below it. Add at the very top of the `<script>` tag (line 598):
  ```js
  // ════════════════════════════════════════════════════════════
  // FIREBASE
  // ════════════════════════════════════════════════════════════
  firebase.initializeApp({
    apiKey: "REPLACE_WITH_YOUR_API_KEY",
    authDomain: "REPLACE_WITH_YOUR_AUTH_DOMAIN",
    projectId: "REPLACE_WITH_YOUR_PROJECT_ID",
    storageBucket: "REPLACE_WITH_YOUR_STORAGE_BUCKET",
    messagingSenderId: "REPLACE_WITH_YOUR_MESSAGING_SENDER_ID",
    appId: "REPLACE_WITH_YOUR_APP_ID"
  });
  const auth = firebase.auth();
  const db = firebase.firestore();
  ```
  Fill in all values from the SDK config retrieved in Task 1 Step 2.

- [ ] **Step 3: Verify no console errors**

  Open `index.html` in a browser (or `python3 -m http.server 8080` and visit `localhost:8080`).
  Expected: no `firebase is not defined` errors in console.

---

## Task 3: Replace Auth

**Files:**
- Modify: `index.html` — replace `signInWithGoogle`, `finishLogin`, `signOut`, and the IIFE session restore block

- [ ] **Step 1: Replace `signInWithGoogle`**

  Find and replace the entire `signInWithGoogle` function (lines ~625–635):
  ```js
  function signInWithGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(e => alert('Sign-in failed: ' + e.message));
  }
  ```

- [ ] **Step 2: Replace `finishLogin` with `onAuthStateChanged`**

  Delete the entire `finishLogin` function and replace with:
  ```js
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      G.user = { id: user.uid, name: user.displayName, email: user.email, picture: user.photoURL };
      await loadUserData();
      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('app').classList.remove('hidden');
      renderAvatar();
      renderSettings();
      renderToday();
      renderCalendar();
    } else {
      G.user = null;
      document.getElementById('loginScreen').style.display = 'flex';
      document.getElementById('app').classList.add('hidden');
    }
  });
  ```

- [ ] **Step 3: Replace `signOut`**

  Delete both the original `signOut` function and its override at the bottom. Add one clean version in the AUTH section:
  ```js
  function signOut() {
    if (!confirm('Sign out?')) return;
    auth.signOut();
  }
  ```

- [ ] **Step 4: Delete the IIFE session restore block**

  Delete everything from `// Auto-restore session` (line ~1142) through the end of the script, including:
  - The `(function() { const saved = localStorage... })();` IIFE
  - The `const _origFinish = finishLogin;` block
  - The `const _origSignOut = signOut;` block

  These are replaced by `onAuthStateChanged` and the new `signOut` above.

- [ ] **Step 5: Verify in browser**

  Visit `localhost:8080`. Click "Continue with Google". Expected: Google sign-in popup appears, on success the app panel shows and the user's name/avatar appears in the top bar.

---

## Task 4: Replace Persistence

**Files:**
- Modify: `index.html` — replace `loadUserData`, `saveLog`, `saveSettingsStore`, and their callers

- [ ] **Step 1: Replace `loadUserData`**

  Find and replace the entire `loadUserData` function:
  ```js
  async function loadUserData() {
    const userRef = db.collection('users').doc(G.user.id);
    const snap = await userRef.get();
    if (snap.exists) {
      const d = snap.data();
      G.settings = {
        calorieGoal: d.calorieGoal || 2000,
        proteinGoal: d.proteinGoal || 150,
        apiKey: d.apiKey || '',
        groupId: d.groupId || '',
      };
    } else {
      G.settings = { calorieGoal: 2000, proteinGoal: 150, apiKey: '', groupId: '' };
      await userRef.set(G.settings);
    }
    const mealsSnap = await userRef.collection('meals').orderBy('ts', 'desc').get();
    G.log = mealsSnap.docs.map(d => d.data());
  }
  ```

- [ ] **Step 2: Replace `saveLog` and `saveSettingsStore` with Firestore helpers**

  Delete `saveLog` and `saveSettingsStore`. Add in their place:
  ```js
  async function saveMeal(meal) {
    await db.collection('users').doc(G.user.id).collection('meals').doc(meal.id).set(meal);
  }

  async function removeMealFromDB(mealId) {
    await db.collection('users').doc(G.user.id).collection('meals').doc(mealId).delete();
  }

  async function saveSettingsStore() {
    await db.collection('users').doc(G.user.id).set(G.settings);
  }
  ```

- [ ] **Step 3: Update `doAnalyze` to call `saveMeal`**

  In `doAnalyze`, find:
  ```js
  G.log.unshift(meal);
  saveLog();
  ```
  Replace with:
  ```js
  G.log.unshift(meal);
  await saveMeal(meal);
  ```

- [ ] **Step 4: Update `saveMealEdit` to call `saveMeal`**

  In `saveMealEdit`, find:
  ```js
  G.log[idx] = G.editingMealData;
  saveLog();
  ```
  Replace with:
  ```js
  G.log[idx] = G.editingMealData;
  await saveMeal(G.editingMealData);
  ```
  Make `saveMealEdit` async: `async function saveMealEdit() {`

- [ ] **Step 5: Update `deleteMeal` to call `removeMealFromDB`**

  In `deleteMeal`, find:
  ```js
  G.log = G.log.filter(m => m.id !== G.editingMealId);
  saveLog();
  ```
  Replace with:
  ```js
  const idToDelete = G.editingMealId;
  G.log = G.log.filter(m => m.id !== idToDelete);
  await removeMealFromDB(idToDelete);
  ```
  Make `deleteMeal` async: `async function deleteMeal() {`

- [ ] **Step 6: Delete `storageKey` function**

  Find and delete:
  ```js
  function storageKey(k) { return `ml_${G.user.id}_${k}`; }
  ```
  It's no longer used.

- [ ] **Step 7: Verify persistence in browser**

  1. Sign in with Google.
  2. Go to Scan tab → type a description → click Analyze.
  3. Confirm meal appears on Today tab.
  4. Hard-refresh the page (`Cmd+Shift+R`).
  5. Expected: meal still appears (loaded from Firestore).
  6. Open Firebase console → Firestore → `users/{your-uid}/meals` → confirm doc exists.

---

## Task 5: Add Image Resize Before Storage

**Files:**
- Modify: `index.html` — add `resizeDataUrl` helper, call it in `capPhoto` and the file picker handler

- [ ] **Step 1: Add `resizeDataUrl` helper**

  Add after the `capPhoto` function:
  ```js
  function resizeDataUrl(dataUrl, maxPx, cb) {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(c.toDataURL('image/jpeg', 0.82));
    };
    img.src = dataUrl;
  }
  ```

- [ ] **Step 2: Use `resizeDataUrl` in `capPhoto`**

  Find:
  ```js
  function capPhoto() {
    const v = document.getElementById('camVideo');
    const c = document.getElementById('capCanvas');
    c.width=v.videoWidth; c.height=v.videoHeight;
    c.getContext('2d').drawImage(v,0,0);
    setSlotPhoto(G.currentSlot, c.toDataURL('image/jpeg',0.85));
    closeCam();
  }
  ```
  Replace with:
  ```js
  function capPhoto() {
    const v = document.getElementById('camVideo');
    const c = document.getElementById('capCanvas');
    c.width=v.videoWidth; c.height=v.videoHeight;
    c.getContext('2d').drawImage(v,0,0);
    resizeDataUrl(c.toDataURL('image/jpeg', 0.92), 800, resized => {
      setSlotPhoto(G.currentSlot, resized);
      closeCam();
    });
  }
  ```

- [ ] **Step 3: Use `resizeDataUrl` in file picker handler**

  In `openCam`, find:
  ```js
  r.onload = e => setSlotPhoto(G.currentSlot, e.target.result);
  ```
  Replace with:
  ```js
  r.onload = e => resizeDataUrl(e.target.result, 800, resized => setSlotPhoto(G.currentSlot, resized));
  ```

---

## Task 6: Deploy Firestore Security Rules

**Files:**
- Create: `firestore.rules`
- Create: `firebase.json`

- [ ] **Step 1: Create `firestore.rules`**

  ```
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /users/{uid}/{document=**} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
    }
  }
  ```

- [ ] **Step 2: Create `firebase.json`**

  ```json
  {
    "firestore": {
      "rules": "firestore.rules"
    }
  }
  ```

- [ ] **Step 3: Deploy rules via Firebase MCP**

  Use `mcp__plugin_firebase_firebase__firebase_deploy` with target `firestore` to deploy the rules.

  Alternatively via CLI: `firebase deploy --only firestore:rules`

- [ ] **Step 4: Verify rules in Firebase console**

  Firebase console → Firestore → Rules → confirm the rule is active and the publish timestamp is recent.

  Test: open a browser private window (unauthenticated), try to fetch `https://firestore.googleapis.com/v1/projects/macrolens-app/databases/(default)/documents/users/` — expected: 403 permission denied.

---

## Task 7: Add API Key Security Note in Settings UI

**Files:**
- Modify: `index.html` — add one line of helper text under the API key input

- [ ] **Step 1: Add note under API key field**

  Find the API key `sg-row` div:
  ```html
  <div class="sg-row">
    <div class="sg-label">API Key</div>
    <input type="password" id="setApiKey" placeholder="Your MiniMax API key">
  </div>
  ```
  Replace with:
  ```html
  <div class="sg-row">
    <div class="sg-label">API Key</div>
    <input type="password" id="setApiKey" placeholder="Your MiniMax API key">
    <div style="font-size:10px;color:var(--mid);margin-top:2px">Stored privately in your account. Only you can access it.</div>
  </div>
  ```

---

## Task 8: Redeploy to Netlify

**Files:** none (deploy existing files)

- [ ] **Step 1: Verify no `localStorage` calls remain**

  ```bash
  grep -n "localStorage" /Users/ish/_Projects/macrolens/index.html
  ```
  Expected: no output. If any remain, fix them before deploying.

- [ ] **Step 2: Deploy**

  ```bash
  netlify deploy --prod --dir=. --site=macrolens-app
  ```

- [ ] **Step 3: Smoke test on production URL**

  1. Visit `https://macrolens-app.netlify.app` in a private browser window.
  2. Click "Continue with Google" — sign-in popup should appear.
  3. Complete sign-in — app should load with user's avatar.
  4. Go to Settings → enter MiniMax API key → Save.
  5. Go to Scan → enter a meal description → Analyze.
  6. Confirm meal appears on Today tab.
  7. Close tab, reopen `https://macrolens-app.netlify.app` — confirm auto sign-in and meal still there.
  8. Have a second person sign in — confirm they see their own empty log, not your data.
