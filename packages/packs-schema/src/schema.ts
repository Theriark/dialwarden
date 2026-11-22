// The pack.json validator. Ajv turns pack.schema.json into plain code at
// build time (scripts/generate-validator.mjs), so the browser and the server
// run the same validator, with no Ajv and no eval at run time.
import validatePackSchema from "./generated/validate-pack.js";

interface SchemaError {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message?: string;
  readonly params: { readonly additionalProperty?: string };
}

type GeneratedValidator = ((data: unknown) => boolean) & {
  errors?: readonly SchemaError[] | null;
};

const validator = validatePackSchema as unknown as GeneratedValidator;

function describe(error: SchemaError): string {
  const where = error.instancePath === "" ? "pack" : error.instancePath;
  const extra = error.params.additionalProperty;
  const message = error.message ?? error.keyword;
  return extra === undefined
    ? `${where}: ${message}`
    : `${where}: ${message} (${extra})`;
}

/** Where a parsed pack.json breaks the JSON Schema; empty when it does not. */
export function schemaProblems(data: unknown): string[] {
  if (validator(data)) return [];
  return (validator.errors ?? []).map(describe);
}
