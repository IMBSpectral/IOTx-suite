import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./db";
import { PROJECTS_ROOT } from "./paths";

/**
 * In-product surveys and announcements.
 *
 * A survey is asked once per person, only after they've used Forge enough to
 * have an opinion (a few messages to the agent); answering or dismissing both count.
 * Announcements come from _forge/announcements.json (edited by whoever runs
 * Forge), shown while their dates are current, newest first.
 */
export const SURVEY = {
  id: "nps-2026-10",
  // {brand} is filled in with the product name when the survey is served.
  question: "How likely are you to recommend {brand} to a friend or colleague?",
  followUp: "What's the main reason for your score?",
  minMessages: 3,
};

export async function surveyDue(userId: string) {
  const [answered, sent] = await Promise.all([
    db.surveyResponse.findUnique({ where: { userId_surveyId: { userId, surveyId: SURVEY.id } } }),
    db.message.count({ where: { userId, role: "USER" } }),
  ]);
  return !answered && sent >= SURVEY.minMessages;
}

export class SurveyError extends Error {}

export async function answerSurvey(userId: string, input: { score?: number | null; answer?: string; dismissed?: boolean }) {
  const dismissed = !!input.dismissed;
  const score = input.score ?? null;
  if (!dismissed && (score === null || !Number.isInteger(score) || score < 0 || score > 10)) throw new SurveyError("Pick a score from 0 to 10.");
  try {
    await db.surveyResponse.create({
      data: { userId, surveyId: SURVEY.id, score: dismissed ? null : score, answer: dismissed ? null : (input.answer ?? "").trim().slice(0, 2000) || null, dismissed },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new SurveyError("Already answered.");
    throw e;
  }
}

export type Announcement = { id: string; title: string; body: string; href?: string; startsAt?: string; endsAt?: string; countdown?: boolean; scope?: "workspace" };

const FILE = path.join(PROJECTS_ROOT, "_forge", "announcements.json");

export async function readAnnouncements(file = FILE): Promise<Announcement[]> {
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as Announcement[];
    return Array.isArray(list) ? list.filter((a) => a && typeof a.id === "string" && typeof a.title === "string") : [];
  } catch {
    return [];
  }
}

/** Replace the announcements file (written atomically, so readers never see half a file). */
export async function writeAnnouncements(list: Announcement[], file = FILE) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(list, null, 2));
  await fs.rename(tmp, file);
}

/** Announcements that are live now, newest start first. */
export function activeAnnouncements(list: Announcement[], now = new Date()) {
  return list
    .filter((a) => (!a.startsAt || new Date(a.startsAt) <= now) && (!a.endsAt || new Date(a.endsAt) > now))
    .sort((a, b) => (b.startsAt ?? "").localeCompare(a.startsAt ?? ""));
}
