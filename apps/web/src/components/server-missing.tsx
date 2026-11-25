// A server address that answers 404 server_not_found (P8 live check F3): the
// server does not exist, or it is not granted to the signed-in editor or
// viewer, and the server answers the same way for both so nobody learns which
// slugs exist. Retrying cannot help, so the state offers the way back to the
// fleet instead.
import { Link } from "@tanstack/react-router";
import { ServerOff } from "lucide-react";
import { ApiError } from "../api/client";
import { EmptyState } from "./ui/states";

/** True for the answer that says this slug is not in the caller's fleet. */
export function isServerMissing(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    error.code === "server_not_found"
  );
}

export function ServerMissingState() {
  return (
    <div className="mx-auto max-w-lg py-8">
      <EmptyState
        icon={<ServerOff className="size-6" aria-hidden="true" />}
        title="This server is not in your fleet"
        description="It does not exist, or it is not granted to you. The owner or an admin grants servers to editors and viewers."
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
