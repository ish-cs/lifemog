# MacroLens — Firebase Auth + Firestore Design
**Date:** 2026-05-28

## Goal
Replace demo login and localStorage with real Google OAuth (Firebase Auth) and Firestore, so multiple users can sign in and have their data persisted across devices. Each user stores their own MiniMax API key, accessible only to them.

## Architecture

Single `index.html` app, no build step, no backend. Firebase JS SDK loaded via CDN. Netlify deployment unchanged.

### Firebase Services
| Service | Purpose |
|---------|---------|
| Firebase Auth | Google sign-in popup, session management via `onAuthStateChanged` |
| Firestore | Per-user settings and meal log storage |
| Security Rules | Server-enforced: only `request.auth.uid == uid` can read/write |

## Firestore Data Model

```
users/{uid}/
  settings          → { calorieGoal, proteinGoal, apiKey, groupId }
  meals/{mealId}    → { id, date, ts, thumb, foods[], totals{}, hiddenNotes, confidence }
```

- `settings` is a single document, written on save and read on login.
- `meals` is a subcollection. Each meal is its own document keyed by `id` (timestamp string).
- On first login, if `settings` doc doesn't exist, write defaults: `{ calorieGoal:2000, proteinGoal:150, apiKey:'', groupId:'' }`.

## Security Rules

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

No user can read or write another user's documents.

## Auth Flow

| Before | After |
|--------|-------|
| `prompt()` for name/email | `signInWithPopup(GoogleAuthProvider)` |
| `ml_session` in localStorage | `onAuthStateChanged` listener |
| Manual `signOut()` with confirm | `firebase.auth().signOut()` |

`onAuthStateChanged` drives app state: show login screen when `user == null`, load data and render app when `user != null`.

## Persistence

| Before | After |
|--------|-------|
| `localStorage.setItem(storageKey('log'), ...)` | `setDoc(mealRef, meal)` / `deleteDoc(mealRef)` |
| `localStorage.getItem(storageKey('settings'))` | `getDoc(settingsRef)` on login |
| All `localStorage` calls | Removed entirely |

Firestore SDK caches reads in IndexedDB — app works offline, syncs on reconnect. `onSnapshot` on the meals collection keeps two open sessions in sync automatically.

## Image Sizing

Firestore doc limit is 1MB. Meal thumbnails (base64 JPEG) are resized to max 800px on the longest side before storing, keeping docs safely under limit. Resize happens in a canvas step before `setSlotPhoto`.

## Settings UI

Add note under the API key field:
> "Your key is stored in your private Firestore document. Only you can access it."

## What's Removed

- All `localStorage` / `storageKey()` calls
- `ml_session` key
- Duplicate `signOut` definition (second override)
- `GOOGLE_CLIENT_ID` blank comment block

## Out of Scope

- Shared API key / server-side proxy (revisit if owner wants to subsidize friends)
- Image storage in Firebase Storage (base64 in Firestore is sufficient at 800px)
- Push notifications or real-time collaboration
