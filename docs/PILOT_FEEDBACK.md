# Pilot feedback

Use **Settings -> Support & Pilot -> Report Feedback** (SV only). It builds a plain-text report that you **copy** and paste into GitHub, JIRA or chat.
Nothing is sent by the app, nothing is stored, and no screenshots or files are attached. Version, commit and channel are added for you;
obvious credentials you paste by mistake are masked, but do not paste secrets or confidential report text on purpose.

For a problem with an error message, note the **Error ID** shown with it (or in Support & Pilot -> Last Error ID, or use **Copy Diagnostics**) and paste it in
the report - it lets the owner find the matching server log line.

## Categories

| Category | Use it when | Example |
|---|---|---|
| **Bug** | Something does not do what it says or crashes. | "Finalizing a report shows the Published badge." |
| **UX issue** | It works, but it is confusing, slow to use or easy to misread. | "I could not tell that Copy does not publish." |
| **Missing workflow** | A step of your daily work has no home in the app, or needs a workaround. | "I still keep the staffing note in a spreadsheet." |
| **Performance** | A screen or action is slow or freezes. | "Improvement Analytics takes several seconds on 90 days." |
| **Data inconsistency** | Two places disagree, or a number does not match your records. | "Command Center shows 12 executed, Daily Execution shows 14." |
| **Integration issue** | JIRA or TestRail data, import or connection misbehaves. | "TestRail import found fewer cases than the suite has." |
| **Other** | Anything else (questions, ideas). | |

Pick the closest one; the owner can re-categorize. One report per problem.

## What to write

- **Summary** - one line, what happened (required).
- **Description** - what you did, what you expected, what you saw; roughly how often.
- **Screen** and optional **Project id** - where it happened.
- **Error ID** - if a message showed one.

## What happens next

Reports are reviewed at the weekly pilot review ([PILOT_OPERATIONS.md](PILOT_OPERATIONS.md)). Bugs affecting data, sign-in or the daily report are fixed forward
first; the rest are grouped into the next pilot release.
