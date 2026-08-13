import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { createCustomerVehicleJobAction } from "@/app/actions/intake-moulkia";
import { AppNav } from "@/components/app-nav";
import { getLocale, getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";
import { DictateInput, DictateTextarea } from "@/components/dictate";
import {
  EXTERIOR_OPTIONS,
  INTERIOR_OPTIONS,
  VALUABLES_OPTIONS,
  FUEL_TYPES,
  FUEL_LEVELS,
} from "@/lib/jobcard-fields";
import { VinDecodeButton } from "@/components/vin-decode-button";

export const dynamic ="force-dynamic";

interface SP {
  ownerName?: string;
  phone?: string;
  email?: string;
  plate?: string;
  make?: string;
  model?: string;
  year?: string;
  vin?: string;
  // Intrinsic vehicle spec — carried through plate-lookup so a returning
  // vehicle pre-fills these too. NHTSA VIN decode fills the blanks.
  engineSize?: string;
  fuelType?: string;
  vehicleId?: string;
  assignedToId?: string;
  //"moulkia"= OCR path (consent required);"manual"= no photo;"repeat"= pick-existing
  via?:"moulkia"|"manual"|"repeat";
  error?: string;
  /**
   * Tier 1 OCR failure category (AR 2026-08-14). "billing" | "temporary"
   * | "generic" (or absent → generic). Populated by moulkiaFrontAction /
   * moulkiaBackAction when the Anthropic call failed, and drives the
   * banner text below so the advisor sees "contact owner" for a credit
   * shortfall or "try again" for a transient hiccup, not the generic
   * "couldn't read the photo" for every class of failure.
   */
  errorCode?: string;
  //"1"= advisor skipped the back-photo step
  skippedBack?: string;
  // Slice 3 disambiguation panel outputs. editOwner=1 means the confirm
  // action does a Customer FK move on the existing Vehicle + writes a
  // VehicleOwnershipTransfer row. releasePlateFrom carries the old
  // Vehicle's id so its plate + history get closed atomically when the
  // new Vehicle is created. Both are hidden inputs, not editable.
  editOwner?: string;
  releasePlateFrom?: string;
  // Moulkia OCR pipeline — opaque draft id keyed by IntakeDraft.
  // The confirm page loads the draft server-side and uses its fields
  // as the third defaults tier (URL param → vehicleId DB row → draft).
  // The extracted PII never appears in the URL bar.
  draftId?: string;
}

type T = (k: MessageKey) => string;
const FIELD ="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm";

function CheckboxGroup({
  name,
  options,
  prefix,
  t,
}: {
  name: string;
  options: readonly string[];
  prefix: string;
  t: T;
}) {
  return (
    <div className="mt-1 grid grid-cols-2 gap-1 sm:grid-cols-3">
      {options.map((v) => (
        <label key={v} className="flex items-center gap-1 text-sm">
          <input type="checkbox" name={name} value={v} />
          {t(`${prefix}_${v}` as MessageKey)}
        </label>
      ))}
    </div>
  );
}

export default async function ReceptionForm({ searchParams }: { searchParams: Promise<SP> }) {
  const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
  const t = await getT();
  const locale = await getLocale();
  // Optional-assignment picker data — techs + bays scoped to this garage.
  // Empty results collapse each picker to its "unassigned" / "no bay" option
  // only, which is the same as leaving the field untouched (no schema
  // change, no visual glitch on a garage with 0 bays).
  const [techs, bays] = await Promise.all([
    prisma.user.findMany({
      where: { garageId: session.user.garageId, role: "TECH" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.bay.findMany({
      where: { garageId: session.user.garageId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  const dictLabels = {
    start: t("dictateStart"),
    stop: t("dictateStop"),
    listening: t("dictateListening"),
    error: t("dictateError"),
  };
  const sp = await searchParams;
  const isRepeat = Boolean(sp.vehicleId) || sp.via ==="repeat";
  // Default to"moulkia"so older bookmarks / direct links still require consent.
  const via = sp.via ??"moulkia";
  const isManual = via ==="manual";
  const ocrFailed = sp.error ==="ocr";
  const ocrBackFailed = sp.error ==="ocrBack";
  const backSkipped = sp.skippedBack ==="1";
  // Tier 1 taxonomy — pick the banner message for the failure class.
  // Falls back to the generic "couldn't read" message for unknown /
  // absent codes so bookmarks + older redirect URLs keep working.
  const ocrBannerKey = ((): MessageKey => {
    if (sp.errorCode === "billing") return "errOcrBilling";
    if (sp.errorCode === "temporary") return "errOcrTemporary";
    return ocrBackFailed ? "errOcrBackFailed" : "errOcrFailed";
  })();

  // Repeat-vehicle DB lookup. When the caller passed vehicleId (all
  // slice-3 panel choices, the intake-landing existing-vehicle picker,
  // plateLookupAction's Case A route through the panel), fill every
  // form default from the DB record instead of URL query params.
  // Owner name / phone / VIN used to travel through the URL — that's
  // the class of leak this fix is closing. Garage-scoped via the
  // customer relation; a vehicleId from another tenant renders no
  // defaults (same posture as notFound(), just without a hard 404 so
  // the form still submits).
  //
  // When editOwner=1 (Choice 2 — same car, owner has changed), we
  // deliberately DO NOT fill owner name / phone / email from the
  // record: the advisor is capturing the NEW owner's details. Vehicle
  // spec still fills from the record because the car itself is
  // unchanged.
  const editOwner = sp.editOwner === "1";
  const existing = sp.vehicleId
    ? await prisma.vehicle.findFirst({
        where: { id: sp.vehicleId, customer: { garageId: session.user.garageId } },
        include: { customer: { select: { name: true, phone: true, email: true } } },
      })
    : null;
  // Third defaults tier — the Moulkia OCR draft. Only consulted when no
  // vehicleId is set (repeat-customer path already has authoritative
  // data). Garage-scoped + not-expired: a stale draft renders no
  // defaults, but the form still submits so the advisor can type
  // manually.
  const now = new Date();
  const draft = sp.draftId
    ? await prisma.intakeDraft.findFirst({
        where: {
          id: sp.draftId,
          garageId: session.user.garageId,
          expiresAt: { gt: now },
        },
      })
    : null;
  const dbOwnerName = editOwner
    ? ""
    : existing?.customer.name ?? draft?.ownerName ?? "";
  const dbPhone = editOwner
    ? ""
    : existing?.customer.phone ?? "";
  const dbEmail = editOwner ? "" : existing?.customer.email ?? "";
  const dbPlate = existing?.plate ?? draft?.plate ?? "";
  const dbMake = existing?.make ?? draft?.make ?? "";
  const dbModel = existing?.model ?? draft?.model ?? "";
  const dbYear =
    existing?.year != null
      ? String(existing.year)
      : draft?.year != null
        ? String(draft.year)
        : "";
  const dbVin = existing?.vin ?? draft?.vin ?? "";
  const dbEngineSize = existing?.engineSize ?? draft?.engineSize ?? "";
  const dbFuelType = existing?.fuelType ?? draft?.fuelType ?? "";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-5 p-6">
      <AppNav role="ADVISOR" active="jobs"/>
      <div>
        <Link href="/advisor/jobs/new" className="text-sm text-text-mute hover:underline">
          {t("backActiveJobs")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("confirmCustomerTitle")}</h1>
        <p className="text-sm text-text-mute">
          {isRepeat ? t("prefilledFromRecord") : isManual ? t("manualEntryIntro") : t("confirmHint")}
        </p>
      </div>

      {ocrFailed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning-500/40 bg-warning-50 p-3 text-sm text-warning-600 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
          <span>⚠️ {t(ocrBannerKey)}</span>
          {/* Only the front-side "try again" makes sense for the retake
              button — a back-side failure never lands on the front and
              a billing failure won't be fixed by another attempt. */}
          {sp.errorCode !== "billing" ? (
            <Link
              href="/advisor/jobs/new"
              className="rounded-md border border-warning-500/40 bg-surface px-3 py-1 text-xs font-medium hover:bg-surface-2"
            >
              📷 {t("tryAgain")}
            </Link>
          ) : null}
        </div>
      ) : null}

      {ocrBackFailed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning-500/40 bg-warning-50 p-3 text-sm text-warning-600 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
          <span>⚠️ {t(ocrBannerKey)}</span>
        </div>
      ) : null}

      {backSkipped ? (
        <div className="rounded-xl border border-border bg-surface-2 p-3 text-sm text-text-mute">
          ℹ️ {t("backSkipped")}
        </div>
      ) : null}

      {/* Returning vehicle banner — surfaces when the advisor came
          here via the plate-lookup or repeat-customer path. Gives the
          advisor a one-tap link into the full service history before
          they start a new job card. Hidden on first-time customers
          (no vehicleId in the searchParams). */}
      {isRepeat && sp.vehicleId ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-info-500/40 bg-info-50 p-4 text-sm text-info-600 dark:border-info-500/30 dark:bg-info-500/10 dark:text-info-500">
          <span>🕘 {t("vehicleBeenHere")}</span>
          <Link
            href={`/advisor/vehicles/${sp.vehicleId}`}
            className="inline-flex h-9 items-center justify-center rounded-lg border border-info-500/40 bg-surface px-3 text-xs font-semibold text-info-600 hover:bg-info-50 transition-colors dark:text-info-500 dark:bg-info-500/10"
          >
            {t("vehicleViewHistory")} →
          </Link>
        </div>
      ) : null}

      <form action={createCustomerVehicleJobAction} className="flex flex-col gap-5">
        <input type="hidden" name="vehicleId" defaultValue={sp.vehicleId ?? ""} />
        <input type="hidden" name="via" defaultValue={via} />
        {/* Slice 3 — panel outputs. Hidden so the advisor can't clear
            them mid-form and end up with the wrong write path. */}
        <input type="hidden" name="editOwner" defaultValue={sp.editOwner ?? ""} />
        <input type="hidden" name="releasePlateFrom" defaultValue={sp.releasePlateFrom ?? ""} />
        {/* Moulkia OCR draft id — carries the extracted PII server-side
            across front→back→confirm so nothing sensitive rides the
            URL. Deleted OUTSIDE the write transaction on successful
            create. See docs/intake-duplicate-handling-spec.md § "PII
            in URL". */}
        <input type="hidden" name="draftId" defaultValue={sp.draftId ?? ""} />

        {/* Customer */}
        <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t("secCustomer")}</legend>
          <label className="text-xs text-text-mute">
            {t("ownerName")}
            <input name="ownerName" defaultValue={sp.ownerName ?? dbOwnerName} required className={FIELD} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-text-mute">
              {t("mobile")}
              <input name="phone" type="tel" defaultValue={sp.phone ?? dbPhone} placeholder="+9715XXXXXXXX" required className={FIELD} />
            </label>
            <label className="text-xs text-text-mute">
              {t("email")}
              <input name="email" type="email" defaultValue={sp.email ?? dbEmail} className={FIELD} />
            </label>
          </div>
        </fieldset>

        {/* Vehicle */}
        <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t("secVehicle")}</legend>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-text-mute">
              {t("plate")}
              <input name="plate" defaultValue={sp.plate ?? dbPlate} required className={FIELD} />
            </label>
            {/* VIN + decode button — col-span-2 so the decode UI gets
                full width below the input. The button itself is a
                client component that reads the form, validates the
                VIN, calls the server-side NHTSA route, and fills any
                BLANK fields it can (preserves OCR / typed values). */}
            <label className="col-span-2 text-xs text-text-mute">
              {t("vinLabel")}
              <input name="vin" defaultValue={sp.vin ?? dbVin} className={FIELD} />
              <div className="mt-2">
                <VinDecodeButton
                  labels={{
                    decodeBtn: t("vinDecodeBtn"),
                    decoding: t("vinDecoding"),
                    invalidVin: t("vinInvalid"),
                    notFound: t("vinNotFound"),
                    networkError: t("vinNetworkError"),
                    decodedNote: t("vinDecodedNote"),
                    filledFields: t("vinFilledFields"),
                  }}
                />
              </div>
            </label>
            <label className="text-xs text-text-mute">
              {t("make")}
              <input name="make" defaultValue={sp.make ?? dbMake} required className={FIELD} />
            </label>
            <label className="text-xs text-text-mute">
              {t("model")}
              <input name="model" defaultValue={sp.model ?? dbModel} required className={FIELD} />
            </label>
            <label className="text-xs text-text-mute">
              {t("yearLabel")}
              <input name="year" type="number" min="1950" max="2100" defaultValue={sp.year ?? dbYear} className={FIELD} />
            </label>
            <label className="text-xs text-text-mute">
              {t("mileageInLabel")}
              <input name="mileageIn" type="number" min="0" required className={FIELD} />
            </label>
            {/* Engine size — free text ("2.7", "4.0", "2.0T"). NHTSA's
                DisplacementL fills this when VIN decode succeeds. Always
                editable so a tech in the GCC who knows the spec from
                memory can type it even when neither OCR nor NHTSA gives
                anything (which happens for GCC-spec vehicles). */}
            <label className="text-xs text-text-mute">
              {t("engineSizeLabel")}
              <input
                name="engineSize"
                defaultValue={sp.engineSize ?? dbEngineSize}
                placeholder="2.7"
                className={FIELD}
              />
            </label>
            {/* Fuel type — replaces the previous Oil-type field per
                spec. Auto-fills from NHTSA VIN decode when the engine
                is mapped. The 'oilType' column stays on the schema for
                later (default NONE) but is no longer exposed on this
                form. */}
            <label className="text-xs text-text-mute">
              {t("fuelTypeLabel")}
              <select name="fuelType" defaultValue={sp.fuelType ?? dbFuelType} className={FIELD}>
                <option value="">—</option>
                {FUEL_TYPES.map((v) => (
                  <option key={v} value={v}>
                    {t(`fuelType_${v}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-text-mute">
              {t("fuelLevelLabel")}
              <select name="fuelLevel" defaultValue="" className={FIELD}>
                <option value="">—</option>
                {FUEL_LEVELS.map((v) => (
                  <option key={v} value={v}>
                    {t(`fuel_${v}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>

        {/* Complaint */}
        <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t("secComplaint")}</legend>
          <DictateTextarea locale={locale} labels={dictLabels} name="complaint" rows={3} required placeholder={t("complaintLabel")} className={FIELD} />
        </fieldset>

        {/* Condition (dispute shield) */}
        <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t("secCondition")}</legend>
          <div className="text-xs font-medium text-text">{t("exteriorLabel")}</div>
          <CheckboxGroup name="exterior" options={EXTERIOR_OPTIONS} prefix="ext" t={t} />
          <DictateInput locale={locale} labels={dictLabels} name="exteriorRemarks" placeholder={t("remarksLabel")} className={FIELD} />
          <div className="mt-2 text-xs font-medium text-text">{t("interiorLabel")}</div>
          <CheckboxGroup name="interior" options={INTERIOR_OPTIONS} prefix="int" t={t} />
          <DictateInput locale={locale} labels={dictLabels} name="interiorRemarks" placeholder={t("remarksLabel")} className={FIELD} />
        </fieldset>

        {/* Valuables */}
        <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t("secValuables")}</legend>
          <CheckboxGroup name="valuables" options={VALUABLES_OPTIONS} prefix="val" t={t} />
          <DictateInput locale={locale} labels={dictLabels} name="valuablesNote" placeholder={t("valuablesNoteLabel")} className={FIELD} />
        </fieldset>

        {/* Assignment (optional). Priority / technician / bay all default
            to blank — blank behaves exactly as today: no assigned tech
            (drops into the shared pool for anyone to claim), no bay, and
            priority 0 (normal). Any of the three can be set later on
            /advisor/jobs/[id]. Picker shape matches the setters there so
            an advisor sees the same UI in both places. */}
        <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t("secAssignment")}</legend>
          <label className="text-xs text-text-mute">
            {t("priorityLabel")}
            <select name="priority" defaultValue="0" className={FIELD}>
              <option value="0">{t("prNormal")}</option>
              <option value="1">{t("prUrgent")}</option>
              <option value="2">{t("prEmergency")}</option>
            </select>
          </label>
          <label className="text-xs text-text-mute">
            {t("technicianLabel")}
            <select
              name="assignedToId"
              defaultValue={sp.assignedToId ?? draft?.assignedToId ?? ""}
              className={FIELD}
            >
              <option value="">{t("unassigned")}</option>
              {techs.map((tech) => (
                <option key={tech.id} value={tech.id}>
                  {tech.name}
                </option>
              ))}
            </select>
          </label>
          {bays.length > 0 ? (
            <label className="text-xs text-text-mute">
              {t("bayLabel")}
              <select name="bayId" defaultValue="" className={FIELD}>
                <option value="">{t("noBay")}</option>
                {bays.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </fieldset>

        {/* Consent — only relevant on the Moulkia OCR path (extracting from a photo) */}
        {via ==="moulkia"? (
          <label className="flex items-start gap-2 rounded-xl border border-border p-3 text-xs text-text">
            <input type="checkbox" name="consent" className="mt-0.5" required />
            {t("moulkiaConsent")}
          </label>
        ) : null}

        {/* The 'Send to Technician' button is the explicit handoff — tapping
            it creates the job AND drops it into the shared technician pool
            (or the specific tech the advisor picked earlier). No automatic
            handoff happens before this tap. */}
        <button className="inline-flex h-12 items-center justify-center rounded-lg px-4 text-base font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
          {t("sendToTechnician")}
        </button>
      </form>
    </main>
  );
}
