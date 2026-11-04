import RolesAdmin from "@/components/iotx/RolesAdmin";
import { getBrand } from "@/lib/brand";

/** Settings → Roles & permissions: the same screen as Admin · Roles in the IOTx Suite shell. */
export default function SettingsRolesPage() {
  const brand = getBrand();
  return (
    <section>
      <h2 className="text-base font-semibold">Roles &amp; permissions</h2>
      <p className="mb-4 mt-1 text-sm" style={{ color: "var(--muted)" }}>
        What each role can do in every {brand.name} app, including the Builder switch. Also in the {brand.name} shell under{" "}
        <a href="/admin/roles" className="underline">
          Admin · Roles
        </a>
        .
      </p>
      <div className="ix overflow-hidden rounded-2xl border">
        <RolesAdmin />
      </div>
    </section>
  );
}
