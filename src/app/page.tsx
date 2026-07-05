import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { roleHome } from "@/lib/roles";
import { MarketingHome } from "@/components/marketing/marketing-home";

// Root entry. Logged-in staff are dispatched to their role home exactly
// as before (the 4 live shops' entry point is unchanged). Anonymous
// visitors — who previously bounced straight to /login — now see the
// public marketing homepage; /login stays reachable via its "Sign in"
// links, so no existing app route or auth flow changes. Purely additive.
export default async function Index() {
  const session = await auth();
  if (session?.user) redirect(roleHome(session.user.role));
  return <MarketingHome />;
}
