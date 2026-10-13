# Shivo Labs Business: when is a phase done

Decided by Shivam (13 Oct 2026) after gaps were found in phases 0-3: **a phase is a promise that everything ERPNext
has in that part is either built or written down with its phase, nothing is left out silently, and nothing on a
screen only looks like it works.** These checks are code, not intentions: they fail on their own.

## The gate (all must pass; the git pre-commit hook runs 1-4)
1. **Every ERPNext document type is classified** (`COVERAGE` in `business/referee/coverage.ts`): built, built in part,
   done by the engine, phase N, after the pilot, or proposed to leave out (Shivam decides those).
2. **Every field people see on every built (or partly built) ERPNext document type has an answer**
   (`business/referee/fields/<ERPNext name>.json`, form in `fieldmap.ts`): `= our_key`, `auto:`, `same:`, `gap:`,
   `phase N:`, `later:` or `skip:`, always with the reason. Child tables we have count too. `= our_key` must name a real
   field of ours (`core/meta`) or a real step input (`store/inputs.ts`, which `inputs.test.ts` checks the store reads).
3. **No field only looks like it works** (`meta.test.ts`): a field of ours that should drive behaviour is read by real
   code, or says `soon` (the form then shows "Not working yet · phase N") or `info` (why reading it is enough).
4. **Money and stock rules match ERPNext** story by story (`business/referee`, 34 stories so far). A deliberate
   difference is written in the story (`oursDiffers`) with the reason; nothing else may differ.
5. **The report is current**: `node business/referee/coverage.ts` writes `pos/blueprint/06-erpnext-coverage.md`; the
   test fails if it is stale.

**Before saying a phase is done:**
- Every field in that phase's part answered `gap:` or `phase <this phase>:` is now built (`=`).
- The browser check of every new screen is done on the test hub (4801).
- The reply to Shivam quotes the gate's numbers (tests, stories, `=`/`gap`/`skip` counts), lists every `skip:` that is
  new, and says plainly what was not tested.

## Starting a phase
1. Read its part of `pos/blueprint/05-system-map.md` and of `06-erpnext-coverage.md`: every document type and field
   marked for this phase is the work list. Nothing in it may be dropped without a `skip:` that Shivam has seen.
2. If ERPNext may have changed, re-read it: `node business/referee/snapshot.ts` (needs the test ERPNext on 8095).
3. When a document type moves to built or partly built, its field map must be complete in the same commit (the test
   makes sure).

## Helper agents
Agents may help with big jobs (classifying fields, writing screens), but **their work is checked by the gate, not
trusted**:
- Give them this file and `business/referee/fieldmap.ts`, and ask for the result as files the tests read (field maps,
  scenarios, tests), never as a summary only.
- After they finish, the main session runs the full gate itself, reads every `=`, `gap:` and `skip:` answer they wrote
  (an `=` claims something works: check it), and fixes problems itself (Shivam's rule: bugs are fixed in the main
  session, not handed back to an agent).

## Commands
```
node --test "business/**/*.test.ts"   # everything, including the gate (no ERPNext needed)
node business/referee/coverage.ts     # report + list of problems
node business/referee/run.ts          # stories vs ERPNext golden files
node business/referee/snapshot.ts     # re-read ERPNext's types and fields (needs the test ERPNext)
```
