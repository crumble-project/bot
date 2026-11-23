import { Predicate } from "effect";
import type { z } from "zod";

/** A zod parse failure, recognised by its `issues` rather than by `instanceof`. */
export type ZodParseError = {
  name: "ZodError";
  message: string;
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
};

/** Whether `error` is a zod failure: parse results and request handlers see it as `unknown`. */
export const isZodError = (error: unknown): error is ZodParseError =>
  Predicate.isObject(error) &&
  error["name"] === "ZodError" &&
  Array.isArray(error["issues"]);

/** Whether `value` is a zod schema: contracts hand their schemas over as parts of larger JSON types. */
export const isZodSchema = (value: unknown): value is z.ZodType =>
  Predicate.isObject(value) &&
  Predicate.isFunction(value["parse"]) &&
  Predicate.isFunction(value["safeParse"]);
