# EvenShift for Google Sheets — Setup Guide

The full workhorse edition of EvenShift, running entirely inside your hospital's Google
Workspace. Staff score patients and request breaks from any computer; the charge clicks
**Make Assignment**; the same rules as the web app decide the board — and every rule is an
editable cell.

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
7. Done. Eight tabs are created:
   **Scores · Staff · Floor · Rules · Board · Quick hits · History · Previous**

Then share the spreadsheet with your staff (normal Google sharing — their hospital Google
login is the security).

**Upgrading from Stage 1?** Open Extensions → Apps Script, replace everything with the new
`Code.gs`, Save, reload, and run **Set up sheets** again. Your Rules values and Staff list
are kept; a Role column is added to Staff automatically (everyone starts as RN — retag your
PCTs, sitters, and HUCs).

---

## Daily use

**Staff (any computer or the Sheets phone app):**
- **Score:** on the **Scores** tab, find your rooms and tick the checkboxes for what each
  patient needs — the **Suggested** acuity calculates itself. Know the number already? Type it
  in **Acuity (hrs)**; a typed number wins. Extra conditions go in **Flags** (comma-separated,
  codes or plain labels: `iso, dc, cvl` or `Isolation, Discharge, Central line`). A different
  expectation for the oncoming shift goes in **Next shift**.
- **Request a break:** on the **Staff** tab, pick a 30-minute slot in **Break slot**. If the
  slot is full or your break buddy took the same slot, the cell flags immediately with the
  reason. The charge approves by ticking **Break OK**.
- **Read the quick hits:** open the **Quick hits** tab, read the message, tick **Read ✓** next
  to your name — it timestamps itself so the charge knows who's seen it.

**Charge:**
1. **Staff** tab → set each person's **Role** (RN / PCT / Sitter / HUC) once; each shift, tick
   **On today** for the crew. Sitters get their **1:1 Room**. Vocera numbers live here too.
2. **EvenShift → ✨ Make Assignment.** The Nurse column fills in and the **Board** shows:
   nurse blocks (rooms · patients · hours · Vocera), the evenness verdict, the total-swap
   result, who gives report to whom, **PCT zones** (contiguous runs along the floor walk),
   **1:1 sitter coverage** (staggered break windows + who covers), **break buddies**, pending
   **break requests** with over-cap warnings, and the **code blue team**.
3. Hand-move a room by editing its **Nurse** cell — rule violations flag instantly (red cell +
   note). Big acuity edits (±1.5 hrs by default) get an amber "double-check this" flag too.
4. Happy with it? **EvenShift → 📌 Post / unpost.** The Board banner flips from ✏️ DRAFT to
   ✅ POSTED so staff know it's final.
5. Write the handoff message on **Quick hits** — editing it clears everyone's read-checkmarks
   so the next crew re-acknowledges.
6. End of shift: **EvenShift → 🔄 End Shift & Hand Off.** Saves who-had-what to Previous
   (powers next shift's total swap), logs the shift to **History** (census, spread, behavioral
   and heavy counts — chart it with normal Sheets charts), rolls Next-shift scores into
   Acuity, and clears assignments and break requests.

**Total swap:** if acuity stayed even since last shift, Make Assignment hands each outgoing
nurse's *entire group* to one oncoming nurse — one report per nurse — and says so on the Board.

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
| Shift (Day/Night) | Day | sets sitter break windows + the History log |
| Max on break per slot | 2 | break requests above this per slot get flagged |
| Big acuity change | 1.5 hrs | edits that move a score this much get an attention flag |

Below that, the **flag table** sets how each flag balances: `spread` (share out evenly),
`cap` (max N per nurse — behavioral defaults to 1), `ratiocap` (a nurse with this patient takes
at most N patients total — insulin drip defaults to 1:3), or `none`.

The **Floor** tab holds your unit's geography (room → hall → distance from station). The
**Scores** points row (row 2) holds each checkbox's value — also editable.

Engine priority (same as the web app): **acuity hours ▸ safety caps ▸ hallway grouping ▸
burden mix ▸ fewest handoff reports.**

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
- The full web app (https://ultrabull.github.io/evenshift/) remains the richer daily driver:
  tap-to-score cards, per-person views, Vocera return tracking, pulse surveys, manager
  dashboards, printable floor-map sheets.
