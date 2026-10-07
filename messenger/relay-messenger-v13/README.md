# Relay Messenger (v13: all features merged)

Real-time messenger built with Node.js and WebSockets. This build combines the
accounts/profile line (v7) with the friends/attachments/stories/admin line (v4 to v12).

## Run
    npm install
    npm start
Open http://localhost:3000 in two browsers (or two devices on the same network via
http://YOUR-LAN-IP:3000), create two accounts, add each other as friends and chat.

## Files
- server.js          WebSocket server, accounts, static hosting, JSON-file storage
- public/index.html  The client UI
- public/sw.js       Service worker for call notifications
- DEPLOY.md          Render + TURN + push setup

## Feature list
**Accounts and profiles**
- Create account / log in with a password (hashed with scrypt, never stored in plain text).
- Stay signed in on a device with a session token; changing your password signs out other devices.
- One live session per account: signing in somewhere else signs the old tab out.
- Profile photo, display name, and "About"; friends see them everywhere.
- Light / dark / auto theme. Failed-login lockout and signup rate limiting.
- Accounts made before passwords existed (v4-v12 data) keep working: on first login you choose a
  password and the account is yours. Do this yourself right after upgrading, especially for the admin name.

**Messaging**
- Friend requests (accept / decline / cancel / remove). Only friends can message or call each other.
- Unread badges, "typing..." indicator, Sent / Seen receipts, online status and "last seen".
- Search chats, date separators, emoji picker, mobile layout, delete your own messages.
- Photos, videos and files via the paperclip button (max 25 MB, MAX_UPLOAD_MB to change). Only the
  two people in a chat can open a file; risky types are always served as downloads.

**Stories**: post a photo, video or text story from your profile; friends see it for 24 hours
(STORY_TTL_HOURS to change) and a ring appears on your avatar.

**Video calls**
- WebRTC calls between friends (optional TURN via env vars for strict networks).
- Auto-answer: a global "auto-answer all friends" switch (off by default), plus per-friend
  auto-answer that turns on after you accept a friend's call once (change it from their profile or the call screen).
- Call notifications when Relay is closed (web push); tap the notification to answer.
- "Allow camera & mic" helper and permission status in your profile.

**Admin (optional)**: set ADMIN_USERNAME. That account gets a dashboard with users, open reports,
active calls and live broadcasts, plus kick / ban and delete-any-message. The admin can only call
someone without a prompt if that person opts in (Profile, "Allow the admin to call me anytime"),
and can only watch a camera that the person chose to broadcast. Anyone can report a user or message.

## Usernames
New usernames: letters and numbers only, 1 to 20 characters (case-insensitive unique). Older accounts
with dots or underscores can still log in.

## Environment variables
| Variable | Purpose |
| --- | --- |
| PORT | Port to listen on (default 3000) |
| ADMIN_USERNAME | The single admin account. Create (or claim) that account yourself first. |
| DATA_DIR | Where data.json, uploads and vapid.json live (point at a persistent disk) |
| TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL | TURN server for video on strict networks |
| VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT | Stable push keys (`npx web-push generate-vapid-keys`) |
| MAX_UPLOAD_MB, STORY_TTL_HOURS | Upload limit and story lifetime |

## Notes
- History is stored in data.json. Swap in SQLite or Postgres for production.
- Needs HTTPS for camera and notifications (localhost is fine for testing). On iPhone, add Relay to
  the Home Screen first (iOS 16.4+).
- Free hosting has no permanent disk: accounts, messages and uploads reset on restart unless DATA_DIR is on a disk.
- Different networks from your own PC: double-click start-online.bat and open the trycloudflare.com link.
