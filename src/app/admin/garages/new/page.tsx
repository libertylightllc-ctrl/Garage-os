import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin-auth";
import { adminCreateGarage } from "@/lib/admin-garage-create";
import { Button } from "@/components/ui/button";

// Phase 4: admin creates a new tenant. Two gates:
//   - requireAdmin() at page load → 404 for non-admins; writes page_view
//   - requireAdmin() inside the server action → same gate again. Belt
//     and braces: a stale form posted from a revoked admin's tab must
//     not slip through just because they saw the form earlier.
//
// Form errors are surfaced via ?error= search param. Success redirects
// straight into the detail page so the admin can verify what they
// just created.

async function createGarageAction(formData: FormData) {
  "use server";
  const admin = await requireAdmin({ pageView: "/admin/garages/new" });
  const r = await adminCreateGarage(admin, {
    garageName: String(formData.get("garageName") ?? ""),
    ownerName: String(formData.get("ownerName") ?? ""),
    ownerEmail: String(formData.get("ownerEmail") ?? ""),
    ownerPassword: String(formData.get("ownerPassword") ?? ""),
    trn: String(formData.get("trn") ?? "") || null,
    isPilot: formData.get("isPilot") === "on",
  });
  if (r.ok) {
    redirect(`/admin/garages/${r.garageId}`);
  }
  redirect(
    `/admin/garages/new?error=${encodeURIComponent(r.error)}` +
      `&code=${encodeURIComponent(r.code)}` +
      // Echo back the typed-in values so the admin doesn't have to
      // re-type after fixing the error. Password is NEVER echoed.
      `&garageName=${encodeURIComponent(String(formData.get("garageName") ?? ""))}` +
      `&ownerName=${encodeURIComponent(String(formData.get("ownerName") ?? ""))}` +
      `&ownerEmail=${encodeURIComponent(String(formData.get("ownerEmail") ?? ""))}` +
      `&trn=${encodeURIComponent(String(formData.get("trn") ?? ""))}` +
      `&isPilot=${formData.get("isPilot") === "on" ? "1" : "0"}`
  );
}

export default async function AdminNewGaragePage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    code?: string;
    garageName?: string;
    ownerName?: string;
    ownerEmail?: string;
    trn?: string;
    isPilot?: string;
  }>;
}) {
  await requireAdmin({ pageView: "/admin/garages/new" });
  const sp = await searchParams;

  // Defaults: pilot = on (matches Garage.isPilot default). On error
  // bounce, "isPilot" comes back as "1" or "0" — coerce safely.
  const pilotChecked =
    sp.isPilot === undefined ? true : sp.isPilot === "1";

  return (
    <main className="mx-auto max-w-xl space-y-6 p-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          <Link href="/admin/garages" className="underline-offset-2 hover:underline">
            ← All garages
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">New garage</h1>
        <p className="text-sm text-muted-foreground">
          Creates the tenant + an OWNER user. The owner can sign in immediately
          at /login with the credentials below.
        </p>
      </header>

      {sp.error ? (
        <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
          {sp.error}
        </p>
      ) : null}

      <form action={createGarageAction} className="flex flex-col gap-4">
        <Field
          label="Garage name"
          name="garageName"
          defaultValue={sp.garageName ?? ""}
          required
          autoFocus
        />
        <Field
          label="Owner name"
          name="ownerName"
          defaultValue={sp.ownerName ?? ""}
          required
        />
        <Field
          label="Owner email"
          name="ownerEmail"
          type="email"
          defaultValue={sp.ownerEmail ?? ""}
          required
          autoComplete="off"
        />
        <Field
          label="Owner password (≥12 chars)"
          name="ownerPassword"
          type="password"
          required
          autoComplete="new-password"
          hint="Set initial; owner can change after first login."
        />
        <Field
          label="TRN (UAE VAT, optional)"
          name="trn"
          defaultValue={sp.trn ?? ""}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="isPilot"
            defaultChecked={pilotChecked}
            className="h-4 w-4 rounded border-border"
          />
          Pilot (no subscription charge)
        </label>
        <div className="flex items-center gap-3">
          <Button type="submit">Create garage</Button>
          <Link
            href="/admin/garages"
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            Cancel
          </Link>
        </div>
      </form>

      <p className="text-xs text-muted-foreground">
        Country is fixed to UAE for Phase 1 MVP. Both the action and the
        creation event land in the AdminAuditLog.
      </p>
    </main>
  );
}

function Field({
  label,
  hint,
  ...input
}: {
  label: string;
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <input
        {...input}
        className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
      />
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
