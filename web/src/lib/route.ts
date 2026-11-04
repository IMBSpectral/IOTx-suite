import { aiScope } from "./ai-meter";

/**
 * Route handler wrapper. Auth helpers throw a Response (401/403/404); Next
 * would turn that into a 500, so hand it back as the reply instead.
 */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response) {
  return async (...args: A): Promise<Response> => {
    try {
      return await aiScope(() => fn(...args));
    } catch (e) {
      if (e instanceof Response) return e;
      throw e;
    }
  };
}
