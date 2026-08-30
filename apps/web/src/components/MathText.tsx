import React, { useMemo } from "react";
import katex from "katex";

export type MathSegmentType = "text" | "inline-math" | "block-math";

export interface MathSegment {
  readonly type: MathSegmentType;
  readonly content: string;
}

export interface MathTextProps {
  readonly text: string;
  readonly className?: string;
  readonly block?: boolean;
}

/**
 * Parses LaTeX math delimiters into text, inline-math, and block-math segments.
 * Supported delimiters:
 * - Block math: `$$...$$` or `\[...\]`
 * - Inline math: `$...$` or `\(...\)`
 */
export function parseMathSegments(input: string): readonly MathSegment[] {
  if (input.length === 0) {
    return [];
  }

  const segments: MathSegment[] = [];
  // Tokenize regex matching block math ($$...$$ or \[...\]) or inline math ($...$ or \(...\))
  const mathRegex = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$(?!\$)((?:\\.|[^$\\\n])+?)\$|\\\([\s\S]*?\\\))/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mathRegex.exec(input)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        content: input.slice(lastIndex, match.index)
      });
    }

    const token = match[0];
    if (token.startsWith("$$") && token.endsWith("$$")) {
      segments.push({
        type: "block-math",
        content: token.slice(2, -2).trim()
      });
    } else if (token.startsWith("\\[") && token.endsWith("\\]")) {
      segments.push({
        type: "block-math",
        content: token.slice(2, -2).trim()
      });
    } else if (token.startsWith("\\(") && token.endsWith("\\)")) {
      segments.push({
        type: "inline-math",
        content: token.slice(2, -2).trim()
      });
    } else if (token.startsWith("$") && token.endsWith("$")) {
      segments.push({
        type: "inline-math",
        content: token.slice(1, -1).trim()
      });
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < input.length) {
    segments.push({
      type: "text",
      content: input.slice(lastIndex)
    });
  }

  return segments;
}

/**
 * Render LaTeX math expression to HTML string using KaTeX.
 */
export function renderKaTeXToString(formula: string, displayMode: boolean): string {
  try {
    return katex.renderToString(formula, {
      displayMode,
      throwOnError: false,
      output: "htmlAndMathml"
    });
  } catch {
    // If KaTeX encounters a fatal error, return empty string so caller can fallback
    return "";
  }
}

export const MathText: React.FC<MathTextProps> = ({
  text,
  className = "",
  block = false
}) => {
  const segments = useMemo(() => parseMathSegments(text), [text]);

  return (
    <span className={`math-text-container ${className}`}>
      {segments.map((segment, index) => {
        if (segment.type === "text") {
          return <span key={index}>{segment.content}</span>;
        }

        const isBlock = segment.type === "block-math" || block;
        const html = renderKaTeXToString(segment.content, isBlock);

        if (html.length === 0) {
          return (
            <code
              key={index}
              className="katex-fallback text-red-600 font-mono text-sm px-1 py-0.5 bg-red-50 rounded"
            >
              {segment.content}
            </code>
          );
        }

        return (
          <span
            key={index}
            className={
              isBlock
                ? "katex-block-wrapper my-2 block overflow-x-auto text-center"
                : "katex-inline-wrapper inline align-baseline"
            }
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      })}
    </span>
  );
};
