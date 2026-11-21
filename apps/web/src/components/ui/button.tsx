import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  /** Shows a spinner in place of the icon and disables the button. */
  loading?: boolean | undefined;
  icon?: ReactNode;
}

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-control border font-medium whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60";

function variantClass(variant: ButtonVariant): string {
  switch (variant) {
    case "primary":
      return "border-transparent bg-primary text-primary-fg hover:opacity-90";
    case "ghost":
      return "border-transparent bg-transparent text-fg hover:bg-accent-soft";
    case "destructive":
      return "border-transparent bg-error text-on-error hover:opacity-90";
    default:
      return "border-border-strong bg-surface text-fg hover:bg-accent-soft";
  }
}

function sizeClass(size: ButtonSize): string {
  return size === "lg" ? "h-10 px-4 text-base" : "h-8 px-3 text-sm";
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(BASE, variantClass(variant), sizeClass(size), className)}
      disabled={disabled === true || loading}
      aria-busy={loading ? true : undefined}
      {...rest}
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The accessible name; icon-only controls always have one. */
  label: string;
  children: ReactNode;
}

export function IconButton({
  label,
  className,
  children,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-control border border-transparent text-fg-muted transition-colors duration-150 hover:bg-accent-soft hover:text-fg disabled:opacity-60",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
