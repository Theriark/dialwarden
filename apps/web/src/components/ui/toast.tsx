// One toast region (bottom-right, bottom-centre on phones). Success toasts
// close after five seconds; error toasts stay until closed.
import * as T from "@radix-ui/react-toast";
import { CircleCheck, CircleX, Info, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { cn } from "../../lib/cn";
import { IconButton } from "./button";

export type ToastKind = "success" | "error" | "info";

export interface ToastInput {
  kind: ToastKind;
  title: string;
  description?: string | undefined;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastContextValue {
  push: (toast: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const VIEWPORT =
  "fixed bottom-4 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 flex-col gap-2 sm:right-4 sm:left-auto sm:translate-x-0";

function kindClass(kind: ToastKind): string {
  switch (kind) {
    case "success":
      return "border-success/40 text-success";
    case "error":
      return "border-error/40 text-error";
    default:
      return "border-info/40 text-info";
  }
}

function kindIcon(kind: ToastKind): ReactNode {
  const className = "mt-0.5 size-5 shrink-0";
  switch (kind) {
    case "success":
      return <CircleCheck className={className} aria-hidden="true" />;
    case "error":
      return <CircleX className={className} aria-hidden="true" />;
    default:
      return <Info className={className} aria-hidden="true" />;
  }
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((toast: ToastInput) => {
    const id = nextId;
    nextId += 1;
    setItems((current) => [...current, { ...toast, id }]);
  }, []);

  const remove = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const contextValue = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={contextValue}>
      <T.Provider swipeDirection="right" duration={5000}>
        {children}
        {items.map((item) => (
          <T.Root
            key={item.id}
            duration={item.kind === "error" ? Number.POSITIVE_INFINITY : 5000}
            onOpenChange={(open) => {
              if (!open) {
                remove(item.id);
              }
            }}
            className={cn(
              "flex items-start gap-3 rounded-card border bg-surface p-4 shadow-card",
              kindClass(item.kind),
            )}
          >
            {kindIcon(item.kind)}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <T.Title className="text-sm font-semibold text-fg">
                {item.title}
              </T.Title>
              {item.description !== undefined ? (
                <T.Description className="text-sm text-fg-muted">
                  {item.description}
                </T.Description>
              ) : null}
            </div>
            <T.Close asChild>
              <IconButton label="Close" className="-mt-1 -mr-1 size-8">
                <X className="size-4" aria-hidden="true" />
              </IconButton>
            </T.Close>
          </T.Root>
        ))}
        <T.Viewport className={VIEWPORT} />
      </T.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (value === null) {
    throw new Error("useToast needs a ToastProvider");
  }
  return value;
}
