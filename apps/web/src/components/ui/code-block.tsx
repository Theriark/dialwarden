import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";

interface CopyButtonProps {
  value: string;
  label?: string | undefined;
  className?: string | undefined;
}

export function CopyButton({
  value,
  label = "Copy",
  className,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Button
      size="md"
      className={className}
      onClick={() => {
        void copy();
      }}
      icon={
        copied ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )
      }
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

interface CodeBlockProps {
  value: string;
  label: string;
  copy?: boolean | undefined;
  className?: string | undefined;
}

/** Monospace text (fingerprints, secrets shown once) with an optional copy. */
export function CodeBlock({
  value,
  label,
  copy = true,
  className,
}: CodeBlockProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-control border border-border-strong bg-bg p-3",
        className,
      )}
    >
      <pre
        aria-label={label}
        className="m-0 min-w-0 flex-1 font-mono text-sm break-all whitespace-pre-wrap text-fg"
      >
        {value}
      </pre>
      {copy ? <CopyButton value={value} /> : null}
    </div>
  );
}
