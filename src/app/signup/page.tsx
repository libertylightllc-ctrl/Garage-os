import Link from "next/link";
import { signupAction } from "@/app/actions/onboarding";

export const dynamic = "force-dynamic";

const field =
  "w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20";

export default async function Signup({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-5 p-8">
      <div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">GarageOS</p>
        <h1 className="text-2xl font-semibold tracking-tight">Set up your garage</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Creates your garage and your owner account.
        </p>
      </div>

      {error ? (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error === "exists"
            ? "That email is already registered."
            : "Please fill all fields (password min 6 chars)."}
        </p>
      ) : null}

      <form action={signupAction} className="flex flex-col gap-3">
        <input name="garageName" placeholder="Garage name" required className={field} />
        <input name="trn" placeholder="VAT TRN (optional)" className={field} />
        <input name="name" placeholder="Your name (owner)" required className={field} />
        <input name="email" type="email" placeholder="Email" required autoComplete="username" className={field} />
        <input
          name="password"
          type="password"
          placeholder="Password (min 6)"
          required
          minLength={6}
          autoComplete="new-password"
          className={field}
        />
        <button className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-200">
          Create garage
        </button>
      </form>

      <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
        Already set up?{" "}
        <Link href="/login" className="font-medium underline-offset-2 hover:underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
