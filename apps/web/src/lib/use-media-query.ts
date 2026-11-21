import { useCallback, useSyncExternalStore } from "react";

const noop = () => undefined;

/** True while the media query matches; false where matchMedia is missing. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") {
        return noop;
      }
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => {
        media.removeEventListener("change", onChange);
      };
    },
    [query],
  );
  const read = useCallback(() => {
    if (typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(query).matches;
  }, [query]);
  return useSyncExternalStore(subscribe, read, () => false);
}
