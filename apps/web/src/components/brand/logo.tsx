// The brand lockups from apps/web/public/brand, unchanged PNG files
// (dev-work-plan-2, Brand and assets). The wordmark is never retyped.
import { cn } from "../../lib/cn";
import { useTheme } from "../../theme/theme-provider";

interface LogoProps {
  variant: "horizontal" | "stacked" | "mark";
  className?: string | undefined;
}

export function Logo({ variant, className }: LogoProps) {
  const { resolved } = useTheme();
  const dark = resolved === "dark";
  if (variant === "mark") {
    return (
      <img
        src="/brand/logo-mark-512x512.png"
        alt="Dialwarden"
        width={32}
        height={32}
        className={cn("size-8", className)}
      />
    );
  }
  if (variant === "stacked") {
    return (
      <img
        src={
          dark
            ? "/brand/logo-stacked-dark-800x800.png"
            : "/brand/logo-stacked-800x800.png"
        }
        alt="Dialwarden"
        width={160}
        height={160}
        className={cn("size-40", className)}
      />
    );
  }
  return (
    <img
      src={
        dark
          ? "/brand/logo-horizontal-dark-1200x400.png"
          : "/brand/logo-horizontal-1200x400.png"
      }
      alt="Dialwarden"
      width={132}
      height={44}
      className={cn("h-11 w-33", className)}
    />
  );
}
