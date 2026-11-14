# Spotlight Quiz

A live party quiz you play together on your phones. This folder is the whole website: the game page plus a small server that runs the multiplayer.

## Put it online (free, about 10 minutes)

You need two free accounts: **GitHub** (stores the files) and **Render** (runs the website).

### 1. Upload the files to GitHub
1. Sign up or log in at https://github.com.
2. Click **+** (top right), then **New repository**. Name it `spotlight-quiz`, leave it Public or choose Private, and click **Create repository**.
3. On the next page click **uploading an existing file**.
4. Drag in everything from this folder: `server.js`, `package.json`, `README.md` and the `public` folder (with `index.html` inside).
5. Click **Commit changes**.

### 2. Run it on Render
1. Sign up at https://render.com using **Sign in with GitHub**.
2. Click **New +**, then **Web Service**, and pick your `spotlight-quiz` repository.
3. Fill in:
   - **Runtime / Language:** Node
   - **Build Command:** leave empty (or `npm install`, which does nothing here)
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
4. Click **Create Web Service**. After a minute or two it shows **Live** and your link, like `https://spotlight-quiz.onrender.com`.

Send that link to your friends. One person taps **Host a party**; everyone else types the 4-letter code (or taps the party in the list) to join.

## Optional extras

- **Fresh questions written by Claude:** on Render open your service, then **Environment**, and add `ANTHROPIC_API_KEY` with a key from https://console.anthropic.com. This also turns on **Match a selfie** in the avatar maker. Without a key, the game uses its built-in bank of about 1,200 questions. Each visitor is limited to 60 AI requests an hour (change with `AI_REQUESTS_PER_HOUR`). API use is billed to your Anthropic account.
- **Your own address** (like `spotlightquiz.com`): buy the domain anywhere, then on Render go to **Settings**, then **Custom Domains**, and follow the steps.

- **Player accounts and lasting leaderboards (Supabase, free):** players can log in with email and password, and leaderboards, accounts and today's questions are saved in a Supabase database so they survive restarts. Setup:
  1. Create a free project at https://supabase.com.
  2. In **SQL Editor**, paste the contents of `supabase-setup.sql` and press **Run**.
  3. In **Authentication > URL Configuration**, set **Site URL** to your game's address (e.g. `https://spotlightquiz.app`) and add it under **Redirect URLs** too.
  4. In **Project Settings > API Keys**, copy the project URL, the publishable (anon) key and the secret (service_role) key.
  5. On Render, under **Environment**, add `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_KEY`. Keep the secret key private: it only goes on Render, never in the page.
  Supabase's built-in email sender only sends a few emails an hour. For a busy game, connect your own email provider under **Authentication > Emails > SMTP Settings**, or turn off **Confirm email** under **Authentication > Sign In / Providers** so new players can log in straight away.

## Good to know

- On Render's free plan the site **goes to sleep after 15 minutes with nobody on it**. The first visit after that takes about a minute to wake up; open it a minute before game night. A paid instance (about $7 a month) stays awake.
- The daily quiz leaderboard is kept in a file on the server. On the free plan it resets whenever the server restarts.
- Anyone with the link can host or join a party. There are no accounts.

## Run it on your own computer

Install Node.js 18 or newer, then in this folder run `node server.js` and open http://localhost:3000. Other devices on the same Wi-Fi can join at `http://<your computer's IP>:3000`.
