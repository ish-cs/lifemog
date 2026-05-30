# Push Notifications — Design Spec
_2026-05-30_

## Goal

Send a daily push notification to remind the user to log their meals. Fires at a user-configured time (default 10:00am) in the user's local timezone. Works even when the app is closed.

---

## Architecture

### Components

| Component | Role |
|---|---|
| VAPID key pair | Authenticates push messages. Generated once, stored as Netlify env vars. |
| `subscribe.js` | Netlify function. Stores push subscription + timezone + reminderTime in Firestore. |
| `unsubscribe.js` | Netlify function. Deletes push subscription from Firestore. |
| `notify.js` | Netlify scheduled function (cron every 15min). Finds users in their reminder window, sends push, records lastNotified. |
| `sw.js` | Handles `push` event, shows notification, handles click → open app. |
| Settings UI | Toggle + time picker. Calls subscribe/unsubscribe endpoints. |

---

## Data Model

Under `users/{uid}` in Firestore:

```
pushSubscription: {
  endpoint: string,
  keys: { p256dh: string, auth: string },
  timezone: string,          // IANA e.g. "America/Los_Angeles"
  reminderTime: string,      // "HH:MM" 24h, e.g. "10:00"
  lastNotified: string|null  // "YYYY-MM-DD" in user's local tz
}
```

No separate collection — stored on the user doc to avoid cross-collection queries.

---

## Flow

### Enable

1. User toggles "Daily reminder" on in Settings, picks time (default 10:00).
2. Client calls `Notification.requestPermission()`.
3. SW subscribes via `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY })`.
4. Client POSTs `{ subscription, timezone, reminderTime }` + Firebase ID token to `/.netlify/functions/subscribe`.
5. Function verifies token, writes to Firestore.

### Disable

1. User toggles off.
2. Client calls `pushManager.getSubscription()` → `.unsubscribe()`.
3. Client POSTs to `/.netlify/functions/unsubscribe` + Firebase ID token.
4. Function deletes `pushSubscription` field from Firestore.

### Daily delivery

1. `notify.js` runs every 15min via Netlify scheduled cron.
2. Queries all user docs where `pushSubscription` exists.
3. For each user, converts UTC now to their `timezone`. Extracts `HH:MM`.
4. If local `HH:MM` matches `reminderTime` within the 15-min window AND `lastNotified !== today` (in their tz): sends push, updates `lastNotified`.
5. On expired/invalid subscription (410 Gone): deletes `pushSubscription` from Firestore.

---

## Notification Content

- **Title:** `LifeMog`
- **Body:** `🍽 Time to log your meals!`
- **Icon:** `/icon-192.png`
- **Click action:** Opens app to `/` (food tab)

---

## Settings UI

In the Settings panel, below weight unit:

```
[ ] Daily reminder
    10 : 00 AM   [time picker, shown when toggle is on]
```

- Toggle: enables/disables. Requests permission on first enable.
- Time picker: `<input type="time">`, 24h internally, displays in user's locale format.
- If permission denied: show toast "Enable notifications in browser settings", toggle reverts.
- On time change: re-POSTs to `/subscribe` with updated `reminderTime` (upsert).

---

## Netlify Config

In `netlify.toml`:

```toml
[functions."notify"]
  schedule = "*/15 * * * *"
```

New env vars required:
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_EMAIL` (e.g. `mailto:ishp@berkeley.edu`)

---

## Error Handling

- Permission denied → toast, toggle stays off.
- SW not supported → hide toggle entirely.
- Push send fails (non-410) → log error, skip user, retry next cron tick.
- Push send fails (410 Gone = subscription expired) → delete from Firestore.
- Firestore write fails in subscribe → return 500, client shows toast.

---

## Out of Scope

- Per-meal-type reminders
- Snooze
- Multiple reminders per day
- Android/iOS native app notifications
