import { Prisma } from "@prisma/client";
import { db } from "./db";
import { CATEGORIES } from "./templates";

/**
 * A workspace template's gallery profile ("project profile listing"): how it
 * shows in Templates. Made, edited or removed from the gallery; removing it
 * also takes the project out of the gallery.
 */
export type Listing = {
  tagline: string;
  about: string;
  category: string;
  icon: string;
  publisherType: "individual" | "team" | "company";
  hidePreview: boolean;
};

export class ListingError extends Error {}

export function cleanListing(raw: unknown): Listing {
  const o = (raw ?? {}) as Record<string, unknown>;
  const s = (k: string, max: number) => (typeof o[k] === "string" ? (o[k] as string).trim().slice(0, max) : "");
  const tagline = s("tagline", 90);
  if (!tagline) throw new ListingError("Add a tagline: one line on what the template is.");
  const category = s("category", 40);
  if (category && !(CATEGORIES as string[]).includes(category) && category !== "Other") throw new ListingError("Pick a category from the list.");
  const publisherType = o.publisherType === "company" || o.publisherType === "team" ? o.publisherType : "individual";
  const icon = s("icon", 8);
  return { tagline, about: s("about", 2000), category: category || "Other", icon, publisherType, hidePreview: o.hidePreview === true };
}

export async function saveListing(projectId: string, raw: unknown) {
  const listing = cleanListing(raw);
  // A listing puts the project in the gallery.
  await db.project.update({ where: { id: projectId }, data: { listing, isTemplate: true } });
  return listing;
}

export async function removeListing(projectId: string) {
  await db.project.update({ where: { id: projectId }, data: { listing: Prisma.DbNull, isTemplate: false } });
}
