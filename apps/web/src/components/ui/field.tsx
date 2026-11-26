// Form controls: a label, the control, help text and the inline error, wired
// with aria-describedby and aria-invalid (design-direction-1 part 4). A
// warning (a lint of severity warning, phase-report-07 F-P7-2) sits under the
// control in the warning colour with its own icon: the value is accepted,
// so the control is not marked invalid and the text is a status, not an
// alert.
import * as Label from "@radix-ui/react-label";
import { CircleX, Eye, EyeOff, TriangleAlert } from "lucide-react";
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
  warning?: string | undefined;
  /** Something next to the label, such as a reveal toggle. */
  trailing?: ReactNode;
  children: ReactNode;
}

function present(text: string | undefined): text is string {
  return text !== undefined && text !== "";
}

export function describedBy(
  id: string,
  help: string | undefined,
  error: string | undefined,
  warning?: string | undefined,
): string | undefined {
  const ids: string[] = [];
  if (present(error)) {
    ids.push(`${id}-error`);
  }
  if (present(warning)) {
    ids.push(`${id}-warning`);
  }
  if (present(help)) {
    ids.push(`${id}-help`);
  }
  return ids.length === 0 ? undefined : ids.join(" ");
}

export function FieldFrame({
  id,
  label,
  help,
  error,
  warning,
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
      {present(error) ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="flex items-center gap-1.5 text-sm text-error"
        >
          <CircleX className="size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}
      {present(warning) ? (
        <p
          id={`${id}-warning`}
          role="status"
          className="flex items-center gap-1.5 text-sm text-warning"
        >
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
          {warning}
        </p>
      ) : null}
      {present(help) ? (
        <p id={`${id}-help`} className="text-sm text-fg-muted">
          {help}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "id"
> {
  id: string;
  label: string;
  help?: string | undefined;
  error?: string | undefined;
  warning?: string | undefined;
}

export function TextField({
  id,
  label,
  help,
  error,
  warning,
  className,
  type = "text",
  ...rest
}: TextFieldProps) {
  const invalid = present(error);
  return (
    <FieldFrame
      id={id}
      label={label}
      help={help}
      error={error}
      warning={warning}
    >
      <input
        id={id}
        type={type}
        className={cn(CONTROL, "h-10", className)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy(id, help, error, warning)}
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
  warning,
  className,
  ...rest
}: Omit<TextFieldProps, "type">) {
  const [shown, setShown] = useState(false);
  const invalid = present(error);
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
      warning={warning}
      trailing={toggle}
    >
      <input
        id={id}
        type={shown ? "text" : "password"}
        className={cn(CONTROL, "h-10 font-mono", className)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy(id, help, error, warning)}
        {...rest}
      />
    </FieldFrame>
  );
}

export interface TextAreaFieldProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "id"
> {
  id: string;
  label: string;
  help?: string | undefined;
  error?: string | undefined;
  warning?: string | undefined;
}

export function TextAreaField({
  id,
  label,
  help,
  error,
  warning,
  className,
  ...rest
}: TextAreaFieldProps) {
  const invalid = present(error);
  return (
    <FieldFrame
      id={id}
      label={label}
      help={help}
      error={error}
      warning={warning}
    >
      <textarea
        id={id}
        className={cn(CONTROL, "min-h-28 py-2 font-mono text-sm", className)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy(id, help, error, warning)}
        {...rest}
      />
    </FieldFrame>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  id: string;
  label: string;
  help?: string | undefined;
  error?: string | undefined;
  warning?: string | undefined;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  /**
   * The first option, with the empty value, shown while nothing is chosen
   * yet: the select never shows a server its state does not hold (live
   * check F12).
   */
  placeholder?: string | undefined;
}

/** A labelled select, wired like the text fields. */
export function SelectField({
  id,
  label,
  help,
  error,
  warning,
  value,
  options,
  onChange,
  disabled = false,
  placeholder,
}: SelectFieldProps) {
  const invalid = present(error);
  return (
    <FieldFrame
      id={id}
      label={label}
      help={help}
      error={error}
      warning={warning}
    >
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={cn(CONTROL, "h-10 disabled:opacity-60")}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy(id, help, error, warning)}
      >
        {placeholder === undefined ? null : (
          <option value="">{placeholder}</option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldFrame>
  );
}
