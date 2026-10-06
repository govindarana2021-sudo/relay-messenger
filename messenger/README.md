# Relay Messenger

Real-time messenger built with Node.js and WebSockets.

## Run
    npm install
    npm start
Open http://localhost:3000 in two browsers (or two devices on the same network
via http://YOUR-LAN-IP:3000), pick different usernames, and chat.

## Files
- server.js          WebSocket server, static hosting, JSON-file message storage
- public/index.html  The client UI

## Notes
- Usernames have no passwords. Add authentication before real use.
- History is stored in data.json. Swap in SQLite or Postgres for production.
- Deploy to Render, Railway, or Fly.io (set PORT; use HTTPS so the client uses wss://).

## Hosting online
See DEPLOY.md for step-by-step Render + TURN instructions. Optional environment variables:
TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL (served to browsers at /ice-config).

## Different devices on different networks (from your own PC)
Double-click start-online.bat (installs the tunnel tool on first run), then open the
https://....trycloudflare.com link it prints on every device. For video on strict networks,
fill in turn-settings.example.bat and rename it to turn-settings.bat.
