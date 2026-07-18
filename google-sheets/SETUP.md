# EvenShift for Google Sheets — Setup Guide

The workhorse edition of EvenShift, running entirely inside your hospital's Google Workspace.
Staff score patients from any computer; the charge clicks **Make Assignment**; the same rules as
the web app decide the board — and every rule is an editable cell.

**No external services. No patient names — room numbers only.**

---

## Setup (5 minutes, one time)

1. Go to **sheets.new** (signed in with your work Google account) and name the spreadsheet,
   e.g. `EvenShift — 10 Green`.
2. In the menu: **Extensions → Apps Script**. Delete the empty `function myFunction() {}`.
3. Copy the entire contents of **`Code.gs`** (the file next to this guide) and paste it in.
4. Click the 💾 **Save** icon, then close the Apps Script tab.
5. Back in the spreadsheet, **reload the page**. A new **EvenShift** menu appears (right of Help).
6. Click **EvenShift → ⚙️ Set up sheets**. Google will ask you to authorize the script —
   it runs as *you*, inside *your* account, touching only *this* spreadsheet. Approve it.
7. Done. Six tabs are created: **Scores · Staff · Floor · Rules · Board · Previous**.

Then share the spreadsheet with your staff (normal Google sharing — their hospital Google
login is the security).

---

## Daily use

**Staff (any computer or the Sheets phone app):**
- Open the **Scores** tab, find your rooms, tick the checkboxes for what each patient needs.
  The **Suggested** acuity calculates itself from the unit's point values.
- Know the number already? Type it straight into **Acuity (hrs)** — a typed number wins over
  the suggestion.
- Add anything else in **Flags** (comma-separated — codes or plain labels both work:
  `iso, dc, cvl` or `Isolation, Discharge, Central line`).
- Expect the patient to be different next shift? Put that number in **Next shift**.

**Charge:**
1. **Staff** tab → tick **On today** for tonight's crew (set Level: RN / Senior / Float / Orienting).
2. **EvenShift → ✨ Make Assignment.** The Nurse column fills in and the **Board** tab shows
   each nurse's rooms, hours, the evenness verdict, and who gives report to whom.
3. Want to hand-move a room? Just edit its **Nurse** cell — if the move breaks a rule
   (two behavioral patients, an orientee on a heavy patient, over a ratio cap), the cell turns
   red with a note explaining why. Google's undo (Ctrl+Z) undoes anything.
4. End of shift: **EvenShift → 🔄 End Shift & Hand Off.** This snapshots who-had-what so the
   next charge's assignment can keep whole groups together.

**Total swap:** if acuity stayed even since last shift, Make Assignment hands each outgoing
nurse's *entire group* to one oncoming nurse — one report per nurse — and says so on the Board.
If the numbers moved too much, it builds a fresh balanced board and says why.

---

## The rules are yours

Everything on the **Rules** tab is a live setting — change a cell, the next assignment obeys:

| Setting | Default | Meaning |
|---|---|---|
| Target evenness | 0.5 hrs | how close nurse workloads must be |
| Nurse ratio | 1:4 | base patients-per-nurse cap |
| Heavy threshold | 5 hrs | what counts as a "heavy" patient |
| Points divisor | 2 | checkbox points ÷ this = acuity hours |
| Total swap first | TRUE | try whole-group handover before shuffling |
| Total swap tolerance | 0.5 hrs | how even the swap must be to accept it |
| Avoid D/C + admit pairing | TRUE | don't give one nurse both |

Below that, the **flag table** sets how each flag balances: `spread` (share out evenly),
`cap` (max N per nurse — behavioral defaults to 1), `ratiocap` (a nurse with this patient takes
at most N patients total — insulin drip defaults to 1:3), or `none`.

The **Floor** tab holds your unit's geography (room → hall → distance from station) so the
engine keeps each nurse's rooms physically close. The **Scores** tab's *points row* (row 2)
holds the value of each checkbox — also editable.

The engine's priority order (same as the web app): **acuity hours ▸ safety caps ▸ hallway
grouping ▸ burden mix ▸ fewest handoff reports.**

---

## For your IT department

- Runs 100% inside your Google Workspace: Google Sheets + Google Apps Script only.
  **No external servers, APIs, or data transfers of any kind.**
- Access control is native Google sharing — hospital accounts, revocable anytime, full
  version/audit history built into Sheets (File → Version history).
- Data stored: room numbers, acuity scores, clinical workload flags, and staff first names.
  **No patient names, no MRNs, no PHI.**
- The script requests authorization only for the spreadsheet it lives in.

## Honest limits

- Menu buttons and live warnings need an internet connection (Google's offline mode lets staff
  *type* offline and sync later, but scripts only run online).
- Phone use works via the Google Sheets app (checkboxes are tappable), but it's a spreadsheet,
  not the web app's card interface.
- This edition covers scoring → assignment → handoff. PCT zones, sitter coverage, break
  requests, Vocera tracking, and manager analytics live in the full web app
  (https://ultrabull.github.io/evenshift/) or in Stage 2 of this Sheet.
