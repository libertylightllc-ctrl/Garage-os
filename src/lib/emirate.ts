// AR 2026-09-03 — E4b, emirate labels + ordering for display.
//
// The DB enum uses canonical FTA spellings (AbuDhabi, UmmAlQuwain,
// etc). Every operator-facing surface (Settings form, VAT summary
// seven-box table, invoice print) reads through this map so the
// FTA spelling stays exact where it matters and human spelling
// shows where it's seen.
//
// EMIRATE_ORDER matches Form 201's row order on the FTA portal —
// keeping the same order on our VAT summary lets an accountant
// scan top-to-bottom without mental re-mapping.

import { Emirate } from "@/generated/prisma/client";

export const EMIRATE_LABEL: Record<Emirate, string> = {
    AbuDhabi: "Abu Dhabi",
    Dubai: "Dubai",
    Sharjah: "Sharjah",
    Ajman: "Ajman",
    UmmAlQuwain: "Umm Al Quwain",
    RasAlKhaimah: "Ras Al Khaimah",
    Fujairah: "Fujairah",
};

/** Form 201 box order: Abu Dhabi → Dubai → Sharjah → Ajman → UAQ → RAK → Fujairah. */
export const EMIRATE_ORDER: Emirate[] = [
    "AbuDhabi",
    "Dubai",
    "Sharjah",
    "Ajman",
    "UmmAlQuwain",
    "RasAlKhaimah",
    "Fujairah",
];

export function isEmirate(v: string): v is Emirate {
    return Object.prototype.hasOwnProperty.call(EMIRATE_LABEL, v);
}
