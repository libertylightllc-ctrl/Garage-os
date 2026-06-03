import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createBookingPublic } from "@/app/actions/intake";

export const dynamic = "force-dynamic";

const field =
  "w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20";

export default async function CustomerBooking({ params }: { params: Promise<{ garageId: string }> }) {
  const { garageId } = await params;
  const garage = await prisma.garage.findUnique({ where: { id: garageId }, select: { name: true } });
  if (!garage) notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{garage.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">Book a service</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Tell us what’s wrong — no forms to fill in detail. We’ll propose a fix.
        </p>
      </div>

      <form action={createBookingPublic} className="flex flex-col gap-3">
        <input type="hidden" name="garageId" value={garageId} />
        <div className="flex gap-2">
          <input name="name" placeholder="Your name" className={field} />
          <input name="phone" placeholder="Phone" required className={field} />
        </div>
        <div className="flex gap-2">
          <input name="make" placeholder="Make (e.g. Toyota)" className={field} />
          <input name="model" placeholder="Model" className={field} />
          <input name="plate" placeholder="Plate" className={field} />
        </div>
        <textarea
          name="text"
          required
          rows={3}
          placeholder="Describe the problem in your own words (e.g. ‘AC not cooling when hot’)"
          className={field}
        />
        <label className="text-sm text-zinc-500 dark:text-zinc-400">
          Optional photo
          <input type="file" name="photo" accept="image/*" capture="environment" className="mt-1 block w-full text-xs" />
        </label>
        <button className="rounded-lg bg-zinc-900 px-4 py-3 font-semibold text-white hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-200">
          Get a proposal
        </button>
      </form>
    </main>
  );
}
