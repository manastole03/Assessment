import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  // Short titles get the display treatment; long ones (capability ids, run subjects) step down a size.
  const long = typeof title !== "string" || title.length > 28;
  return (
    <div className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-2.5">
        {eyebrow && <div className="label-caps text-sky-ink">{eyebrow}</div>}
        <h1 className={long ? "text-2xl leading-tight sm:text-[1.75rem]" : "text-4xl leading-[1.05] sm:text-[2.75rem]"}>
          {title}
        </h1>
        {description && (
          <div className="max-w-3xl text-[0.95rem] leading-relaxed font-light text-muted-foreground">{description}</div>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-10 text-center">
      <div className="text-muted-foreground [&_svg]:size-6">{icon}</div>
      <div className="font-medium">{title}</div>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <code className={`rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] ${className}`}>{children}</code>;
}
