// Owner copilot — classifies a natural-language question into one of the Phase-1
// single-garage intents. Pure + testable; the answer is always computed from
// garage-scoped DB queries (owner-metrics), never invented by a model.

export type CopilotIntent = "PROFIT_MONTH" | "WHO_OWES" | "WEEK_TREND" | "UNKNOWN";

export const SAMPLE_QUESTIONS = [
  "Are we up or down this week?",
  "How much profit this month?",
  "Who owes us money?",
];

export function classifyIntent(question: string): CopilotIntent {
  const q = question.toLowerCase();
  // English + Arabic keywords.
  if (/(owe|owed|owes|outstanding|unpaid|receivable|who.*pay|مستحق|مدين|ديون|الذمم)/.test(q))
    return "WHO_OWES";
  if (/(profit|margin|earn|made|ربح|أرباح|الربح)/.test(q)) return "PROFIT_MONTH";
  if (/(up or down|this week|last week|trend|compared|better|worse|ارتفاع|انخفاض|الأسبوع|أفضل|أسوأ)/.test(q))
    return "WEEK_TREND";
  return "UNKNOWN";
}

export const UNKNOWN_REPLY =
  "I can answer about this month's profit, who owes us money, or whether we're up or down this week.";
