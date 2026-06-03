import { prisma } from "@/lib/prisma";
import { proposeFromText, estimateCostUsd, type IntakeProposal } from "@/lib/ai";

/**
 * IntakeService — turns a customer complaint into a structured proposal and meters
 * the AI call to AiEvent (UsageMeter). Always returns a proposal for a human to
 * confirm; never auto-commits a JobCard.
 */
export async function runIntake(opts: {
  garageId: string;
  text: string;
  userId?: string;
}): Promise<IntakeProposal> {
  const start = Date.now();
  const r = await proposeFromText(opts.text);
  const latencyMs = Date.now() - start;

  await prisma.aiEvent.create({
    data: {
      garageId: opts.garageId,
      userId: opts.userId ?? null,
      kind: "INTAKE",
      model: r.model,
      sourceType: "BOOKING",
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      costEstimate: estimateCostUsd(r.model, r.tokensIn, r.tokensOut),
      latencyMs,
    },
  });

  return r.proposal;
}
