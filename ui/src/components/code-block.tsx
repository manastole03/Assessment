import { Check, Copy } from "lucide-react";
import { Highlight, type Language, type PrismTheme } from "prism-react-renderer";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// One syntax theme for both palettes: colours come from the theme tokens, so code follows light/dark.
const SIGNAL: PrismTheme = {
  plain: { color: "var(--foreground)", backgroundColor: "transparent" },
  styles: [
    { types: ["comment", "prolog", "doctype", "cdata"], style: { color: "var(--muted-foreground)", fontStyle: "italic" } },
    { types: ["punctuation", "operator"], style: { color: "var(--muted-foreground)" } },
    { types: ["property", "key", "atrule", "attr-name", "tag"], style: { color: "var(--foreground)", fontWeight: "600" } },
    {
      types: ["string", "char", "attr-value", "inserted"],
      style: { color: "color-mix(in oklch, var(--foreground) 72%, var(--muted-foreground))" },
    },
    {
      types: ["number", "boolean", "constant", "null", "keyword"],
      style: { color: "var(--foreground)", fontWeight: "600" },
    },
    { types: ["deleted"], style: { color: "var(--destructive)" } },
  ],
};

export function CodeBlock({
  code,
  language = "yaml",
  className,
  maxHeight = "32rem",
}: {
  code: string;
  language?: Language;
  className?: string;
  maxHeight?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className={cn("relative rounded-sm border bg-muted/40", className)}>
      <Button size="icon-sm" variant="ghost" className="absolute top-1.5 right-1.5 z-10" onClick={copy} aria-label="Copy">
        {copied ? <Check /> : <Copy />}
      </Button>
      <Highlight code={code.trimEnd()} language={language} theme={SIGNAL}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre
            className="overflow-auto p-3 pr-10 font-mono text-xs leading-relaxed"
            style={{ maxHeight, background: "transparent" }}
          >
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {line.map((token, j) => (
                  <span key={j} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}
