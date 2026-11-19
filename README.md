# 30 Days Sprint App

Single-file web app (HTML, CSS, JavaScript). No build step.

- Upload `index.html` to the repo root.
- Deploy on Vercel: Framework "Other", no build command, output directory blank.
- Progress is sent to the Make webhook set as `HOOK` near the top of the script in `index.html`.
- To show the live leaderboard from your own data, set `READ` to a second Make webhook that returns a JSON list of rows.
