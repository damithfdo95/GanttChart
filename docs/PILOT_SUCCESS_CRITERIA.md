# Pilot success criteria

The pilot succeeds if the product **reduces supervisor work without creating new risk**. These are the questions to answer and the evidence to
keep. **No numeric targets are set here** - the owner decides them (suggested prompts are in brackets) before the pilot starts.

| Area | Question | Evidence (from the pilot diary / feedback) | Owner's target |
|---|---|---|---|
| Daily operations | Can the SV understand the current situation from the Command Center without visiting many other screens? | Diary: "Command Center useful?" Yes/No; screens still needed | [e.g. Yes on most days] |
| Reporting | Is Daily Report preparation faster than before? | Diary: report prep time; manual workarounds | [minutes before / after] |
| Execution tracking | Do TestRail / JIRA figures match operational reality? | Data-inconsistency and Integration feedback; spot checks against TestRail | [accepted discrepancies] |
| Staffing | Are Planned / Assigned / Actual distinctions useful? | Diary comments; staffing-related feedback | [useful / confusing] |
| Readiness | Does Ready / At Risk / Blocked help decisions? | Diary: decisions it changed or confirmed; reasons judged wrong | [wrong calls tolerated] |
| Improvement | Do the analytics show patterns the SV acts on? | Weekly review notes | [actions taken] |
| Reliability | No data loss; backup and restore work; shared sync is stable. | Incidents; restore drill result; sync complaints; Error IDs | [zero data loss] |
| Support | Can a problem be diagnosed from the report? | Share of reports with version/commit and Error ID | [most] |

## Not measured

There is no product analytics or telemetry. Usage questions ("is the analytics screen used?") are answered by the SV's diary, not by tracking.

## Pilot diary (daily, 1 minute)

Copy per day into any notes tool:

```
Date:
Command Center useful? Yes / No
Biggest issue:
Daily Report prep time:
Manual workaround:
Missing workflow:
Bug observed (Error ID if shown):
```

## End-of-pilot review

Go through the table, mark each row met / partly / not met with evidence, list the top issues by category, and decide: continue the pilot, widen it, or fix first.
