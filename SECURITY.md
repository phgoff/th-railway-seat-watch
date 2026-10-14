# Report a security issue

Use **Report a vulnerability** in this repository's GitHub **Security** tab when private vulnerability reporting is enabled. If that option is unavailable, open an issue asking the maintainer to enable a private reporting channel. Do not include exploit details or sensitive data in that issue.

A private report should describe the affected version, the steps to reproduce the issue with fictional data, and its impact. Do not send real passenger details, passwords, cookies, or session tokens.

## Data and trust boundaries

The extension runs only on Thai Railway D-Ticket pages. Availability requests use the site's session. It has no server, analytics, or third-party font requests.

Routes, preferences, passenger profiles, booking watches, and availability history use browser-local extension storage. The extension does not encrypt that storage. A booking handoff uses a short-lived browser-session record for the chosen passenger profiles, bound to the destination booking tab. Passenger details do not appear in booking URLs. Autofill necessarily gives the chosen details to D-Ticket's booking page.

The page bridge runs in D-Ticket's JavaScript context. Scripts on that page can observe data entered into its forms. The extension does not protect you from a compromised railway website or browser profile.

To remove saved passenger details, remove extra passengers in **Booking setup**, set the remaining passenger to **Fill on D-Ticket**, and cancel an active watch first. Clear **Availability history** separately. Removing the extension clears its extension storage. The browser demo stores its fictional settings in the site's local storage.

Keep local API captures in ignored `fixtures/local-*.json` files. Review captures and screenshots before sharing them. The demo's trips, coaches, fares, and seat counts are fictional. Its station names come from D-Ticket.
