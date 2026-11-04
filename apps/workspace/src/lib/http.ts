import { aiScope } from "./ai-meter";
import { HttpError } from "./auth";

/** Route handler wrapper: HttpError -> JSON reply. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response) {
  return async (...args: A): Promise<Response> => {
    try {
      return await aiScope(() => fn(...args));
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message, ...(e.extra ?? {}) }, { status: e.status });
      console.error(e);
      return Response.json({ error: "Something went wrong." }, { status: 500 });
    }
  };
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  return (await req.json().catch(() => ({}))) as T;
}

export const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export function bad(msg: string): never {
  throw new HttpError(400, msg);
}
export function notFound(): never {
  throw new HttpError(404, "Not found");
}
