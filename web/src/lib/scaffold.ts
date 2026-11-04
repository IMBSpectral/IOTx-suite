/**
 * The starter project every new app begins from.
 *
 * Its stack mirrors what Lovable's generated apps ship, as observed by
 * fingerprinting a production build of one: React with react-router, Radix
 * primitives styled as shadcn/ui components, React Query, lucide icons, sonner
 * toasts, class-variance-authority, and Tailwind with CSS-variable design
 * tokens. Output quality depends heavily on this: the model composes these
 * primitives rather than hand-rolling every control.
 *
 * Generated file contents are embedded in template literals, so they must not
 * contain backticks or dollar-brace sequences of their own.
 */
export function scaffold(name: string): { path: string; content: string }[] {
  const safe = name.replace(/[<>&"]/g, "").slice(0, 60) || "App";

  return [
    {
      path: "package.json",
      content:
        JSON.stringify(
          {
            name: "app",
            private: true,
            version: "0.0.0",
            type: "module",
            scripts: {
              dev: "vite",
              build: "vite build",
              preview: "vite preview",
              test: "vitest run",
            },
            dependencies: {
              "@radix-ui/react-label": "2.1.0",
              "@radix-ui/react-slot": "1.1.0",
              "@tanstack/react-query": "5.59.20",
              "class-variance-authority": "0.7.1",
              clsx: "2.1.1",
              "lucide-react": "0.462.0",
              react: "18.3.1",
              "react-dom": "18.3.1",
              "react-router-dom": "6.28.0",
              sonner: "1.7.0",
              "tailwind-merge": "2.5.5",
              "tailwindcss-animate": "1.0.7",
            },
            devDependencies: {
              "@types/node": "22.9.0",
              "@types/react": "18.3.12",
              "@types/react-dom": "18.3.1",
              "@vitejs/plugin-react": "4.3.3",
              autoprefixer: "10.4.20",
              postcss: "8.4.49",
              tailwindcss: "3.4.17",
              typescript: "5.6.3",
              vite: "5.4.11",
              vitest: "2.1.8",
            },
          },
          null,
          2,
        ) + "\n",
    },
    {
      path: ".gitignore",
      content: "node_modules\ndist\n.builds\n.env\n",
    },
    {
      path: "vite.config.ts",
      content: `import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only: lets the editor highlight and select elements in the preview.
// It is not applied to builds, so it never ships with the app.
const editorBridge = {
  name: "editor-bridge",
  apply: "serve" as const,
  transformIndexHtml(html: string) {
    const origin = process.env.EDITOR_ORIGIN || "http://localhost:3000";
    return html.replace(
      "</body>",
      '<script src="' + origin + '/inspector.js"></script></body>',
    );
  },
};

export default defineConfig({
  plugins: [react(), editorBridge],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    host: true,
    // The editor frames this origin directly, so the default HMR transport
    // works as-is. Polling is required because the project is a bind mount:
    // inotify does not see host writes from inside the container.
    allowedHosts: true,
    watch: { usePolling: true, interval: 300 },
  },
});
`,
    },
    {
      path: "tsconfig.json",
      content:
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2020",
              useDefineForClassFields: true,
              lib: ["ES2020", "DOM", "DOM.Iterable"],
              module: "ESNext",
              skipLibCheck: true,
              moduleResolution: "bundler",
              allowImportingTsExtensions: true,
              resolveJsonModule: true,
              isolatedModules: true,
              noEmit: true,
              jsx: "react-jsx",
              strict: false,
              baseUrl: ".",
              paths: { "@/*": ["./src/*"] },
            },
            include: ["src"],
          },
          null,
          2,
        ) + "\n",
    },
    {
      path: "postcss.config.js",
      content: `export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
`,
    },
    {
      path: "tailwind.config.ts",
      content: `import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "2rem", screens: { "2xl": "1400px" } },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        chart: { 1: "hsl(var(--chart-1))", 2: "hsl(var(--chart-2))", 3: "hsl(var(--chart-3))", 4: "hsl(var(--chart-4))", 5: "hsl(var(--chart-5))" },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
`,
    },
    {
      path: "index.html",
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safe}</title>
    <meta name="description" content="${safe}" />
    <meta property="og:title" content="${safe}" />
    <meta property="og:description" content="${safe}" />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    },
    {
      path: "src/index.css",
      content: `@tailwind base;
@tailwind components;
@tailwind utilities;

/* Design tokens. Components read colours from these variables, so the whole
   app is re-themed by editing this block rather than individual classes. */
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222 47% 11%;
    --card: 0 0% 100%;
    --card-foreground: 222 47% 11%;
    --popover: 0 0% 100%;
    --popover-foreground: 222 47% 11%;
    --primary: 222 47% 11%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96%;
    --secondary-foreground: 222 47% 11%;
    --muted: 210 40% 96%;
    --muted-foreground: 215 16% 47%;
    --accent: 210 40% 96%;
    --accent-foreground: 222 47% 11%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 210 40% 98%;
    --border: 214 32% 91%;
    --input: 214 32% 91%;
    --ring: 222 47% 11%;
    --radius: 0.5rem;
    /* Chart series, in order (recharts: stroke="hsl(var(--chart-1))"). */
    --chart-1: 221 83% 53%;
    --chart-2: 160 60% 40%;
    --chart-3: 32 95% 52%;
    --chart-4: 280 65% 58%;
    --chart-5: 346 77% 55%;
  }

  .dark {
    --background: 222 47% 11%;
    --foreground: 210 40% 98%;
    --card: 222 47% 11%;
    --card-foreground: 210 40% 98%;
    --popover: 222 47% 11%;
    --popover-foreground: 210 40% 98%;
    --primary: 210 40% 98%;
    --primary-foreground: 222 47% 11%;
    --secondary: 217 33% 17%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217 33% 17%;
    --muted-foreground: 215 20% 65%;
    --accent: 217 33% 17%;
    --accent-foreground: 210 40% 98%;
    --destructive: 0 63% 31%;
    --destructive-foreground: 210 40% 98%;
    --border: 217 33% 17%;
    --input: 217 33% 17%;
    --ring: 213 27% 84%;
    --chart-1: 217 91% 65%;
    --chart-2: 160 60% 50%;
    --chart-3: 32 95% 60%;
    --chart-4: 280 70% 70%;
    --chart-5: 346 80% 65%;
  }

  * {
    @apply border-border;
  }

  body {
    @apply bg-background text-foreground antialiased;
  }
}

@layer components {
  /* Frosted glass for floating layers (navbars, sheets, cards over a hero).
     Put it over colour or an image; it falls back to a solid surface where
     blur isn't supported or the user asked for less transparency. */
  .glass {
    @apply border border-white/20 bg-white/10 shadow-lg backdrop-blur-xl backdrop-saturate-150 dark:border-white/10 dark:bg-white/5;
  }
  @supports not (backdrop-filter: blur(1px)) {
    .glass { @apply bg-card/95; }
  }
  @media (prefers-reduced-transparency: reduce) {
    .glass { @apply bg-card backdrop-blur-none; }
  }
}
`,
    },
    {
      path: "src/lib/utils.ts",
      content: `import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge class names, letting later Tailwind classes override earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`,
    },
    {
      path: "src/components/ui/button.tsx",
      content: `import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
`,
    },
    {
      path: "src/components/ui/card.tsx",
      content: `import * as React from "react";
import { cn } from "@/lib/utils";

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("rounded-lg border bg-card text-card-foreground shadow-sm", className)} {...props} />
  ),
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />
  ),
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn("text-2xl font-semibold leading-none tracking-tight", className)} {...props} />
  ),
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  ),
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />,
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
  ),
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
`,
    },
    {
      path: "src/components/ui/input.tsx",
      content: `import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
`,
    },
    {
      path: "src/components/ui/label.tsx",
      content: `import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn("text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70", className)}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
`,
    },
    {
      path: "src/components/ui/badge.tsx",
      content: `import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
`,
    },
    {
      path: "src/components/ui/sonner.tsx",
      content: `import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = (props: ToasterProps) => (
  <Sonner
    className="toaster group"
    toastOptions={{
      classNames: {
        toast: "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
        description: "group-[.toast]:text-muted-foreground",
        actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
        cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
      },
    }}
    {...props}
  />
);

export { Toaster, toast };
`,
    },
    {
      path: "src/main.tsx",
      content: `import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
`,
    },
    {
      path: "src/App.tsx",
      content: `import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <Toaster />
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Index />} />
        {/* Add routes above the catch-all. */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>
);

export default App;
`,
    },
    {
      path: "src/pages/Index.tsx",
      content: `const Index = () => (
  <main className="flex min-h-screen items-center justify-center bg-background p-6">
    <div className="max-w-md text-center">
      <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">New project</p>
      <h1 className="mt-3 text-4xl font-bold tracking-tight">${safe}</h1>
      <p className="mt-3 text-lg text-muted-foreground">
        Describe what you want to build and this page will be replaced with it.
      </p>
    </div>
  </main>
);

export default Index;
`,
    },
    {
      path: "src/pages/NotFound.tsx",
      content: `import { Link } from "react-router-dom";

const NotFound = () => (
  <main className="flex min-h-screen items-center justify-center bg-muted">
    <div className="text-center">
      <h1 className="mb-4 text-4xl font-bold">404</h1>
      <p className="mb-4 text-xl text-muted-foreground">Oops! Page not found</p>
      <Link to="/" className="text-primary underline hover:no-underline">
        Return to Home
      </Link>
    </div>
  </main>
);

export default NotFound;
`,
    },
  ];
}
