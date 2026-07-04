import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { Button } from "@/components/ui/button";
import {
  updateSupplierAction,
  setSupplierActiveAction,
} from "@/app/actions/suppliers";

export const dynamic = "force-dynamic";

// Inventory 1c — supplier detail: edit the fields + deactivate / restore.
// OWNER-only, garage-scoped. Deactivate is soft (active flag) so the row
// and any part links survive. Reads/writes only Supplier; does NOT touch
// the job / estimate flow.
export default async function SupplierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireRole("OWNER");
  const t = await getT();
  const { id } = await params;
  const { error } = await searchParams;

  const supplier = await prisma.supplier.findFirst({
    where: { id, garageId: session.user.garageId },
    include: { _count: { select: { parts: true } } },
  });
  if (!supplier) notFound();

  return (
    <div>
      <AppNav role="OWNER" active="suppliers" />
      <main className="mx-auto max-w-3xl space-y-6 p-6">
        <div>
          <Link
            href="/owner/suppliers"
            className="text-xs uppercase tracking-widest text-muted-foreground underline-offset-2 hover:underline"
          >
            {t("backToSuppliers")}
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {supplier.name}
            {!supplier.active ? (
              <span className="ms-2 rounded-full bg-muted px-2 py-0.5 align-middle text-xs font-medium text-muted-foreground">
                {t("supplierInactiveTag")}
              </span>
            ) : null}
          </h1>
          <p className="text-sm text-muted-foreground">
            {supplier._count.parts} {t("supplierPartsLinked")}
          </p>
        </div>

        {error ? (
          <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
            {error}
          </p>
        ) : null}

        {/* Edit details */}
        <section className="space-y-3 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold tracking-tight">{t("editSupplier")}</h2>
          <form action={updateSupplierAction} className="grid grid-cols-2 gap-3 sm:grid-cols-2">
            <input type="hidden" name="supplierId" value={supplier.id} />
            <Field name="name" label={t("supplierName")} defaultValue={supplier.name} required className="col-span-2" />
            <Field name="contactPerson" label={t("supplierContact")} defaultValue={supplier.contactPerson ?? ""} />
            <Field name="phone" label={t("supplierPhone")} type="tel" defaultValue={supplier.phone ?? ""} />
            <Field name="email" label={t("supplierEmail")} type="email" defaultValue={supplier.email ?? ""} />
            <Field name="trn" label={t("supplierTrn")} defaultValue={supplier.trn ?? ""} />
            <Field name="address" label={t("supplierAddress")} defaultValue={supplier.address ?? ""} className="col-span-2" />
            <div className="col-span-2 flex items-end">
              <Button type="submit">{t("saveChanges")}</Button>
            </div>
          </form>
        </section>

        {/* Deactivate / restore */}
        <section className="flex items-center justify-between rounded-xl border border-border p-4">
          <div className="text-sm">
            <p className="font-medium">
              {supplier.active ? t("deactivateSupplier") : t("restoreSupplier")}
            </p>
            <p className="text-muted-foreground">
              {supplier.active
                ? t("deactivateSupplierHint")
                : t("restoreSupplierHint")}
            </p>
          </div>
          <form action={setSupplierActiveAction}>
            <input type="hidden" name="supplierId" value={supplier.id} />
            <input type="hidden" name="active" value={supplier.active ? "false" : "true"} />
            <Button type="submit" variant={supplier.active ? "ghost" : "primary"}>
              {supplier.active ? t("deactivate") : t("restore")}
            </Button>
          </form>
        </section>
      </main>
    </div>
  );
}

function Field({
  label,
  className,
  ...input
}: {
  label: string;
  className?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <input
        {...input}
        className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
      />
    </label>
  );
}
