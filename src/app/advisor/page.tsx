import { requireRole } from "@/lib/guard";
import { StaffHome } from "@/components/staff-home";

export default async function AdvisorHome() {
  const session = await requireRole("ADVISOR");
  return <StaffHome role="ADVISOR" name={session.user.name} />;
}
