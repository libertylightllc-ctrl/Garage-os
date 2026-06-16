// Owner copilot — classifies a natural-language question into one of the Phase-1
// single-garage intents. Pure + testable; the answer is always computed from
// garage-scoped DB queries (owner-metrics), never invented by a model.

export type CopilotIntent =
  | "PROFIT_MONTH"
  | "WHO_OWES"
  | "WEEK_TREND"
  // Slice #7 — copilot upgrade. New intents for the owner's most
  // common 'what's going on?' questions across invoices, ledger, VAT,
  // advances, technicians, and advisors. Same garage-scoped metrics
  // pattern — answers come from prisma queries, never model-invented.
  | "INVOICES_SUMMARY"
  | "VAT_MONTH"
  | "ADVANCES_OUTSTANDING"
  | "TECH_RANKING"
  | "ADVISOR_RANKING"
  | "LEDGER_BALANCE"
  | "UNKNOWN";

export const SAMPLE_QUESTIONS = [
  "Are we up or down this week?",
  "How much profit this month?",
  "Who owes us money?",
  "Invoice summary",
  "How much VAT this month?",
  "Any unpaid advances?",
  "Who's the top technician?",
  "Best advisor by approval rate?",
  "Cash and AR balance?",
];

// Order matters: more specific patterns must come before general ones.
// 'invoice summary' should hit INVOICES_SUMMARY, not WHO_OWES, even
// though 'unpaid' could match both contextually.
export function classifyIntent(question: string): CopilotIntent {
  const q = question.toLowerCase();

  // INVOICES_SUMMARY — natural phrasings the owner reaches for when
  // asking 'how are invoices going?'. Expanded after AR reported that
  // 'invoices so far' fell through to UNKNOWN. WHO_OWES regression
  // ('show me outstanding invoices' must NOT hit here) is preserved
  // because none of these alternatives match 'outstanding invoices' —
  // 'outstanding' isn't in any of the alternative phrases.
  if (
    /invoice.*(summary|total|count|how many|so far|to date|this (month|week|year))/.test(q) ||
    /how many invoices/.test(q) ||
    /invoices? (today|this (month|week|year)|so far|to date)/.test(q) ||
    /^\s*invoices?\s*\??\s*$/.test(q) ||
    /^\s*any invoices/.test(q) ||
    /^\s*show me (all )?invoices?\s*\??\s*$/.test(q) ||
    /الفواتير|عدد الفواتير/.test(q)
  )
    return "INVOICES_SUMMARY";

  // VAT_MONTH
  if (/(vat|tax.*collect|tax.*month|ضريبة|الضريبة|القيمة المضافة)/.test(q))
    return "VAT_MONTH";

  // ADVANCES_OUTSTANDING — pre-invoice deposits not yet migrated.
  if (
    /(advance|deposit|pre-?paid|دفعة مقدمة|دفعات مقدمة|عربون)/.test(q)
  )
    return "ADVANCES_OUTSTANDING";

  // LEDGER_BALANCE — cash / AR position.
  if (
    /(cash position|cash and ar|ar balance|account balance|الرصيد|النقد|الذمم)/.test(
      q,
    )
  )
    return "LEDGER_BALANCE";

  // TECH_RANKING — 'top technician', 'best tech', 'who completed most'.
  if (
    /(top|best|leading|most).{0,20}(tech|technician|mechanic|فني|الفنيين|الفني الأفضل)/.test(
      q,
    )
  )
    return "TECH_RANKING";

  // ADVISOR_RANKING — 'top advisor', 'best advisor', 'highest approval'.
  if (
    /(top|best|leading).{0,20}(advisor|service writer|approval rate|مستشار|الاستشارة|نسبة الموافقة)/.test(
      q,
    )
  )
    return "ADVISOR_RANKING";

  // English + Arabic keywords (existing intents).
  if (/(owe|owed|owes|outstanding|unpaid|receivable|who.*pay|مستحق|مدين|ديون)/.test(q))
    return "WHO_OWES";
  if (/(profit|margin|earn|made|ربح|أرباح|الربح)/.test(q)) return "PROFIT_MONTH";
  if (/(up or down|this week|last week|trend|compared|better|worse|ارتفاع|انخفاض|الأسبوع|أفضل|أسوأ)/.test(q))
    return "WEEK_TREND";
  return "UNKNOWN";
}

export const UNKNOWN_REPLY =
  "I can answer about profit, receivables, weekly trend, invoice summaries, VAT, outstanding advances, top technicians or advisors, and the cash/AR balance.";
