# Railway Seat Watch

## Install

1. Open `chrome://extensions` and enable Developer mode.
2. Select **Load unpacked** and choose this `extension` folder.
3. Open [D-Ticket](https://dticket.railway.co.th/DTicketPublicWeb/home/Home), sign in, and refresh the page.
4. Click **Seat dashboard** or the extension's toolbar button.

After updating, reload the extension and refresh D-Ticket.

## Check availability

Choose stations, dates, and travel classes, then click **Check now**. Click a cell in the matrix to see coaches, seat counts, and fares. Stations and dates start empty. All classes start checked. Your settings restore on the next launch.

Changing dates checks missing or expired results automatically. **Check now** refreshes seat counts. Choose a cadence of 5, 10, or 15 minutes for automatic checks. Keep Chrome, the railway tab, and the dashboard open with a valid session.

**Seat alerts** notify you when selected trains reach your minimum seat count. Allow browser notifications in your operating system. **Availability history** records changed low counts of 1–5 seats. Earlier counts may no longer be available.

## Open a booking

In **Booking setup**, add 1–4 passengers and choose whether to fill their details automatically or on D-Ticket. Clicking a coach checks its seats again before opening a booking tab. Autofill stops at the passenger forms for your review. Complete any login or CAPTCHA D-Ticket requires.

**Prefer available lower berths in sleepers** starts checked. Uncheck it to keep D-Ticket's assigned seats. Groups keep their assigned carriage. If no suitable lower berth is available, the assigned seat stays selected.

Availability checks do not reserve seats. Opening a booking may temporarily assign seats or create an order. Counts can change before you finish. Review the booking on D-Ticket before paying.

## Watch for seats

1. Load trains, then open **Booking setup**.
2. For a one-way trip, choose one or more departure dates. Select the trains and coaches you would accept, including sold-out coaches. **Quick select** offers sleepers, all coaches, or clearing the selection.
3. For a round trip, choose one departure date and one return date, load return trains, and select coaches on both legs.
4. Add everyone travelling and enable automatic filling for every passenger, then click **Start watch**.

The watch checks immediately and at your chosen cadence. It opens one booking when a selected coach has enough fresh seats for everyone. For round trips, both legs must have seats. One-way watches use the earliest matching date. Seats are never combined across coaches.

The banner shows the watch status. **View choices** opens your selection, **Pause** stops future checks, and **Cancel watch** unlocks the search and passenger controls. After a match, the watch stops and the booking tab fills passenger forms for review. **Book now** checks your choices once.

Keep the dashboard open. After a reload, reopen it to resume checks. Request errors pause the watch. Restore your session and resume. If a booking opens but fails, inspect it before starting another watch.

## Errors and privacy

Rate limits pause requests for at least five minutes, or longer if D-Ticket asks. Other request errors retain previous results. Sign in again if needed, then check or resume.

Settings, results, and passenger details you enter stay in Chrome's local storage, which is not encrypted. Passenger handoffs use temporary storage bound to the booking tab, never booking URLs. Account-holder details stay in D-Ticket's session. The extension does not export login cookies or session tokens and has no server or analytics.

To clear passenger details, cancel the watch, remove extra passengers, and choose **Fill on D-Ticket** for the remaining passenger. Uninstalling clears extension storage.
