import { Predicate } from "effect";
import type { z } from "zod";

export type ZodParseError = {
  name: "ZodError";
  message: string;
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
};

export const isZodError = (error: unknown): error is ZodParseError =>
  Predicate.isObject(error) &&
  error["name"] === "ZodError" &&
  Array.isArray(error["issues"]);

export const isZodSchema = (value: unknown): value is z.ZodType =>
  Predicate.isObject(value) &&
  Predicate.isFunction(value["parse"]) &&
  Predicate.isFunction(value["safeParse"]);
