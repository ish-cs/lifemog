# LifeMog

Personal health tracker for meals, workouts, and body weight. Mobile-first PWA with AI-powered food logging.

## Features

**Food** — Log meals by describing them in natural language or uploading photos. Tracks calories, protein, carbs, and fat against daily goals.

**Workout** — Log exercises with sets, reps, and weight. Visual muscle map shows which muscles you've trained, color-coded by volume. Navigate day-by-day with swipe or arrows.

**Calendar** — Browse past days to review meals and workouts.

**Body Weight** — Log daily weigh-ins with unit toggle (kg/lbs). History graph and entry management.

**AI Meal Analysis** — Describe a meal or take a photo and get instant macro estimates. Uses Gemini 2.5 Flash (vision) by default, with MiniMax as a fallback.

## Stack

- Vanilla HTML/CSS/JS — no framework, no build step
- Firebase Auth (Google Sign-In) + Firestore (per-user data)
- Netlify Functions — serverless AI proxy
- Gemini 2.5 Flash (primary) / MiniMax Text-01 (fallback)

## Setup

### 1. Clone

```bash
git clone https://github.com/ish-cs/lifemog.git
cd lifemog
```

### 2. Firebase

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Authentication → Google** sign-in
3. Enable **Firestore** (start in production mode)
4. Copy your web app config into `index.html` at the `firebase.initializeApp({...})` call

### 3. Environment variables

Create a `.env` file (for local Netlify dev) or set in Netlify dashboard:

```
GEMINI_API_KEY=your_gemini_api_key
FIREBASE_API_KEY=your_firebase_api_key
```

`FIREBASE_API_KEY` is used server-side to verify ID tokens. `GEMINI_API_KEY` powers AI meal analysis.

MiniMax is optional — users can enter their own key in Settings.

### 4. Deploy

```bash
npm install -g netlify-cli
netlify dev       # local dev
netlify deploy    # preview
netlify deploy --prod
```

## Firestore Rules

All user data is scoped to `users/{uid}` — no user can read or write another's data.

```
match /users/{uid}/{document=**} {
  allow read, write: if request.auth != null && request.auth.uid == uid;
}
```
