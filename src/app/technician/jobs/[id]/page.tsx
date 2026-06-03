import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { addStepAction } from "@/app/actions/techsteps";

export const dynamic = "force-dynamic";

const STEP_ICON: Record<string, string> = {
  PHOTO: "📷",
  VOICE: "🎤",
  PART_REQUEST: "📦",
  FINISH: "✅",
};

export default async function Workshop({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireRole("TECH");

  const job = await prisma.jobCard.findFirst({
    where: { id, garageId: session.user.garageId },
    include: { vehicle: true, steps: { orderBy: { createdAt: "desc" } } },
  });
  if (!job) notFound();

  const parts = await prisma.part.findMany({
    where: { garageId: session.user.garageId },
    orderBy: { name: "asc" },
  });

  const bigBtn =
    "flex flex-col items-center justify-center gap-1 rounded-2xl border border-black/10 p-6 text-center text-base font-medium hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <div>
        <Link href="/technician" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
          ← Workshop
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {job.vehicle.make} {job.vehicle.model}
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{job.vehicle.plate}</p>
      </div>

      {/* Big-button, no-typing actions */}
      <div className="grid grid-cols-2 gap-3">
        <form action={addStepAction} className={bigBtn}>
          <input type="hidden" name="jobId" value={job.id} />
          <input type="hidden" name="type" value="PHOTO" />
          <span className="text-3xl">📷</span>
          Add Photo
          <input
            type="file"
            name="file"
            accept="image/*"
            capture="environment"
            required
            className="w-full text-xs"
          />
          <button type="submit" className="text-sm font-semibold underline">
            Upload
          </button>
        </form>

        <form action={addStepAction} className={bigBtn}>
          <input type="hidden" name="jobId" value={job.id} />
          <input type="hidden" name="type" value="VOICE" />
          <span className="text-3xl">🎤</span>
          Voice Note
          <input type="file" name="file" accept="audio/*" capture required className="w-full text-xs" />
          <button type="submit" className="text-sm font-semibold underline">
            Upload
          </button>
        </form>

        <form action={addStepAction} className="contents">
          <input type="hidden" name="jobId" value={job.id} />
          <input type="hidden" name="type" value="PART_REQUEST" />
          <div className={bigBtn}>
            <span className="text-3xl">📦</span>
            Request Part
            <select
              name="partId"
              required
              defaultValue=""
              className="mt-1 w-full rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            >
              <option value="" disabled>
                Pick a part…
              </option>
              {parts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button type="submit" className="mt-1 text-sm font-semibold underline">
              Request
            </button>
          </div>
        </form>

        <form action={addStepAction} className="contents">
          <input type="hidden" name="jobId" value={job.id} />
          <input type="hidden" name="type" value="FINISH" />
          <button type="submit" className={bigBtn}>
            <span className="text-3xl">✅</span>
            Finish
          </button>
        </form>
      </div>

      {/* Activity */}
      <div>
        <h2 className="mb-2 text-sm font-medium">Activity</h2>
        {job.steps.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Nothing yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {job.steps.map((s) => (
              <li key={s.id} className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
                <div className="mb-1 font-medium">
                  {STEP_ICON[s.type] ?? "•"} {s.type.replace("_", " ").toLowerCase()}
                </div>
                {s.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.photoUrl} alt="job photo" className="max-h-48 rounded-md" />
                ) : null}
                {s.voiceNoteUrl ? (
                  <audio controls src={s.voiceNoteUrl} className="w-full" />
                ) : null}
                {s.transcript ? <p className="text-zinc-600 dark:text-zinc-300">{s.transcript}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
