// zod type provider for Fastify (dev-work-plan P1-A step 1): route schemas are
// zod schemas; requests are validated and responses serialised through them
// (unknown response fields are dropped, so nothing leaks by accident), and the
// OpenAPI 3.1 document is generated from them with z.toJSONSchema.
import type {
  FastifySchema,
  FastifySchemaCompiler,
  FastifySerializerCompiler,
  FastifyTypeProvider,
} from "fastify";
import { z } from "zod";

export interface ZodTypeProvider extends FastifyTypeProvider {
  validator: this["schema"] extends z.ZodType
    ? z.output<this["schema"]>
    : unknown;
  serializer: this["schema"] extends z.ZodType
    ? z.input<this["schema"]>
    : unknown;
}

function isZod(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

export const validatorCompiler: FastifySchemaCompiler<unknown> = (route) => {
  const schema = route.schema;
  if (!isZod(schema)) {
    throw new Error("route schemas must be zod schemas");
  }
  return (data: unknown) => {
    const result = schema.safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  };
};

export const serializerCompiler: FastifySerializerCompiler<unknown> = (
  route,
) => {
  const schema = route.schema;
  if (!isZod(schema)) {
    return (data: unknown) => JSON.stringify(data);
  }
  return (data: unknown) => JSON.stringify(schema.parse(data));
};

function toJsonSchema(schema: z.ZodType, io: "input" | "output"): unknown {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    unrepresentable: "any",
  }) as unknown as Record<string, unknown>;
  delete json["$schema"];
  return json;
}

const REQUEST_PARTS = ["body", "querystring", "params", "headers"];

/** @fastify/swagger transform: zod schemas to JSON Schema 2020-12. */
export function openApiTransform(input: { schema: unknown; url: string }): {
  schema: FastifySchema;
  url: string;
} {
  const { schema, url } = input;
  if (typeof schema !== "object" || schema === null) {
    return { schema: {}, url };
  }
  const out = new Map<string, unknown>();
  for (const [part, value] of Object.entries(schema)) {
    if (REQUEST_PARTS.includes(part) && isZod(value)) {
      out.set(part, toJsonSchema(value, "input"));
    } else if (part === "response" && typeof value === "object" && value) {
      const responses = new Map<string, unknown>();
      for (const [code, response] of Object.entries(value)) {
        const converted = isZod(response)
          ? toJsonSchema(response, "output")
          : response;
        responses.set(code, converted);
      }
      out.set(part, Object.fromEntries(responses));
    } else {
      out.set(part, value);
    }
  }
  return { schema: Object.fromEntries(out) as FastifySchema, url };
}
