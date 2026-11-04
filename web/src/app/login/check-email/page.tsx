import { redirect } from "next/navigation";

/** Where Auth.js sends people after an emailed sign-in link is sent. */
export default function CheckEmail() {
  redirect("/login?check=email");
}
