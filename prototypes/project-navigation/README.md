# Throwaway project-navigation prototype

Decision evidence for [How should project navigation and favorites look?](https://github.com/brunoorsolon/forge-desk/issues/159), part of [Project-first browsing and user favorites](https://github.com/brunoorsolon/forge-desk/issues/157). The human selected variant A. The approved interaction contract lives in the ticket resolution, not in this artifact.

Open `index.html` directly in a separate browser profile. Use the floating arrows to compare A (sidebar), B (favorites strip and switcher), and C (project launcher). The `variant` query parameter selects the initial layout. No installation, server, network access, or credentials are needed.

This branch captures the prototype used during the discussion, not a production implementation or a complete simulation of the approved contract. Data is fictional; favorites reset on reload; authentication, persistence, remembered startup, and refresh are absent. Graph and Problems tabs are illustrative. Some final decisions, including reselecting the current scope without clearing its filter, are not simulated. The source-resolution and navigation tickets govern implementation after the normal specification workflow.

Do not merge this evidence branch into the application. The prototype file SHA-256 at capture is `cfb03a367d404f349adb8b35a0aef388d76d65cfb0be48ff97f8713d6d9044bc`.
