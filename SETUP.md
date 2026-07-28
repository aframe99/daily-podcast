# Setup Guide

Everything below is a one-time setup. After this, it just runs itself every
morning.

## 1. Push this to a GitHub repo

On your Mac, in the folder containing these files:

```bash
git init
git add .
git commit -m "Daily podcast setup"
gh repo create daily-podcast --private --source=. --push
```

(If you don't have the `gh` CLI, create a new **private** repo called
`daily-podcast` on github.com first, then:
`git remote add origin https://github.com/aframe99/daily-podcast.git`
`git push -u origin main`)

## 2. Turn on GitHub Pages (hosts the review webpage for free)

In the repo on github.com: **Settings → Pages → Source → Deploy from a
branch → Branch: main, folder: /docs → Save**.

After a minute or two, your review page will be live at:
`https://aframe99.github.io/daily-podcast/`

Save that URL — you'll need it in step 4, and you'll bookmark it on your
phone at the end.

## 3. Get a free Gemini API key (no credit card — genuinely can't be billed)

Go to aistudio.google.com → sign in with any Google account → **Get API
key** → **Create API key**. No billing setup is required or offered at this
step, so there's no way for this to cost anything.

## 4. Sign up for Resend (free email sending)

Go to resend.com → sign up (free, no card needed) → **API Keys** → create
one → copy it.

Note: without verifying your own domain, Resend's test sender
(`onboarding@resend.dev`) can only send to the email address you signed up
with. That's fine here since you're the only recipient.

## 5. Add secrets to your GitHub repo

In the repo: **Settings → Secrets and variables → Actions → New repository
secret**. Add each of these:

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://ziugqehvojxwjizmzzqw.supabase.co` |
| `SUPABASE_KEY` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppdWdxZWh2b2p4d2ppem16enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyMjA2MjMsImV4cCI6MjEwMDc5NjYyM30.RFP-DLVAmkhkbameC01oNA7-H2iuWN15bEUn52gPHdM` |
| `GEMINI_API_KEY` | the free key from step 3 |
| `RESEND_API_KEY` | the key from step 4 |
| `RESEND_FROM_EMAIL` | `onboarding@resend.dev` |
| `USER_EMAIL` | the email address you want the daily podcast sent to |
| `REVIEW_PAGE_URL` | the GitHub Pages URL from step 2 |

## 6. Test it manually before waiting for 7am

In the repo: **Actions tab → Daily Podcast → Run workflow**. Watch it run —
if something's misconfigured, the log will show which step failed.

## 7. Set up the "Flag for Podcast" Shortcut on your iPhone

This is what lets you one-tap a Google News article into tomorrow's picks.

1. Open the **Shortcuts** app → tap **+** (new shortcut)
2. Tap **Add Action**, search for **"Get Contents of URL"**, add it
3. Tap the URL field, enter:
   `https://ziugqehvojxwjizmzzqw.supabase.co/rest/v1/flagged_stories`
4. Tap **Show More** below it, set:
   - **Method**: POST
   - **Headers**: add two —
     `apikey` = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppdWdxZWh2b2p4d2ppem16enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyMjA2MjMsImV4cCI6MjEwMDc5NjYyM30.RFP-DLVAmkhkbameC01oNA7-H2iuWN15bEUn52gPHdM`
     `Content-Type` = `application/json`
   - **Request Body**: choose **JSON**, add one field:
     key `url`, value → tap it, choose **Shortcut Input** (this pipes in
     whatever URL you shared)
5. Tap the shortcut's name at the top, rename it **"Flag for Podcast"**
6. Tap the settings icon (ⓘ) → turn on **"Use with Share Sheet"** → under
   "Share Sheet Types," make sure **URLs** is checked
7. Done. Test it: open Google News, open any article, tap **Share**, scroll
   the icons, tap **Flag for Podcast**. It should run instantly with no
   popup.

If you'd rather it show a quick "Flagged!" confirmation, add a **Show
Notification** action after the "Get Contents of URL" step.

## 8. Bookmark the review page

On your iPhone, open the GitHub Pages URL from step 2 in Safari → tap the
Share button → **Add to Home Screen**. Now it behaves like an app icon.

## Daily life after setup

- Flag articles from Google News whenever you see something good (few
  seconds, any time of day)
- Every morning at ~7am Eastern, everything runs automatically
- You get an email with the podcast link and a review link
- Tap the home-screen bookmark whenever you want to vote on picks or tweak
  your topics/likes/dislikes
