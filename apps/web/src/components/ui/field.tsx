// Form controls: a label, the control, help text and the inline error, wired
// with aria-describedby and aria-invalid (design-direction-1 part 4).
import * as Label from "@radix-ui/react-label";
import { CircleX, Eye, EyeOff } from "lucide-react";
import {
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "../../lib/cn";

const CONTROL =
  "w-full rounded-control border border-border-strong bg-surface px-3 text-base text-fg placeholder:text-fg-muted disabled:opacity-60 aria-[invalid=true]:border-error";

interface FieldFrameProps {
  id: string;
  label: string;
  help?: string | undefined;
  error?: string | undefined;
  /** Something next to the label, such as a reveal toggle. */
  trailing?: ReactNode;
  children: ReactNode;
}

export function describedBy(
  id: string,
  help: string | undefined,
  error: string | undefined,
): string | undefined {
  const ids: string[] = [];
  if (error !== undefined && error !== "") {
    ids.push(`${id}-error`);
  }
  if (help !== undefined && help !== "") {
    ids.push(`${id}-help`);
  }
  return ids.length === 0 ? undefined : ids.join(" ");
}

export function FieldFrame({
  id,
  label,
  help,
  error,
  trailing,
  children,
}: FieldFrameProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label.Root htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </Label.Root>
        {trailing}
      </div>
      {children}
      {error !== undefined && error !== "" ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="flex items-center gap-1.5 text-sm text-error"
        >
          <CircleX className="size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}
      {help !== undefined && help !== "" ? (
        <p id={`${id}-help`} className="text-sm text-fg-muted">
          {help}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  id: string;
  label: string;
  help?: string | undefined;
  error?: string | undefined;
}

export function TextField({
  id,
  label,
  help,
  error,
  className,
  type = "text",
  ...rest
}: TextFieldProps) {
  const invalid = error !== undefined && error !== "";
  return (
    <FieldFrame id={id} label={label} help={help} error={error}>
      <input
        id={id}
        type={type}
        className={cn(CONTROL, "h-10", className)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy(id, help, error)}
        {...rest}
      />
    </FieldFrame>
  );
}

/** A password input with a reveal toggle next to its label. */
export function PasswordField({
  id,
  label,
  help,
  error,
  className,
  ...rest
}: Omit<TextFieldProps, "type">) {
  const [shown, setShown] = useState(false);
  const invalid = error !== undefined && error !== "";
  const toggle = (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
      onClick={() => {
        setShown((value) => !value);
      }}
      aria-pressed={shown}
      aria-controls={id}
    >
      {shown ? (
        <EyeOff className="size-4" aria-hidden="true" />
      ) : (
        <Eye className="size-4" aria-hidden="true" />
      )}
      {shown ? "Hide" : "Show"}
    </button>
  );
  return (
    <FieldFrame
      id={id}
      label={label}
      help={help}
      error={error}
      trailing={toggle}
    >
      <input
        id={id}
        type={shown ? "text" : "password"}
        className={cn(CONTROL, "h-10 font-mono", className)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy(id, help, error)}
        {...rest}
      />
    </FieldFrame>
  );
}

export interface TextAreaFieldProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  id: string;
  label: string;
  help?: string | undefined;
  error?: string | undefined;
}

export function TextAreaField({
  id,
  label,
  help,
  error,
  className,
  ...rest
}: TextAreaFieldProps) {
  const invalid = error !== undefined && error !== "";
  return (
    <FieldFrame id={id} label={label} help={help} error={error}>
      <textarea
        id={id}
        className={cn(CONTROL, "min-h-28 py-2 font-mono text-sm", className)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy(id, help, error)}
        {...rest}
      />
    </FieldFrame>
  );
}
