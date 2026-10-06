# Put Relay online (works across different Wi-Fi networks)

Free accounts needed: GitHub, Render, and (for video on strict networks) Metered.

## 1. Upload the project to GitHub
1. Sign in at https://github.com, click **+ > New repository**, name it `relay-messenger`, keep it Public, click **Create repository**.
2. Click **uploading an existing file**. Unzip the project first, then drag in `server.js`, `package.json`, `render.yaml`, `.gitignore`, `README.md`
   and the whole `public` folder (drag the folder itself so it keeps `public/index.html`).
3. Click **Commit changes**.

## 2. Get free TURN credentials (makes video calls work on mobile/office networks)
1. Sign up at https://www.metered.ca and create an app (Free plan).
2. In the dashboard open **TURN Server** and create a credential. Note the username, the password (credential) and the server URLs.
3. Your URLs will look like (copy the exact ones from your dashboard):
   `turn:global.relay.metered.ca:80,turn:global.relay.metered.ca:80?transport=tcp,turn:global.relay.metered.ca:443,turns:global.relay.metered.ca:443?transport=tcp`

## 3. Deploy on Render
1. Sign in at https://render.com with GitHub.
2. **New + > Web Service**, pick your `relay-messenger` repo.
3. Settings: Runtime **Node**, Build command `npm install`, Start command `npm start`, Instance type **Free**.
4. Under **Environment**, add:
   - `TURN_URLS`        the comma-separated URLs from step 2
   - `TURN_USERNAME`    your Metered username
   - `TURN_CREDENTIAL`  your Metered password
   (Skip these three for a first test; calls will use STUN only.)
5. Click **Create Web Service**. After a few minutes you get a link like `https://relay-messenger-xxxx.onrender.com`.

## 4. Use it
Open that link on any device on any network (it is HTTPS, so Safari and Chrome allow the camera).
Pick different usernames and chat or press **Video call**.

## Good to know
- Render free plan sleeps after ~15 min idle; the first visit afterwards takes about a minute to wake.
- Free hosting has no permanent disk, so `data.json` (accounts, chat history) and the `uploads` folder (profile pictures, photos) reset when the app restarts or redeploys. On a paid Render plan attach a Disk and set the env var `DATA_DIR` to its mount path to keep everything.
  For permanent history, move storage to a database (e.g. Render Postgres) - ask and I can add it.
- Anyone with the link can create an account with an unused username, so share the link only with people you trust.
- Check TURN: open `https://YOUR-APP/ice-config` - you should see a second entry with your TURN urls.
