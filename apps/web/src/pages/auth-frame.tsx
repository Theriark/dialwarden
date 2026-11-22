// The frame of the sign-in, second-step and first-run setup screens: the
// stacked logo above a card, centred on the page background.
import type { ReactNode } from "react";
import { Logo } from "../components/brand/logo";
import { cn } from "../lib/cn";

interface AuthFrameProps {
  title: string;
  description?: string | undefined;
  children: ReactNode;
  wide?: boolean | undefined;
}

export function AuthFrame({
  title,
  description,
  children,
  wide = false,
}: AuthFrameProps) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-bg px-4 py-10 text-fg sm:justify-center sm:py-16">
      <Logo variant="stacked" className="mb-6" />
      <section
        className={cn(
          "flex w-full flex-col gap-6 rounded-card border border-border bg-surface p-6 shadow-card sm:p-8",
          wide ? "max-w-xl" : "max-w-md",
        )}
      >
        <header className="flex flex-col gap-1">
          <h1 className="font-heading text-3xl font-bold">{title}</h1>
          {description !== undefined ? (
            <p className="text-sm text-fg-muted">{description}</p>
          ) : null}
        </header>
        {children}
      </section>
      <p className="mt-6 text-xs text-fg-muted">Dialwarden by Theriark</p>
    </main>
  );
}
