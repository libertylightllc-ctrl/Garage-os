import { requireRole } from "@/lib/guard";
import { StaffHome } from "@/components/staff-home";

export default async function AccountantHome() {
  const session = await requireRole("ACCOUNTANT");
  return <StaffHome role="ACCOUNTANT" name={session.user.name} />;
}
