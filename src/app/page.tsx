import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { roleHome } from "@/lib/roles";

// Dispatcher: send each authenticated staff member to their role home; else to login.
export default async function Index() {
 const session = await auth();
 if (!session?.user) redirect("/login");
 redirect(roleHome(session.user.role));
}
