# Diagnose a web application

Use the browser's structured diagnostics to identify a reproducible web application failure.

1. Load the inspect tool category when using the built-in planner. Inspect a scoped DOM snapshot and accessibility tree, and capture a screenshot if layout matters.
2. Start diagnostic recording on the authorized tab before reproducing the problem.
3. Read console errors and network request metadata. Separate JavaScript failures, failed requests and visual issues.
4. Read a response body only with advanced access and an authorized same-origin request. Avoid unrelated private data.
5. Inspect performance metrics and the browser's observed timing data when investigating slow behavior. Distinguish model time, transport startup, action time, explicit waits and observation time; browser_step includes these browser-stage timings. Background rendering and network delays require separate measurements.
6. Report the trigger, evidence, likely cause and uncertainty. Browser symptoms alone do not establish a backend root cause.
7. Reset any viewport emulation after testing. Do not change cookies or account security settings as a debugging shortcut.
