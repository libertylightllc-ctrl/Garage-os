import { requireRole } from "@/lib/guard";
import { StaffHome } from "@/components/staff-home";

export default async function OwnerHome() {
  const session = await requireRole("OWNER");
  return <StaffHome role="OWNER" name={session.user.name} />;
}
