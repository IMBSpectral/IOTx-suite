import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { getBrand, setBrand, type Brand } from "@/lib/brand";

/**
 * The platform brand.
 *   GET        -> { brand } (public: sign-in and home pages need it)
 *   POST json  -> platform admins save name, short name, mark, tagline, company, support email, colours
 */
async function GET_() {
  return Response.json({ brand: getBrand() });
}

async function POST_(req: Request) {
  const user = await requireUser();
  if (!isPlatformAdmin(user.email)) return Response.json({ error: "Only platform admins can change branding." }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Partial<Brand>;
  const { logo: _ignored, ...patch } = body;
  return Response.json({ brand: await setBrand(patch) });
}

export const GET = route(GET_);
export const POST = route(POST_);
