import { db } from "./db";
import { commit, readFile, writeFiles } from "./repo";

/**
 * Canvas projects: a whiteboard for sketching screens and flows before (or
 * instead of) building. The drawing lives in canvas.json in the project's
 * repo, so it has history like everything else.
 */

export type Shape =
  | {
      id: string;
      type: "rect" | "ellipse";
      x: number;
      y: number;
      w: number;
      h: number;
      stroke: string;
      fill: string;
      /** A frame linked to a component in an app ("mockupComponentPath"). */
      mockup?: Mockup;
    }
  | {
      id: string;
      type: "line" | "arrow";
      x: number;
      y: number;
      x2: number;
      y2: number;
      stroke: string;
    }
  | { id: string; type: "draw"; points: [number, number][]; stroke: string }
  | {
      id: string;
      type: "text";
      x: number;
      y: number;
      text: string;
      size: number;
      stroke: string;
    };

export type Mockup = { projectId: string; path: string };
export type CanvasDoc = { version: 1; shapes: Shape[] };

const mockupOf = (m: unknown): Mockup | undefined => {
  const v = m as Mockup | undefined;
  return v &&
    typeof v.projectId === "string" &&
    /^[\w-]{8,64}$/.test(v.projectId) &&
    typeof v.path === "string" &&
    /^src\/[\w\-/.]+\.(tsx|jsx)$/.test(v.path) &&
    !v.path.includes("..")
    ? { projectId: v.projectId, path: v.path }
    : undefined;
};

export const EMPTY_CANVAS: CanvasDoc = { version: 1, shapes: [] };

export class CanvasError extends Error {}

export async function initCanvas(projectId: string) {
  await writeFiles(projectId, [
    { path: "canvas.json", content: JSON.stringify(EMPTY_CANVAS) },
  ]);
  const sha = await commit(projectId, "Create canvas");
  await db.project.update({
    where: { id: projectId },
    data: { kind: "canvas", headSha: sha },
  });
}

export async function readCanvas(projectId: string): Promise<CanvasDoc> {
  const raw = await readFile(projectId, "canvas.json").catch(() => null);
  return raw ? (JSON.parse(raw) as CanvasDoc) : EMPTY_CANVAS;
}

const NUM = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e6;

/** Keep only well-formed shapes, so a bad client can't store junk. */
export function cleanCanvas(doc: unknown): CanvasDoc {
  const shapes = Array.isArray((doc as CanvasDoc)?.shapes)
    ? (doc as CanvasDoc).shapes
    : [];
  if (shapes.length > 5000)
    throw new CanvasError("A canvas can hold up to 5,000 shapes.");
  const color = (c: unknown) =>
    typeof c === "string" && /^(#[0-9a-f]{3,8}|transparent|none)$/i.test(c)
      ? c
      : "#16141f";
  const out: Shape[] = [];
  for (const s of shapes) {
    const id =
      typeof s?.id === "string"
        ? s.id.slice(0, 40)
        : Math.random().toString(36).slice(2);
    if (
      (s.type === "rect" || s.type === "ellipse") &&
      [s.x, s.y, s.w, s.h].every(NUM)
    ) {
      const mockup = s.type === "rect" ? mockupOf(s.mockup) : undefined;
      out.push({
        id,
        type: s.type,
        x: s.x,
        y: s.y,
        w: s.w,
        h: s.h,
        stroke: color(s.stroke),
        fill: color(s.fill),
        ...(mockup ? { mockup } : {}),
      });
    } else if (
      (s.type === "line" || s.type === "arrow") &&
      [s.x, s.y, s.x2, s.y2].every(NUM)
    ) {
      out.push({
        id,
        type: s.type,
        x: s.x,
        y: s.y,
        x2: s.x2,
        y2: s.y2,
        stroke: color(s.stroke),
      });
    } else if (
      s.type === "draw" &&
      Array.isArray(s.points) &&
      s.points.length <= 5000 &&
      s.points.every((p) => Array.isArray(p) && NUM(p[0]) && NUM(p[1]))
    ) {
      out.push({
        id,
        type: "draw",
        points: s.points.map((p) => [p[0], p[1]] as [number, number]),
        stroke: color(s.stroke),
      });
    } else if (
      s.type === "text" &&
      NUM(s.x) &&
      NUM(s.y) &&
      typeof s.text === "string"
    ) {
      out.push({
        id,
        type: "text",
        x: s.x,
        y: s.y,
        text: s.text.slice(0, 2000),
        size: NUM(s.size) ? Math.min(200, Math.max(8, s.size)) : 18,
        stroke: color(s.stroke),
      });
    }
  }
  return { version: 1, shapes: out };
}

export async function saveCanvas(projectId: string, doc: unknown) {
  const clean = cleanCanvas(doc);
  await writeFiles(projectId, [
    { path: "canvas.json", content: JSON.stringify(clean) },
  ]);
  const sha = await commit(projectId, "Update canvas");
  await db.project.update({
    where: { id: projectId },
    data: { headSha: sha, updatedAt: new Date() },
  });
  return clean;
}
