import { requireRole } from "@/lib/guard";
import { StaffHome } from "@/components/staff-home";

export default async function TechnicianHome() {
  const session = await requireRole("TECH");
  return <StaffHome role="TECH" name={session.user.name} />;
}
