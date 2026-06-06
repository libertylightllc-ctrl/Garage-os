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
  OIL_TYPES,
  FUEL_LEVELS,
} from "@/lib/jobcard-fields";

export const dynamic = "force-dynamic";

interface SP {
  ownerName?: string;
  phone?: string;
  email?: string;
  plate?: string;
  make?: string;
  model?: string;
  year?: string;
  vin?: string;
  engineNumber?: string;
  vehicleId?: string;
  assignedToId?: string;
  // "moulkia" = OCR path (consent required); "manual" = no photo; "repeat" = pick-existing
  via?: "moulkia" | "manual" | "repeat";
  error?: string;
  // "1" = advisor skipped the back-photo step
  skippedBack?: string;
}

type T = (k: MessageKey) => string;
const FIELD = "mt-1 w-full rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20";

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
  const isRepeat = Boolean(sp.vehicleId) || sp.via === "repeat";
  // Default to "moulkia" so older bookmarks / direct links still require consent.
  const via = sp.via ?? "moulkia";
  const isManual = via === "manual";
  const ocrFailed = sp.error === "ocr";
  const ocrBackFailed = sp.error === "ocrBack";
  const backSkipped = sp.skippedBack === "1";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-5 p-6">
      <AppNav role="ADVISOR" active="jobs" />
      <div>
        <Link href="/advisor/jobs/new" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
          {t("backActiveJobs")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("confirmCustomerTitle")}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {isRepeat ? t("prefilledFromRecord") : isManual ? t("manualEntryIntro") : t("confirmHint")}
        </p>
      </div>

      {ocrFailed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <span>⚠️ {t("errOcrFailed")}</span>
          <Link
            href="/advisor/jobs/new"
            className="rounded-md border border-amber-300 bg-white/60 px-3 py-1 text-xs font-medium hover:bg-white dark:border-amber-700 dark:bg-black/30 dark:hover:bg-black/50"
          >
            📷 {t("tryAgain")}
          </Link>
        </div>
      ) : null}

      {ocrBackFailed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <span>⚠️ {t("errOcrBackFailed")}</span>
        </div>
      ) : null}

      {backSkipped ? (
        <div className="rounded-md bg-zinc-100 p-3 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          ℹ️ {t("backSkipped")}
        </div>
      ) : null}

      <form action={createCustomerVehicleJobAction} className="flex flex-col gap-5">
        <input type="hidden" name="vehicleId" defaultValue={sp.vehicleId ?? ""} />
        <input type="hidden" name="assignedToId" defaultValue={sp.assignedToId ?? ""} />
        <input type="hidden" name="via" defaultValue={via} />

        {/* Customer */}
        <fieldset className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
          <legend className="px-1 text-sm font-medium">{t("secCustomer")}</legend>
          <label className="text-xs text-zinc-500 dark:text-zinc-400">
            {t("ownerName")}
            <input name="ownerName" defaultValue={sp.ownerName ?? ""} required className={FIELD} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-zinc-500 dark:text-zinc-400">
              {t("mobile")}
              <input name="phone" type="tel" defaultValue={sp.phone ?? ""} placeholder="+9715XXXXXXXX" required className={FIELD} />
            </label>
            <label className="text-xs text-zinc-500 dark:text-zinc-400">
              {t("email")}
              <input name="email" type="email" defaultValue={sp.email ?? ""} className={FIELD} />
            </label>
          </div>
        </fieldset>

        {/* Vehicle */}
        <fieldset className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
          <legend className="px-1 text-sm font-medium">{t("secVehicle")}</legend>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-zinc-500 dark:text-zinc-400">
              {t("plate")}
              <input name="plate" defaultValue={sp.plate ?? ""} required className={FIELD} />
            </label>
            <label className="text-xs text-zinc-500 dark:text-zinc-400">
              {t("vinLabel")}
              <input name="vin" defaultValue={sp.vin ?? ""} className={FIELD} />
            </label>
            <label className="text-xs text-zinc-500 dark:text-zinc-400">
              {t("engineNumberLabel")}
              <input name="engineNumber" defaultValue={sp.engineNumber ?? ""} className={FIELD} />
            </label>
            <label className="text-xs text-zinc-500 dark:text-zinc-400">
              {t("make")}
              <input name="make" defaultValue={sp.make ?? ""} required className={FIELD} />
            </label>
            <label className="text-xs text-zinc-500 dark:text-zinc-400">
              {t("model")}
              <input name="model" defaultValue={sp.model ?? ""} required className={FIELD} />
            </label>
            <label className="text-xs text-zinc-500 dark:text-zinc-400">
              {t("yearLabel")}
              <input name="year" type="number" min="1950" max="2100" defaultValue={sp.year ?? ""} className={FIELD} />
            </label>
            <label className="text-xs text-zinc-500 dark:text-zinc-400">
              {t("mileageInLabel")}
              <input name="mileageIn" type="number" min="0" required className={FIELD} />
            </label>
            <label className="text-xs text-zinc-500 dark:text-zinc-400">
              {t("oilTypeLabel")}
              <select name="oilType" defaultValue="NONE" className={FIELD}>
                {OIL_TYPES.map((v) => (
                  <option key={v} value={v}>
                    {t(`oil_${v}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-zinc-500 dark:text-zinc-400">
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
        <fieldset className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
          <legend className="px-1 text-sm font-medium">{t("secComplaint")}</legend>
          <DictateTextarea locale={locale} labels={dictLabels} name="complaint" rows={3} required placeholder={t("complaintLabel")} className={FIELD} />
        </fieldset>

        {/* Condition (dispute shield) */}
        <fieldset className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
          <legend className="px-1 text-sm font-medium">{t("secCondition")}</legend>
          <div className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{t("exteriorLabel")}</div>
          <CheckboxGroup name="exterior" options={EXTERIOR_OPTIONS} prefix="ext" t={t} />
          <DictateInput locale={locale} labels={dictLabels} name="exteriorRemarks" placeholder={t("remarksLabel")} className={FIELD} />
          <div className="mt-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">{t("interiorLabel")}</div>
          <CheckboxGroup name="interior" options={INTERIOR_OPTIONS} prefix="int" t={t} />
          <DictateInput locale={locale} labels={dictLabels} name="interiorRemarks" placeholder={t("remarksLabel")} className={FIELD} />
        </fieldset>

        {/* Valuables */}
        <fieldset className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
          <legend className="px-1 text-sm font-medium">{t("secValuables")}</legend>
          <CheckboxGroup name="valuables" options={VALUABLES_OPTIONS} prefix="val" t={t} />
          <DictateInput locale={locale} labels={dictLabels} name="valuablesNote" placeholder={t("valuablesNoteLabel")} className={FIELD} />
        </fieldset>

        {/* Consent — only relevant on the Moulkia OCR path (extracting from a photo) */}
        {via === "moulkia" ? (
          <label className="flex items-start gap-2 rounded-lg border border-black/10 p-3 text-xs text-zinc-600 dark:border-white/15 dark:text-zinc-300">
            <input type="checkbox" name="consent" className="mt-0.5" required />
            {t("moulkiaConsent")}
          </label>
        ) : null}

        <button className="rounded-lg bg-zinc-900 px-4 py-3 text-base font-semibold text-white dark:bg-white dark:text-black">
          {t("startJobCard")}
        </button>
      </form>
    </main>
  );
}
