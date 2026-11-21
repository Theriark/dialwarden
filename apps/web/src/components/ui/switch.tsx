import * as S from "@radix-ui/react-switch";
import { cn } from "../../lib/cn";

interface SwitchFieldProps {
  id: string;
  label: string;
  description?: string | undefined;
  checked: boolean;
  disabled?: boolean | undefined;
  onCheckedChange: (checked: boolean) => void;
}

const TRACK =
  "relative h-6 w-11 shrink-0 rounded-full border border-border-strong bg-surface transition-colors duration-150 disabled:opacity-60 data-[state=checked]:border-primary data-[state=checked]:bg-primary";
const THUMB =
  "block size-4 translate-x-0.5 rounded-full bg-fg-muted transition-transform duration-150 data-[state=checked]:translate-x-5 data-[state=checked]:bg-primary-fg";

/** A labelled switch; the label and description are the accessible name. */
export function SwitchField({
  id,
  label,
  description,
  checked,
  disabled = false,
  onCheckedChange,
}: SwitchFieldProps) {
  const descriptionId = `${id}-description`;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {description !== undefined ? (
          <p id={descriptionId} className="text-sm text-fg-muted">
            {description}
          </p>
        ) : null}
      </div>
      <S.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-describedby={description !== undefined ? descriptionId : undefined}
        className={cn(TRACK)}
      >
        <S.Thumb className={THUMB} />
      </S.Root>
    </div>
  );
}
