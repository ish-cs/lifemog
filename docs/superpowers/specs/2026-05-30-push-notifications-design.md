# Push Notifications — Design Spec
_2026-05-30_

## Goal

Send daily push notifications reminding the user to log meals. Supports multiple reminders per day, each with a custom time and optional label (e.g. "Breakfast", "Lunch", "Dinner"). Works even when the app is closed or hasn't been opened in days.

---

## Architecture

| Component | Role |
|---|---|
| VAPID key pair | Authenticates push messages. Generated once, stored as Netlify env vars. |
| `subscribe.js` | Netlify function. Stores push subscription + timezone + reminders array in Firestore. |
| `unsubscribe.js` | Netlify function. Deletes push subscription from Firestore. |
| `notify.js` | Netlify scheduled function (cron `*/15 * * * *`). Finds reminders in the current 15-min window, sends push, records delivery. |
| `sw.js` | Handles `push` event, shows notification, click opens app. |
| Settings UI | Toggle + reminder list (add/remove/edit time+label). |

---

## Data Model

Under `users/{uid}` in Firestore:

```js
pushSubscription: {
  endpoint: string,
  keys: { p256dh: string, auth: string },
  timezone: string,   // IANA e.g. "America/Los_Angeles"
  reminders: [
    {
      id: string,          // random id e.g. "r_abc123"
      time: string,        // "HH:MM" 24h e.g. "08:00"
      label: string,       // e.g. "Breakfast" (optional, shown in notification body)
      lastNotified: string // "YYYY-MM-DD" in user's local tz, null if never
    }
  ]
}
```

---

## Flow

### Enable

1. User toggles "Daily reminders" on in Settings.
2. Client calls `Notification.requestPermission()`.
   - Denied → toast "Enable notifications in browser settings", toggle reverts.
3. SW subscribes via `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY })`.
4. Client POSTs `{ subscription, timezone, reminders }` + Firebase ID token to `/.netlify/functions/subscribe`.
5. Function verifies token, writes to `users/{uid}.pushSubscription`.

### Disable

1. User toggles off.
2. Client calls `pushManager.getSubscription()?.unsubscribe()`.
3. Client POSTs to `/.netlify/functions/unsubscribe` + Firebase ID token.
4. Function deletes `pushSubscription` from Firestore.

### Add / edit / remove a reminder

- UI changes are saved immediately by re-POSTing full `reminders` array to `/subscribe` (upsert).
- Minimum 1 reminder when notifications are on. Toggle off to remove all.

### Daily delivery (cron)

1. `notify.js` runs every 15min.
2. Queries all user docs where `pushSubscription` exists.
3. For each user:
   - Convert UTC now → user's `timezone`. Extract current `HH:MM` and `YYYY-MM-DD`.
   - For each reminder: if `time` falls in current 15-min window AND `lastNotified !== today` → send push, update `lastNotified` for that reminder.
4. On 410 Gone (expired subscription) → delete `pushSubscription` from Firestore.

---

## Notification Content

- **Title:** `LifeMog`
- **Body:** `🍽 Log your [label]!` — if label empty: `🍽 Time to log your meals!`
- **Icon:** `/icon-192.png`
- **Click:** Opens app (`/`)

---

## Settings UI

```
[✓] Daily reminders

  08:00  Breakfast   [×]
  12:30  Lunch       [×]
  19:00  Dinner      [×]

  [+ Add reminder]
```

- Each row: time picker + label text input (placeholder "e.g. Breakfast") + remove button.
- "+ Add reminder" appends a new row (default time 10:00, empty label).
- Changes auto-save on blur / time change (debounced 800ms).
- If notifications not yet permitted, enabling toggle requests permission first.

---

## Netlify Config

`netlify.toml`:
```toml
[functions."notify"]
  schedule = "*/15 * * * *"
```

New env vars:
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_EMAIL` (e.g. `mailto:ishp@berkeley.edu`)

---

## Error Handling

- Permission denied → toast, toggle stays off.
- SW not supported → hide toggle entirely.
- Push send fail (non-410) → log, skip, retry next tick.
- Push send fail (410) → delete subscription from Firestore.
- Subscribe endpoint fails → toast "Failed to save reminder. Check connection."
