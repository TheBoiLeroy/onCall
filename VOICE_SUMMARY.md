# CareCall — in-home "nurse call" button

## What I understood
A small app that works like a hospital nurse-call button, but for care at home.
The person being cared for (the **patient**) is linked to their **caregiver** by scanning a QR code.
After that, the patient can tap a button and the caregiver's device rings to tell them the patient needs something.
For now it should be a simple web app that can later become a regular phone app.

(The memo calls the caregiver the "client". I used "caregiver" in the app.)

## What I built
A Node.js web app (`server.js` plus plain HTML/JS in `public/`). It has no framework and one dependency, `qrcode`.

- **Start page (`/`)**: first asks **I'm the patient** or **I'm the caregiver**.
  - Caregiver: enter the patient's name and your own name. This creates a private care link.
  - Patient: scan the QR code on the caregiver's screen, or type the 6-letter code shown under it.
- **Caregiver dashboard (`/caregiver/:id`)**
  - Shows a **QR code** for the patient to scan, with a Print button for putting it by the bed or on the fridge.
  - When the patient calls, the whole screen flashes, a loud beep repeats (faster for Emergency and Pain), the phone vibrates and a system notification appears.
  - Buttons: **I'm on my way**, **Seen** and **Done**.
  - A call history and a "patient connected / offline" indicator.
  - **Make a new QR** cancels the old pairing and its code, for a lost phone or a new device.
  - A private link to open the same dashboard on the caregiver's own phone.
- **Medications log (caregiver dashboard)**
  - Save her medication list (name and dose), then log each dose with one tap. Each button shows when that med was last taken.
  - If the same med was logged in the last 3 hours, it asks before logging again, so two caregivers don't double-dose her.
  - **Log a dose** handles a medication not on the list, an earlier time ("she took it at 8") and a note.
  - The log is grouped by day (Today, Yesterday, …) and shows who logged each dose. Mistaken entries can be deleted.
  - Every caregiver sees it update live. The patient's screen doesn't show meds. The last 1000 doses are kept.
- **Patient screen (`/p/:token`, opened by scanning the QR)**
  - One big green **Call [caregiver]** button.
  - Quick buttons: Emergency, Bathroom, Water/food, I'm in pain, Come see me.
  - Big status text that updates live: "Calling Sam…", then "Sam saw your call", then "✅ Sam is on the way!"
  - A cancel button, and a "Sam is listening / Sam's app is closed" indicator.
  - Pressing the same button again rings the caregiver again instead of creating duplicate calls.
- **Real-time updates** use Server-Sent Events and reconnect automatically. Data is saved to `data.json`, so pairings survive a restart.
- **Ready to become an app**: it has a manifest and service worker, so both screens can be added to the home screen and open full-screen with their own icon. On the patient's device, the home-screen icon opens straight to their button. Everything goes through a small JSON API, so a native app (React Native, Capacitor, etc.) could reuse the same backend unchanged.

## How to run it
```bash
npm install
npm start            # http://localhost:4321  (PORT=xxxx npm start to change)
npm test             # automated end-to-end API tests
```
1. On the caregiver's computer or phone, open `http://localhost:4321` and create a care link.
2. Open **Pair the patient's device** and scan the QR code with the patient's phone or tablet. Both devices must be on the same Wi-Fi; the QR code automatically uses this computer's network address.
3. On the caregiver dashboard, tap **Turn on**. Browsers won't play sound or show notifications until you tap something first.
4. Press the button on the patient's device and the caregiver's screen rings.

To use it away from home Wi-Fi, run it on a server or behind a tunnel and set `PUBLIC_URL=https://your-domain npm start` so the QR code points to the public address.

## Testing done
- `npm test` passes (3 tests). It creates a link, fetches the QR, rejects a wrong key, opens the live streams for both sides, has the patient call, checks that the caregiver rings, checks that a second press re-rings the same call, has the caregiver reply "on my way" and checks the patient sees it, marks the call done, checks that a new QR unpairs the old one, checks that the patient can cancel, and checks that the pages load.
- I started the real server and created a demo link. The QR code pointed to the computer's network address (`http://192.168.1.88:4321/...`) and the patient page loaded.
- **Not done:** I had no browser available here, so I never clicked through the screens. The sound, flashing, notifications and layout haven't been seen working; only the server side and the JavaScript syntax were checked. Please try it on two phones.

## Assumptions
- I chose the default port **4321** because port 3000 on this Mac is already used by another app ("Mise").
- There are no user accounts. The caregiver's secret key is saved in that browser, and the QR code itself is what lets the patient's device call. Anyone who has the QR link can ring the caregiver, and **Make a new QR** cancels it.
- A care link can have several caregivers. Each one joins with the invite link or QR code under **Caregivers** on the dashboard and gets their own name and key. Every caregiver's phone rings. When one answers, the others stop ringing and see who's handling it, and the patient sees that person's name ("Alex is on the way"). Any caregiver can remove another or make a new invite link. A care link always keeps at least one caregiver.
- Quick-button choices and wording are my picks and easy to change (`ALERT_TYPES` in `server.js`, `QUICK` in `public/patient.js`).

## Not finished yet
- **Ringing when the caregiver's phone is locked or the app is closed.** Right now the caregiver's dashboard has to stay open (it keeps the screen awake when it can). Fixing this needs Web Push (VAPID keys plus HTTPS), or a native app with push notifications, or an SMS or phone-call fallback through something like Twilio. This is the biggest next step for real use.
- No HTTPS. Push notifications and installing as an app on iPhone work best over HTTPS, which you'd get by deploying it.
- Not for real emergencies: there's no escalation (for example, texting a second contact if nobody answers within 2 minutes) and no 911 integration. Treat it as a convenience tool, not a medical alert device.
- Storage is a single JSON file. Use a real database if it grows to many users.
- A demo care link ("Grandma Rose" / "Sam") from my smoke test is in `data.json`. Delete that file to start fresh.
