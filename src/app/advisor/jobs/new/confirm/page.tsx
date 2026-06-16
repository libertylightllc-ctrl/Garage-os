import Link from "next/link";
import { requireRole } from "@/lib/guard";
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
  vehicleId?: string;
  assignedToId?: string;
  //"moulkia"= OCR path (consent required);"manual"= no photo;"repeat"= pick-existing
  via?:"moulkia"|"manual"|"repeat";
  error?: string;
  //"1"= advisor skipped the back-photo step
  skippedBack?: string;
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
  await requireRole("ADVISOR");
  const t = await getT();
  const locale = await getLocale();
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
          <span>⚠️ {t("errOcrFailed")}</span>
          <Link
            href="/advisor/jobs/new"
            className="rounded-md border border-amber-300 bg-white/60 px-3 py-1 text-xs font-medium hover:bg-white dark:border-amber-700 dark:bg-black/30 dark:hover:bg-surface-20"
          >
            📷 {t("tryAgain")}
          </Link>
        </div>
      ) : null}

      {ocrBackFailed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning-500/40 bg-warning-50 p-3 text-sm text-warning-600 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
          <span>⚠️ {t("errOcrBackFailed")}</span>
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
        <input type="hidden" name="assignedToId" defaultValue={sp.assignedToId ?? ""} />
        <input type="hidden" name="via" defaultValue={via} />

        {/* Customer */}
        <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t("secCustomer")}</legend>
          <label className="text-xs text-text-mute">
            {t("ownerName")}
            <input name="ownerName" defaultValue={sp.ownerName ?? ""} required className={FIELD} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-text-mute">
              {t("mobile")}
              <input name="phone" type="tel" defaultValue={sp.phone ?? ""} placeholder="+9715XXXXXXXX" required className={FIELD} />
            </label>
            <label className="text-xs text-text-mute">
              {t("email")}
              <input name="email" type="email" defaultValue={sp.email ?? ""} className={FIELD} />
            </label>
          </div>
        </fieldset>

        {/* Vehicle */}
        <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t("secVehicle")}</legend>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-text-mute">
              {t("plate")}
              <input name="plate" defaultValue={sp.plate ?? ""} required className={FIELD} />
            </label>
            {/* VIN + decode button — col-span-2 so the decode UI gets
                full width below the input. The button itself is a
                client component that reads the form, validates the
                VIN, calls the server-side NHTSA route, and fills any
                BLANK fields it can (preserves OCR / typed values). */}
            <label className="col-span-2 text-xs text-text-mute">
              {t("vinLabel")}
              <input name="vin" defaultValue={sp.vin ?? ""} className={FIELD} />
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
              <input name="make" defaultValue={sp.make ?? ""} required className={FIELD} />
            </label>
            <label className="text-xs text-text-mute">
              {t("model")}
              <input name="model" defaultValue={sp.model ?? ""} required className={FIELD} />
            </label>
            <label className="text-xs text-text-mute">
              {t("yearLabel")}
              <input name="year" type="number" min="1950" max="2100" defaultValue={sp.year ?? ""} className={FIELD} />
            </label>
            <label className="text-xs text-text-mute">
              {t("mileageInLabel")}
              <input name="mileageIn" type="number" min="0" required className={FIELD} />
            </label>
            {/* Fuel type — replaces the previous Oil-type field per
                spec. Auto-fills from NHTSA VIN decode when the engine
                is mapped. The 'oilType' column stays on the schema for
                later (default NONE) but is no longer exposed on this
                form. */}
            <label className="text-xs text-text-mute">
              {t("fuelTypeLabel")}
              <select name="fuelType" defaultValue="" className={FIELD}>
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

        {/* Consent — only relevant on the Moulkia OCR path (extracting from a photo) */}
        {via ==="moulkia"? (
          <label className="flex items-start gap-2 rounded-lg border border-border p-3 text-xs text-text">
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
