// The first-run import streams the export file as the request body, with the
// passphrase and the setup token in headers (routes/auth.ts). XMLHttpRequest
// is used only here, for the upload progress fetch does not report.
import { isPrintableAscii } from "../lib/passphrase";
import { ApiError } from "./client";
import type { ApiErrorBody, ImportResult } from "./schema";

/** The server's validation answer, for a passphrase a header cannot hold. */
function passphraseRefused(): ApiError {
  return new ApiError(400, {
    error: "validation",
    issues: [
      { path: "passphrase", message: "printable ASCII characters only" },
    ],
  });
}

export function uploadImport(
  file: File,
  passphrase: string,
  setupToken: string,
  onProgress: (fraction: number) => void,
): Promise<ImportResult> {
  return new Promise((resolve, reject) => {
    if (!isPrintableAscii(passphrase)) {
      reject(passphraseRefused());
      return;
    }
    const request = new XMLHttpRequest();
    request.open("POST", "/api/v1/setup/import");
    request.setRequestHeader("content-type", "application/octet-stream");
    request.setRequestHeader("accept", "application/json");
    request.setRequestHeader("x-dialwarden-passphrase", passphrase);
    request.setRequestHeader("x-dialwarden-setup-token", setupToken);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    });
    request.addEventListener("error", () => {
      reject(new ApiError(0, null));
    });
    request.addEventListener("load", () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(request.responseText) as unknown;
      } catch {
        parsed = null;
      }
      if (request.status >= 200 && request.status < 300) {
        resolve(parsed as ImportResult);
        return;
      }
      const body =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          ? (parsed as ApiErrorBody)
          : null;
      reject(new ApiError(request.status, body));
    });
    request.send(file);
  });
}
