import { Link } from "@tanstack/react-router";
import { Compass } from "lucide-react";
import { EmptyState } from "../components/ui/states";

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <EmptyState
        icon={<Compass className="size-6" aria-hidden="true" />}
        title="There is nothing here"
        description="The address does not match a page of this instance."
        action={
          <Link
            to="/"
            className="inline-flex h-10 items-center rounded-control bg-primary px-4 text-sm font-medium text-primary-fg no-underline"
          >
            Go to the fleet
          </Link>
        }
      />
    </div>
  );
}
