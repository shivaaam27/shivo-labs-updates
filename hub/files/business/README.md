# Shivo Labs Business

Our own ERP. This folder holds its code: plain TypeScript that Node 24 runs directly (type stripping;
no npm packages, no build step). The plan and the rules it follows are in `pos/blueprint/`.

## Folders

| Folder | What it is |
|---|---|
| `core/` | The pure core: data in, rows out, no network, no database (blueprint 00 §B10). |
| `core/contract.ts` | The contract: a `Scenario` (a business story) goes in, a `Result` (stock rows, ledger totals, balances, errors) comes out. |
| `core/money.ts` | Rounding: half to even; 2 decimals for TZS amounts, 3 for quantities, 9 for rates. |
| `core/stock/` | The stock engine: ledger rows in date order, Moving Average and FIFO, transfers, counts, landed cost, cancel, back-dated steps, stock-to-accounts totals. |
| `core/run.ts` | `runScenario(scenario)` → `Result` (system `'shivo'`). |
| `core/meta/` | The definitions of every master (company, stores, units, products, customers, suppliers…): pure data, see `FRAME.md`. |
| `store/` | The database (`node:sqlite`): generic records, validation, users and PINs, CSV import, first-run Tanzania setup, stock movements. |
| `server/api.ts` | The API under `/api/business/` (the hub forwards to it). Contract and shapes: `FRAME.md`. |
| `referee/` | The comparison harness: runs the same scenarios in ERPNext and compares the results (blueprint 00 §B12). |

## Run the tests

From the repo root:

```
node --test "business/**/*.test.ts"
```

(`node --test business/` does not work: Node treats a folder name as a script. Use the pattern.)

## Clean-room rule (legal, strict)

ERPNext is GPL. Our engine must be our own work.

- Build only from our blueprint (`pos/blueprint/`) and the contract. The blueprint describes ERPNext's
  behaviour in our own words.
- Never open, copy or search ERPNext source (e.g. `shivo-pos-test\src\`), and never look up ERPNext code online.
- **ERPNext is only the referee**: `referee/` talks to a test ERPNext over its web API as a black box and
  compares its results with ours. No ERPNext code enters this product.
