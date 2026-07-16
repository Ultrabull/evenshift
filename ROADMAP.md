# EvenShift — 5–10 Year Roadmap

> **Guiding principle:** EvenShift's core value is that a charge nurse can balance a floor in
> 30 seconds from a phone. Every item below must protect that simplicity — features that slow
> down the 30-second flow don't ship, no matter how impressive they are.

Today the charge nurse *tells* the app about the floor. In ten years the app should already
know, and the nurse just decides. Each phase removes one layer of typing while keeping the
human in charge of the judgment calls.

---

## Years 0–1 — Earn the right to be trusted

**1. Real security.**
The current charge/manager/HUC codes are a front-desk gate, not a lock — they are lightly
encoded client-side (`pinStore()`) and readable from the page source, and the shared database
key is baked into the file. Before a second hospital touches this:
- Real logins, ideally the hospital's own single sign-on (SSO/SAML).
- Supabase **Row-Level Security** so the database itself refuses writes the user isn't
  entitled to — the page stops being the only guard.
- An audit trail of who changed what, when. Staff names are personal data even though no
  patient data is stored.

**2. Engineering foundation.**
- Split the single-file app (`index.html`, ~6,000 lines) into modules.
- Grow the headless smoke-test harness (DOM stubs + the extracted script) into a real test
  suite that runs in CI before every deploy. The Print-button crash shipped precisely because
  nothing exercised that path automatically.
- Make it an installable PWA with offline mode (service worker) — hospital wifi has dead
  zones; the board must survive them and sync when back.

**3. True multi-unit tenancy.**
The seeds exist (`unitId`, the units picker, House View). Turn them into real tenancy:
one hospital → many units → roles per unit, with per-unit configuration isolated server-side.

## Years 2–4 — Stop retyping what the hospital already knows

**4. EHR integration (the big one).**
Connect to Epic/Cerner via HL7 **FHIR**: census, admissions, discharges, and transfers flow in
automatically. Acuity gets *pre-suggested* from live orders — the app already knows the patient
has a heparin drip, telemetry, and isolation, so scoring becomes "confirm" instead of "enter."
This removes the biggest daily chore and the biggest source of stale data.

**5. Acuity that learns.**
The app already collects `shift_history` and anonymous pulse surveys. Close the loop:
if nurses who were "balanced on paper" consistently report "too heavy" or miss breaks, the
rubric weights self-correct. The next-shift prediction slider becomes a forecast from the
patient's actual trajectory instead of a manual guess.

**6. Predictive staffing.**
With a year of history, warn *before* the shortage: "Mondays in January run 4 admits by 11am —
request the extra RN now, not at 3pm." The staffing-request fax builder grows into a forecast.

**7. Fairness across weeks, not just shifts.**
The manager report already spots "same people always heavy." Make the engine remember it:
whoever carried the heavy load Tuesday gets relief Thursday — an equity ledger that rotates
the burden over time.

## Years 5–10 — From one floor to the whole house

**8. Hospital-wide optimization.**
House View grows from a dashboard into a command center: float nurses allocated across units by
real acuity, and bed placement that considers *which unit can absorb the patient*, not just
where a bed is empty.

**9. Talk to the ecosystem.**
Auto-fill "who's working" from the scheduling system (UKG, ShiftWizard, …); push the final
assignment to Vocera/phones directly instead of retyping device numbers.

**10. A charge-nurse copilot.**
An assistant that speaks the unit's language: "Anna's drowning, fix it" → it proposes the one
swap that helps, explains the trade-off, and remembers the unit's unwritten rules. The cost
engine already scores every trade-off; the copilot gives it a voice.

**11. Prove it saves lives — the real moat.**
Correlate years of balanced-vs-unbalanced shifts with falls, medication errors, missed breaks,
and nurse turnover. If the data shows fair assignments reduce harm and burnout, EvenShift stops
being a convenience tool and becomes evidence-based safety infrastructure — including automated
compliance documentation for ratio-law states such as California.

---

## Priority order already encoded in the engine (keep it)

Acuity-hours balance ▸ safety caps ▸ room grouping (geography) ▸ burden mix ▸ handoff
continuity (total swap first when acuity stays even, otherwise fewest reports as the last
tiebreaker). Future features extend this ladder; they don't reorder it without the unit's
explicit say-so.
