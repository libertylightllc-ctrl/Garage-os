// AI layer. Calls Claude when ANTHROPIC_API_KEY is set; otherwise a deterministic
// heuristic so the propose-confirm flow is fully demoable. Every caller meters to AiEvent.

export interface IntakeProposal {
  likelyIssue: string;
  suggestedServices: string[];
  urgency: "LOW" | "MEDIUM" | "HIGH";
}

export interface AiResult {
  proposal: IntakeProposal;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export function aiEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Cheap model is the cost lever for high-volume intake.
const INTAKE_MODEL = process.env.ANTHROPIC_INTAKE_MODEL ?? "claude-haiku-4-5";

// Rough $/token (USD) for cost metering. Tune as pricing changes.
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1 / 1_000_000, out: 5 / 1_000_000 },
  "heuristic-fallback": { in: 0, out: 0 },
};

export function estimateCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[model] ?? PRICING["claude-haiku-4-5"];
  return tokensIn * p.in + tokensOut * p.out;
}

const GCC_RULES: { match: RegExp; issue: string; services: string[]; urgency: IntakeProposal["urgency"] }[] = [
  { match: /\bac\b|cool|cold|aircon|a\/c|hot air/i, issue: "AC not cooling", services: ["AC diagnostics", "Refrigerant recharge"], urgency: "MEDIUM" },
  { match: /brake|squeal|grind/i, issue: "Brake wear / noise", services: ["Brake inspection", "Pad replacement"], urgency: "HIGH" },
  { match: /battery|won'?t start|jump/i, issue: "Battery / starting issue", services: ["Battery test", "Battery replacement"], urgency: "HIGH" },
  { match: /overheat|temperature|steam|smoke/i, issue: "Engine overheating", services: ["Cooling system check"], urgency: "HIGH" },
  { match: /oil|service|mileage|km/i, issue: "Routine service due", services: ["Oil & filter change", "Multi-point inspection"], urgency: "LOW" },
  { match: /tyre|tire|puncture|flat/i, issue: "Tyre issue", services: ["Tyre inspection", "Tyre replacement"], urgency: "MEDIUM" },
];

export function heuristicProposal(text: string): IntakeProposal {
  const t = text || "";
  for (const r of GCC_RULES) {
    if (r.match.test(t)) return { likelyIssue: r.issue, suggestedServices: r.services, urgency: r.urgency };
  }
  return {
    likelyIssue: "General inspection needed",
    suggestedServices: ["Multi-point inspection"],
    urgency: "MEDIUM",
  };
}

function extractJson(s: string): string {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : s;
}

async function callClaude(text: string): Promise<AiResult> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: INTAKE_MODEL,
      max_tokens: 300,
      system:
        "You are a GCC auto-garage intake assistant. Read the customer's complaint and reply with ONLY a JSON object: " +
        '{"likelyIssue": string, "suggestedServices": string[], "urgency": "LOW"|"MEDIUM"|"HIGH"}. ' +
        "Account for GCC conditions (heat, AC, dust, batteries). No prose.",
      messages: [{ role: "user", content: text }],
    }),
  });
  const j = (await res.json()) as {
    content?: { text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (!res.ok) throw new Error(`Anthropic error ${res.status}`);
  const raw = j.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(extractJson(raw)) as IntakeProposal;
  return {
    proposal: {
      likelyIssue: parsed.likelyIssue ?? "General inspection needed",
      suggestedServices: Array.isArray(parsed.suggestedServices) ? parsed.suggestedServices : [],
      urgency: parsed.urgency ?? "MEDIUM",
    },
    model: INTAKE_MODEL,
    tokensIn: j.usage?.input_tokens ?? 0,
    tokensOut: j.usage?.output_tokens ?? 0,
  };
}

/** Returns a structured proposal. Falls back to the heuristic on any AI failure. */
export async function proposeFromText(text: string): Promise<AiResult> {
  if (aiEnabled()) {
    try {
      return await callClaude(text);
    } catch {
      // graceful fallback — the no-forms promise must never hard-fail
    }
  }
  return { proposal: heuristicProposal(text), model: "heuristic-fallback", tokensIn: 0, tokensOut: 0 };
}
