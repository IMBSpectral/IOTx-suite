import ConnectorsPanel from "@/components/ConnectorsPanel";
import ConnectorApproval from "@/components/ConnectorApproval";
import ToolPermissions from "@/components/ToolPermissions";
import ConnectorUsage from "@/components/ConnectorUsage";
import { getBrand } from "@/lib/brand";

export default function ConnectorsPage() {
  const brand = getBrand();
  return (
    <div>
      <p className="mb-5 text-sm" style={{ color: "var(--muted)" }}>
        Give {brand.shortName} context from the tools you use every day. Connections here are shared across the workspace&apos;s
        projects; sharing a project with someone outside the workspace doesn&apos;t share its connections.
      </p>
      <ConnectorApproval />
      <ConnectorsPanel />
      <ToolPermissions />
      <ConnectorUsage />
    </div>
  );
}
