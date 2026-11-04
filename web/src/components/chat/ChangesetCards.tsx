"use client";

import { useEffect, useState } from "react";
import ChangesetCard from "../ChangesetCard";
import type { Changeset } from "@/lib/marketing";
import type { Step } from "./types";

/** Ad changes the agent proposed in this reply, with their current state (approved, rejected, pending). */
export default function ChangesetCards({ projectId, steps }: { projectId: string; steps: Step[] }) {
  const ids = steps.filter((s): s is Extract<Step, { kind: "changeset" }> => s.kind === "changeset").map((s) => s.id);
  const key = ids.join(",");
  const [found, setFound] = useState<{ cs: Changeset; name?: string }[] | null>(null);

  useEffect(() => {
    if (!key) return;
    let live = true;
    fetch(`/api/projects/${projectId}/marketing`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { changesets: Changeset[]; campaigns: { id: string; name: string }[] } | null) => {
        if (!live || !d) return;
        const wanted = key.split(",");
        setFound(
          d.changesets
            .filter((c) => wanted.includes(c.id))
            .map((cs) => ({ cs, name: d.campaigns.find((c) => c.id === cs.campaignId)?.name })),
        );
      });
    return () => {
      live = false;
    };
  }, [projectId, key]);

  if (!found?.length) return null;
  return (
    <>
      {found.map(({ cs, name }) => (
        <ChangesetCard key={cs.id} projectId={projectId} changeset={cs} campaignName={name} />
      ))}
    </>
  );
}
