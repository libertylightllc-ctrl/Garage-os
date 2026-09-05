/**
 * QuickBooks opening-balance CSV parser (E7b, AR 2026-09-03).
 *
 * Input shape — QuickBooks' standard opening-balance export:
 *
 *   Customer,Balance,As of
 *   Al Falah Motors,5000.00,2026-06-01
 *   Sameer Ahmed,1200,2026-07-15
 *
 * Only the customer-AR direction ships in step 2. Vendor A/P opening
 * balances follow the same shape (Vendor,Balance,As of) and will be
 * added as a sibling kind when a shop needs them.
 *
 * Deliberate limits:
 *   • Simple CSV — comma separator, one-line quoted values with ""
 *     escaping. QuickBooks exports don't need multi-line cell
 *     handling. If a real shop hits a cell with a newline in it, we
 *     add proper CSV parsing then; today it would fail with an
 *     informative row error rather than corrupt data.
 *   • Header row required — the parser reads it to locate columns
 *     rather than assuming order. QB exports headers in the shape
 *     above but variants exist ("Balance Total", "As of Date"); we
 *     accept the canonical names + a few common aliases.
 *   • Balance must be a positive number. Zero rows are dropped
 *     silently (a "zero opening balance" is not an opening balance).
 *     Negative balances (customer credit) will be a separate kind
 *     when they come up; treated as fail today with a clear reason.
 *   • As-of date required — no defaulting. The operator must state
 *     when the balance is as-of; aging clocks from this date.
 */

export interface ParsedOpeningBalanceRow {
    rowIndex: number; // 1-based, excluding the header
    customerName: string;
    balance: number;
    asOfDate: Date;
}

export interface OpeningBalanceParseError {
    rowIndex: number;
    rowRaw: string;
    reason: string;
}

export interface OpeningBalanceParseResult {
    rows: ParsedOpeningBalanceRow[];
    errors: OpeningBalanceParseError[];
}

const CUSTOMER_HEADERS = ["customer", "customer name", "name"];
const BALANCE_HEADERS = ["balance", "balance total", "open balance", "amount"];
const AS_OF_HEADERS = ["as of", "as of date", "date"];

function normHeader(h: string): string {
    return h.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Minimal CSV row split. Handles simple quoted values ("...") with
 *  "" as an escaped quote. No multi-line cell support. */
function splitCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
            if (c === '"') {
                if (line[i + 1] === '"') {
                    cur += '"';
                    i++;
                } else {
                    inQ = false;
                }
            } else {
                cur += c;
            }
        } else if (c === '"') {
            inQ = true;
        } else if (c === ",") {
            out.push(cur);
            cur = "";
        } else {
            cur += c;
        }
    }
    out.push(cur);
    return out;
}

/** Parse a CSV string into typed opening-balance rows. Non-fatal
 *  row-level failures land in `errors` with a plain-wording reason;
 *  callers surface these to the operator via LedgerImportError.
 *  Header issues (missing required column, unrecognised aliases)
 *  throw — the whole file is unusable in that case. */
export function parseOpeningBalanceCsv(csv: string): OpeningBalanceParseResult {
    const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length === 0) throw new Error("CSV is empty.");
    const headerCells = splitCsvLine(lines[0]).map(normHeader);
    const customerCol = headerCells.findIndex((h) => CUSTOMER_HEADERS.includes(h));
    const balanceCol = headerCells.findIndex((h) => BALANCE_HEADERS.includes(h));
    const asOfCol = headerCells.findIndex((h) => AS_OF_HEADERS.includes(h));
    if (customerCol < 0) {
        throw new Error(`Missing "Customer" column. Header was: ${lines[0]}`);
    }
    if (balanceCol < 0) {
        throw new Error(`Missing "Balance" column. Header was: ${lines[0]}`);
    }
    if (asOfCol < 0) {
        throw new Error(`Missing "As of" column. Header was: ${lines[0]}`);
    }

    const rows: ParsedOpeningBalanceRow[] = [];
    const errors: OpeningBalanceParseError[] = [];
    for (let i = 1; i < lines.length; i++) {
        const raw = lines[i];
        const cells = splitCsvLine(raw);
        const rowIndex = i; // 1-based line number, excluding header
        const customerName = (cells[customerCol] ?? "").trim();
        const balanceRaw = (cells[balanceCol] ?? "").trim();
        const asOfRaw = (cells[asOfCol] ?? "").trim();

        if (customerName === "") {
            errors.push({ rowIndex, rowRaw: raw, reason: "Missing customer name." });
            continue;
        }
        if (balanceRaw === "") {
            errors.push({ rowIndex, rowRaw: raw, reason: "Missing balance." });
            continue;
        }
        // QB exports sometimes carry commas as thousands separators.
        const balanceNumRaw = balanceRaw.replace(/,/g, "");
        const balance = Number(balanceNumRaw);
        if (!Number.isFinite(balance)) {
            errors.push({
                rowIndex,
                rowRaw: raw,
                reason: `Balance "${balanceRaw}" is not a number.`,
            });
            continue;
        }
        if (balance <= 0) {
            errors.push({
                rowIndex,
                rowRaw: raw,
                reason:
                    balance === 0
                        ? "Balance is zero — not an opening balance."
                        : `Balance is negative (${balance.toFixed(2)}). Customer-credit imports are not supported yet.`,
            });
            continue;
        }
        if (asOfRaw === "") {
            errors.push({ rowIndex, rowRaw: raw, reason: "Missing as-of date." });
            continue;
        }
        const asOfDate = new Date(asOfRaw);
        if (isNaN(asOfDate.getTime())) {
            errors.push({
                rowIndex,
                rowRaw: raw,
                reason: `As-of date "${asOfRaw}" is not a valid date (expected YYYY-MM-DD).`,
            });
            continue;
        }

        rows.push({
            rowIndex,
            customerName,
            balance: Math.round(balance * 100) / 100,
            asOfDate,
        });
    }

    return { rows, errors };
}
