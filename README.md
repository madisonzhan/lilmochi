# Crunchling ⋆｡˚ ☁︎ ˚｡⋆

A virtual pet that grows when you finish your bCourses work. Assignments become quests, exams become boss fights, and missed deadlines make a mess.

## How it works
- Static page (`index.html`, `app.js`, `style.css`) plus one serverless function (`api/canvas.js`).
- Students paste a bCourses access token. It's kept in their browser only.
- `api/canvas.js` is a read-only relay to `bcourses.berkeley.edu`, needed because bCourses doesn't allow cross-site API calls from browsers. It allows GET on three endpoints (profile, active courses, planner items), never stores or logs tokens, and sets `Cache-Control: no-store`.
- Checkmarks, custom quests and the pet's name live in `localStorage`. Anything already submitted on bCourses is checked off automatically.

## Run locally
Any static server plus Vercel's dev server works: `npx vercel dev`.

## Deploy
Import the repo in Vercel. No build step, no environment variables.

Not affiliated with UC Berkeley or Instructure.
