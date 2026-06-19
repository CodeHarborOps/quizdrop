# QuizDrop v4 — Trivia + Polls, Multi-Select, Unlimited Scale

Live trivia and audience polls for work events and game nights. Players scan a QR code to join on their phones.

## Two modes

**Trivia** — scored multiple-choice questions, live leaderboard, speed + streak bonuses.

**Poll / Survey** — unscored questions for gathering opinions:
- **Multiple choice** — results shown as bars, donut, pie, or dots. Optionally allow players to select more than one option, and toggle results between raw counts and percentages.
- **Word cloud** — players type a word or phrase; common answers appear bigger
- **Open ended** — players type free text; responses stream into a live feed

## What changed from v3
- Added **"Allow multiple selections"** toggle per multiple-choice question (Poll/Survey mode) — players can tap several options before submitting
- Added **"Show results as percentage"** toggle — switches chart numbers between raw counts and %, both live and on the results screen

---

## Deploy to Render

### 1. Push to GitHub
Same as before — upload all files (including the `public` folder contents) to your repo.

### 2. Deploy
1. [render.com](https://render.com) → **New → Blueprint**
2. Connect your repo, click **Apply**
3. Set `APP_URL` in the web service's Environment tab to your Render URL
4. `ANTHROPIC_API_KEY` is no longer needed — you can remove it if it's still set

Render's free tier covers both the web service and Redis (a card on file is required by Render for the Redis free tier, but there's no monthly charge as long as you stay on `plan: free`).

---

## Run locally

```bash
npm install
APP_URL=http://localhost:3000 npm start
```

No Redis needed for local testing — falls back to in-memory automatically.

---

## Scoring (Trivia mode only)
- Base: **500 pts** for a correct answer
- Speed bonus: up to **+500 pts**
- Streak bonus: **+50 pts per consecutive correct answer** (capped at +200)

Poll/Survey mode has no scoring — it's purely for gathering live audience input.
