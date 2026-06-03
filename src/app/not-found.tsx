import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        This page doesn’t exist or the link has expired.
      </p>
      <Link
        href="/"
        className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/20"
      >
        Go home
      </Link>
    </main>
  );
}
