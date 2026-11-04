import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { getBrand } from "@/lib/brand";
import { requireUser, requireProject } from "@/lib/workspace";
import { listFiles, readFile } from "@/lib/repo";
import { buildDir } from "@/lib/paths";
import { decorateHtml, seoForPath, type Seo } from "@/lib/publish";
import { route } from "@/lib/route";

const NGINX = `server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;
  # Fingerprinted assets never change.
  location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; try_files $uri =404; }
  # Client-side routes all load the app shell.
  location / { add_header Cache-Control "no-cache"; try_files $uri $uri/ /index.html; }
}
`;
const DOCKERFILE = `FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/ /usr/share/nginx/html/
EXPOSE 80
`;
const readme = (name: string) => `# ${name}: self-hosting

This is the published build of your app: static files in \`dist/\`, ready for any host.

## With Docker

    docker build -t ${name} .
    docker run -p 8080:80 ${name}

Then open http://localhost:8080.

## On a static host (Netlify, Vercel, S3, Cloudflare Pages, nginx…)

Upload the contents of \`dist/\` and send every path that isn't a file to \`/index.html\`,
so links to pages inside the app work (nginx.conf shows how).

Apps that use ${getBrand().shortName} Cloud (accounts, database, functions) still call ${getBrand().name} for those.
Republish in ${getBrand().name} and download again to update.
`;

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, base)));
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

/**
 * Download the project: its source as a zip, or with ?target=selfhost the
 * published build ready to host anywhere ("Where should your app run?").
 */
async function GET_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id);
  const zip = new JSZip();
  let filename = `${project.slug}.zip`;

  if (new URL(req.url).searchParams.get("target") === "selfhost") {
    if (!project.publishedSha)
      return Response.json(
        {
          error: "Publish the app first: the download is its published build.",
        },
        { status: 409 },
      );
    const root = buildDir(id, project.publishedSha);
    const files = await walk(root).catch(() => null);
    if (!files?.length)
      return Response.json(
        {
          error:
            "The published build is missing. Republish, then download again.",
        },
        { status: 409 },
      );
    for (const f of files) {
      const bytes = await fs.readFile(path.join(root, f));
      // The shell carries the site's title, description and share image, as when Forge serves it.
      zip.file(
        `dist/${f}`,
        f === "index.html"
          ? decorateHtml(
              bytes.toString("utf8"),
              seoForPath((project.seo as Seo | null) ?? {}, "/"),
              {
                badge: project.showBadge,
                editorUrl: `${process.env.EDITOR_ORIGIN ?? "http://localhost:3000"}/projects/${id}`,
              },
            )
          : bytes,
      );
    }
    zip.file("Dockerfile", DOCKERFILE);
    zip.file("nginx.conf", NGINX);
    zip.file("README.md", readme(project.slug));
    filename = `${project.slug}-site.zip`;
  } else {
    const files = await listFiles(id);
    for (const file of files) {
      try {
        zip.file(file, await readFile(id, file));
      } catch {
        // A file listed in the index but missing on disk is not worth failing on.
      }
    }
    // Very old projects have no manifest; give them a minimal one so they still run.
    if (!files.includes("package.json")) {
      zip.file(
        "package.json",
        JSON.stringify(
          {
            name: project.slug,
            private: true,
            type: "module",
            scripts: {
              dev: "vite",
              build: "vite build",
              preview: "vite preview",
            },
            dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
            devDependencies: {
              vite: "^5.4.10",
              "@vitejs/plugin-react": "^4.3.3",
              typescript: "^5.6.3",
            },
          },
          null,
          2,
        ),
      );
    }
    if (!files.some((f) => /^vite\.config\.(ts|js|mjs)$/.test(f))) {
      zip.file(
        "vite.config.ts",
        `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n`,
      );
    }
  }

  const bytes = await zip.generateAsync({ type: "arraybuffer" });
  return new Response(bytes, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
      "content-length": String(bytes.byteLength),
    },
  });
}

export const GET = route(GET_);
