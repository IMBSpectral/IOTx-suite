import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";
import { answerSurvey, SURVEY, SurveyError, surveyDue } from "@/lib/engagement";
import { getBrand } from "@/lib/brand";

/** The survey to show this person now, if any. */
async function GET_() {
  const user = await requireUser();
  return Response.json({ survey: (await surveyDue(user.id)) ? { ...SURVEY, question: SURVEY.question.replace("{brand}", getBrand().name) } : null });
}

/** Answer (score 0–10 and an optional comment) or dismiss. */
async function POST_(req: Request) {
  const user = await requireUser();
  const body = (await req.json().catch(() => ({}))) as { score?: number; answer?: string; dismissed?: boolean };
  try {
    await answerSurvey(user.id, body);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof SurveyError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
