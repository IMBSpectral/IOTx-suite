import { redirect } from "next/navigation";

/**
 * The suite opens at its sign-in page (which sends signed-in people on to
 * their home). The public intro site is its own project: apps/site.
 */
export default function Root() {
  redirect("/login");
}
