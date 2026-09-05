/**
 * Customer / Vendor / Item CSV parsers (E7b step 3, AR 2026-09-03).
 *
 * All three share the same shape as parse-openbal:
 *   - Header-aliased column lookup (accept common variants).
 *   - File-scope errors throw (whole file unusable).
 *   - Row-scope errors surface in errors[] with a plain reason.
 *   - Rows in results are typed and ready for the commit path.
 *
 * Header aliases come from QuickBooks' export column names + common
 * shop-typed variants. A shop that manually types headers and gets
 * a slightly-wrong casing shouldn't fail the whole file.
 */

export interface ParsedCustomerRow {
    rowIndex: number;
    name: string;
    phone: string;
    email: string | null;
    address: string | null;
}
export interface ParsedVendorRow {
    rowIndex: number;
    name: string;
    phone: string | null;
    email: string | null;
    trn: string | null;
}
export interface ParsedItemRow {
    rowIndex: number;
    sku: string;
    name: string;
    price: number;
    cost: number;
}
export interface ImportParseError {
    rowIndex: number;
    rowRaw: string;
    reason: string;
}
export interface ParseResult<T> {
    rows: T[];
    errors: ImportParseError[];
}

const CUSTOMER_NAME_HEADERS = ["customer", "customer name", "name"];
const VENDOR_NAME_HEADERS = ["vendor", "vendor name", "supplier", "supplier name", "name"];
const PHONE_HEADERS = ["phone", "phone number", "mobile", "contact"];
const EMAIL_HEADERS = ["email", "email address"];
const ADDRESS_HEADERS = ["address", "billing address"];
const TRN_HEADERS = ["trn", "tax registration number", "vat number"];
const SKU_HEADERS = ["sku", "item code", "part number", "part no"];
const ITEM_NAME_HEADERS = ["item name", "item", "description", "name"];
const PRICE_HEADERS = ["sales price", "price", "unit price"];
const COST_HEADERS = ["purchase cost", "cost", "unit cost"];

function normHeader(h: string): string {
    return h.trim().toLowerCase().replace(/\s+/g, " ");
}
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
function findCol(headers: string[], aliases: string[]): number {
    return headers.findIndex((h) => aliases.includes(h));
}
function parseHeader(csv: string): { lines: string[]; headers: string[] } {
    const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length === 0) throw new Error("CSV is empty.");
    const headers = splitCsvLine(lines[0]).map(normHeader);
    return { lines, headers };
}
function optCell(cells: string[], col: number): string | null {
    if (col < 0) return null;
    const v = (cells[col] ?? "").trim();
    return v === "" ? null : v;
}

export function parseCustomerCsv(csv: string): ParseResult<ParsedCustomerRow> {
    const { lines, headers } = parseHeader(csv);
    const nameCol = findCol(headers, CUSTOMER_NAME_HEADERS);
    const phoneCol = findCol(headers, PHONE_HEADERS);
    const emailCol = findCol(headers, EMAIL_HEADERS);
    const addressCol = findCol(headers, ADDRESS_HEADERS);
    if (nameCol < 0) throw new Error(`Missing "Customer" column. Header was: ${lines[0]}`);
    if (phoneCol < 0) throw new Error(`Missing "Phone" column. Header was: ${lines[0]}`);

    const rows: ParsedCustomerRow[] = [];
    const errors: ImportParseError[] = [];
    for (let i = 1; i < lines.length; i++) {
        const raw = lines[i];
        const cells = splitCsvLine(raw);
        const rowIndex = i;
        const name = (cells[nameCol] ?? "").trim();
        const phone = (cells[phoneCol] ?? "").trim();
        if (name === "") {
            errors.push({ rowIndex, rowRaw: raw, reason: "Missing customer name." });
            continue;
        }
        if (phone === "") {
            errors.push({ rowIndex, rowRaw: raw, reason: "Missing phone number." });
            continue;
        }
        rows.push({
            rowIndex,
            name,
            phone,
            email: optCell(cells, emailCol),
            address: optCell(cells, addressCol),
        });
    }
    return { rows, errors };
}

export function parseVendorCsv(csv: string): ParseResult<ParsedVendorRow> {
    const { lines, headers } = parseHeader(csv);
    const nameCol = findCol(headers, VENDOR_NAME_HEADERS);
    const phoneCol = findCol(headers, PHONE_HEADERS);
    const emailCol = findCol(headers, EMAIL_HEADERS);
    const trnCol = findCol(headers, TRN_HEADERS);
    if (nameCol < 0) throw new Error(`Missing "Vendor" column. Header was: ${lines[0]}`);

    const rows: ParsedVendorRow[] = [];
    const errors: ImportParseError[] = [];
    for (let i = 1; i < lines.length; i++) {
        const raw = lines[i];
        const cells = splitCsvLine(raw);
        const rowIndex = i;
        const name = (cells[nameCol] ?? "").trim();
        if (name === "") {
            errors.push({ rowIndex, rowRaw: raw, reason: "Missing vendor name." });
            continue;
        }
        rows.push({
            rowIndex,
            name,
            phone: optCell(cells, phoneCol),
            email: optCell(cells, emailCol),
            trn: optCell(cells, trnCol),
        });
    }
    return { rows, errors };
}

export function parseItemCsv(csv: string): ParseResult<ParsedItemRow> {
    const { lines, headers } = parseHeader(csv);
    const skuCol = findCol(headers, SKU_HEADERS);
    const nameCol = findCol(headers, ITEM_NAME_HEADERS);
    const priceCol = findCol(headers, PRICE_HEADERS);
    const costCol = findCol(headers, COST_HEADERS);
    if (skuCol < 0) throw new Error(`Missing "SKU" column. Header was: ${lines[0]}`);
    if (nameCol < 0) throw new Error(`Missing "Item Name" column. Header was: ${lines[0]}`);

    const rows: ParsedItemRow[] = [];
    const errors: ImportParseError[] = [];
    for (let i = 1; i < lines.length; i++) {
        const raw = lines[i];
        const cells = splitCsvLine(raw);
        const rowIndex = i;
        const sku = (cells[skuCol] ?? "").trim();
        const name = (cells[nameCol] ?? "").trim();
        const priceRaw = (cells[priceCol] ?? "").trim().replace(/,/g, "");
        const costRaw = (cells[costCol] ?? "").trim().replace(/,/g, "");
        if (sku === "") {
            errors.push({ rowIndex, rowRaw: raw, reason: "Missing SKU." });
            continue;
        }
        if (name === "") {
            errors.push({ rowIndex, rowRaw: raw, reason: "Missing item name." });
            continue;
        }
        const price = priceRaw === "" ? 0 : Number(priceRaw);
        const cost = costRaw === "" ? 0 : Number(costRaw);
        if (!Number.isFinite(price) || price < 0) {
            errors.push({ rowIndex, rowRaw: raw, reason: `Price "${priceRaw}" is not a valid amount.` });
            continue;
        }
        if (!Number.isFinite(cost) || cost < 0) {
            errors.push({ rowIndex, rowRaw: raw, reason: `Cost "${costRaw}" is not a valid amount.` });
            continue;
        }
        rows.push({
            rowIndex,
            sku,
            name,
            price: Math.round(price * 100) / 100,
            cost: Math.round(cost * 100) / 100,
        });
    }
    return { rows, errors };
}
