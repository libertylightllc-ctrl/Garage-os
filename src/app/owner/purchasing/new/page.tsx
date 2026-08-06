import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { Button } from "@/components/ui/button";
import { createPurchaseOrderAction } from "@/app/actions/purchasing";
import { UnsavedChangesGuard } from "@/components/unsaved-changes-guard";
import { VehicleMatchFill } from "@/components/vehicle-match-fill";

export const dynamic = "force-dynamic";

// Inventory 2a — new PO shell. Pick an active supplier; lines are added
// on the detail page after creation. OWNER-only, garage-scoped.
//
// Two-mode (2026-08-02): the page reads `?mode=quote|order` and shapes
// title, hint, submit label, and hidden `mode` form input. Both modes
// write the same DRAFT PO row — the mode only carries through as a
// query param to the detail page so the add-line cost input can be
// `required` on order mode and optional on quote mode. Server-side the
// create action is agnostic (Layer 0 accepts null unitCost).
export default async function NewPurchaseOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; mode?: string }>;
}) {
  const session = await requireAnyRole(["OWNER", "MASTER"]);
  const t = await getT();
  const { error, mode: rawMode } = await searchParams;
  // Whitelist the mode — anything else defaults to `quote` (the safer
  // shape: cost optional, no committing language). Prevents an
  // unfamiliar query string from silently steering the UI.
  const mode: "quote" | "order" = rawMode === "order" ? "order" : "quote";
  const title = mode === "order" ? t("newPurchaseOrder") : t("newQuotation");
  const hint = mode === "order" ? t("newPurchaseOrderHint") : t("newQuotationHint");
  const submitLabel = mode === "order" ? t("createPurchaseOrder") : t("createQuotation");

  const suppliers = await prisma.supplier.findMany({
    where: { garageId: session.user.garageId, active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  // Garage vehicles for the plate datalist. The supplier facing side
  // of the doc needs to know which car — the widget lets the owner
  // pick a car already in the garage (auto-fills the free-text
  // fields client-side is nice-to-have; not built here — the server
  // exact-matches plate and snapshots the full row when it lands).
  const vehicles = await prisma.vehicle.findMany({
    where: { customer: { garageId: session.user.garageId } },
    orderBy: [{ make: "asc" }, { model: "asc" }],
    select: {
      id: true,
      plate: true,
      make: true,
      model: true,
      year: true,
    },
    take: 500,
  });

  return (
    <div>
      <AppNav role="OWNER" active="purchasing" />
      <main className="mx-auto max-w-2xl space-y-6 p-6">
        <div>
          <Link
            href="/owner/purchasing"
            className="text-xs uppercase tracking-widest text-muted-foreground underline-offset-2 hover:underline"
          >
            {t("backToPurchasing")}
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
        </div>

        {error ? (
          <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
            {error}
          </p>
        ) : null}

        {suppliers.length === 0 ? (
          <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
            {t("noSuppliersForPo")}{" "}
            <Link href="/owner/suppliers" className="font-medium text-foreground hover:underline">
              {t("tabSuppliers")}
            </Link>
            .
          </p>
        ) : (
          <form id="new-po-form" action={createPurchaseOrderAction} className="space-y-4 rounded-xl border border-border p-4">
            <UnsavedChangesGuard formId="new-po-form" />
            {/* Mode passthrough — the server action reads this to
                redirect to the detail page with ?mode= so the add-line
                cost input can render as required (order) or optional
                (quote). No server-side write difference. */}
            <input type="hidden" name="mode" value={mode} />
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("poSupplier")}</span>
              <select
                name="supplierId"
                required
                defaultValue=""
                className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
              >
                <option value="" disabled>
                  {t("choosePlaceholder")}
                </option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("poReference")}</span>
              <input name="reference" className="rounded-md border border-border bg-transparent px-3 py-2 text-sm" />
            </label>

            {/* Document-level default vehicle (2026-08-02). Two ways to
                set it: pick an existing garage vehicle by plate
                (server exact-matches and snapshots the full row) OR
                type make/model/year/engine/VIN for a car that isn't in
                the system. Every field is optional individually — an
                advisor asking a supplier to quote often has only make
                and model. The values pre-fill each new line's own
                snapshot at Add-line write time (copied on write, never
                referenced live). */}
            <fieldset className="flex flex-col gap-3 rounded-lg border border-border/60 bg-surface-2/40 p-3">
              <legend className="px-1 text-xs uppercase tracking-wide text-muted-foreground">
                {t("poDefaultVehicleLegend")}
              </legend>
              <p className="text-[11px] text-muted-foreground">
                {t("poDefaultVehicleHint")}
              </p>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t("vehiclePlateLabel")}</span>
                <input
                  name="vehicle_plate"
                  type="text"
                  list="new-po-vehicle-plates"
                  autoComplete="off"
                  placeholder={t("vehiclePlatePlaceholder")}
                  className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                />
                <datalist id="new-po-vehicle-plates">
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.plate}>
                      {v.make} {v.model}
                      {v.year ? ` (${v.year})` : ""}
                    </option>
                  ))}
                </datalist>
              </label>
              <VehicleMatchFill
                plateName="vehicle_plate"
                makeName="vehicle_make"
                modelName="vehicle_model"
                yearName="vehicle_year"
                engineName="vehicle_engineSize"
                vinName="vehicle_vin"
                labels={{
                  matchedLabel: t("vehicleMatchLabel"),
                  dismissLabel: t("vehicleMatchDismiss"),
                  vinLabel: t("vehicleVinLabel"),
                }}
              />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{t("vehicleMakeLabel")}</span>
                  <input
                    name="vehicle_make"
                    type="text"
                    className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{t("vehicleModelLabel")}</span>
                  <input
                    name="vehicle_model"
                    type="text"
                    className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{t("vehicleYearLabel")}</span>
                  <input
                    name="vehicle_year"
                    type="number"
                    inputMode="numeric"
                    min="1900"
                    max="2100"
                    className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{t("vehicleEngineLabel")}</span>
                  <input
                    name="vehicle_engineSize"
                    type="text"
                    className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t("vehicleVinLabel")}</span>
                <input
                  name="vehicle_vin"
                  type="text"
                  maxLength={17}
                  className="rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono"
                />
              </label>
            </fieldset>

            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("poNote")}</span>
              <input name="note" className="rounded-md border border-border bg-transparent px-3 py-2 text-sm" />
            </label>
            <Button type="submit">{submitLabel}</Button>
          </form>
        )}
      </main>
    </div>
  );
}
