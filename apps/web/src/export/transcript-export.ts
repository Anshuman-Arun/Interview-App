import type { SessionId } from "../../../../packages/domain/src/index.js";
import type {
  SessionEvaluationReadResponse,
  SessionReplayReadResponse
} from "../../../../packages/replay/src/index.js";

function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

export function generateLatexTranscript({
  sessionId,
  problemTitle = "Oxford Tutorial",
  evaluation,
  replay
}: {
  readonly sessionId: SessionId;
  readonly problemTitle?: string;
  readonly evaluation: SessionEvaluationReadResponse | null;
  readonly replay: SessionReplayReadResponse | null;
}): string {
  const evalData = evaluation?.available ? evaluation.evaluation : null;
  const replayEntries = replay?.available ? replay.replay.entries : [];
  const dateStr = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });

  let latex = `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath, amssymb, amsfonts}
\\usepackage[margin=1in]{geometry}
\\usepackage{xcolor}
\\usepackage{tcolorbox}
\\usepackage{booktabs}
\\usepackage{enumitem}
\\usepackage{hyperref}

\\definecolor{oxfordblue}{RGB}{0, 33, 71}
\\definecolor{accentgold}{RGB}{180, 130, 40}
\\definecolor{faintbg}{RGB}{248, 249, 250}
\\definecolor{speechinterviewer}{RGB}{240, 244, 250}
\\definecolor{speechstudent}{RGB}{250, 248, 244}

\\title{\\textbf{\\color{oxfordblue} Oxford Tutorial Summary \\& Transcript}\\\\
\\large \\textsc{${escapeLatex(problemTitle)}}}
\\author{\\textbf{Session}: \\texttt{${escapeLatex(sessionId)}}}
\\date{${escapeLatex(dateStr)}}

\\begin{document}
\\maketitle

\\vspace{-1.5em}
\\noindent\\rule{\\textwidth}{1pt}

\\section*{Tutorial Evaluation Summary}
`;

  if (evalData !== null) {
    latex += `\\begin{tcolorbox}[colback=faintbg,colframe=oxfordblue,title=\\textbf{Tutor Evaluation: ${evalData.composite.score !== null ? evalData.composite.score + " / 100" : "Completed"}}]
\\textbf{Summary}: ${escapeLatex(evalData.summaryAssessment)}

\\vspace{0.5em}
\\textbf{Dimension Scores}:
\\begin{itemize}[noitemsep,topsep=0pt]
`;
    for (const dim of evalData.dimensions) {
      latex += `  \\item \\textbf{${escapeLatex(dim.name)}}: ${dim.score !== null ? dim.score : "N/A"}${dim.notScoredReason ? " (" + escapeLatex(dim.notScoredReason) + ")" : ""}\n`;
    }
    latex += `\\end{itemize}

\\vspace{0.5em}
\\textbf{Key Strengths}:
\\begin{itemize}[noitemsep,topsep=0pt]
`;
    if (evalData.keyStrengths.length > 0) {
      for (const s of evalData.keyStrengths) {
        latex += `  \\item ${escapeLatex(s)}\n`;
      }
    } else {
      latex += `  \\item None recorded.\n`;
    }
    latex += `\\end{itemize}

\\vspace{0.5em}
\\textbf{Areas for Improvement}:
\\begin{itemize}[noitemsep,topsep=0pt]
`;
    if (evalData.areasForImprovement.length > 0) {
      for (const a of evalData.areasForImprovement) {
        latex += `  \\item ${escapeLatex(a)}\n`;
      }
    } else {
      latex += `  \\item None recorded.\n`;
    }
    latex += `\\end{itemize}
\\end{tcolorbox}
`;
  } else {
    latex += `\\textit{Formal grounded evaluation data not yet compiled for this session.}\n`;
  }

  latex += `
\\section*{Chronological Dialogue \\& Whiteboard Transcript}
`;

  if (replayEntries.length === 0) {
    latex += `\\textit{No timeline replay entries recorded.}\n`;
  } else {
    for (const entry of replayEntries) {
      const time = new Date(entry.occurredAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });

      if (entry.category === "INTERVIEWER_DELIVERY") {
        const text = entry.text?.text ?? entry.summary;
        latex += `
\\begin{tcolorbox}[colback=speechinterviewer,colframe=oxfordblue!40,title={\\textbf{Tutor} \\hfill \\footnotesize ${escapeLatex(time)}}]
${escapeLatex(text)}
\\end{tcolorbox}
`;
      } else if (entry.category === "STUDENT") {
        const text = entry.text?.text ?? entry.summary;
        latex += `
\\begin{tcolorbox}[colback=speechstudent,colframe=accentgold!50,title={\\textbf{Candidate} \\hfill \\footnotesize ${escapeLatex(time)}}]
${escapeLatex(text)}
\\end{tcolorbox}
`;
      } else if (entry.category === "WHITEBOARD") {
        const op = entry.delivery?.boardAction?.operation ?? "Whiteboard snapshot";
        const content = entry.delivery?.boardAction?.content?.text ?? entry.summary;
        latex += `
\\begin{tcolorbox}[colback=white,colframe=gray!40,title={\\textbf{Whiteboard Snapshot} (${escapeLatex(op)}) \\hfill \\footnotesize ${escapeLatex(time)}}]
\\texttt{${escapeLatex(content)}}
\\end{tcolorbox}
`;
      } else if (entry.category === "LIFECYCLE") {
        latex += `
\\begin{center}
\\small\\textsc{--- Problem Transition / Milestone: ${escapeLatex(entry.summary)} (${escapeLatex(time)}) ---}
\\end{center}
`;
      }
    }
  }

  latex += `
\\vspace{2em}
\\noindent\\rule{\\textwidth}{0.5pt}\\\\
\\footnotesize \\textit{Generated by Interview App Oxford Mathematics Tutorial Engine on ${escapeLatex(dateStr)}}

\\end{document}
`;

  return latex;
}

export function downloadLatexTranscript(args: {
  readonly sessionId: SessionId;
  readonly problemTitle?: string;
  readonly evaluation: SessionEvaluationReadResponse | null;
  readonly replay: SessionReplayReadResponse | null;
}): void {
  const latex = generateLatexTranscript(args);
  const blob = new Blob([latex], { type: "text/x-tex;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `Oxford_Tutorial_Transcript_${args.sessionId}.tex`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportPrintablePdfTranscript(args: {
  readonly sessionId: SessionId;
  readonly problemTitle?: string;
  readonly evaluation: SessionEvaluationReadResponse | null;
  readonly replay: SessionReplayReadResponse | null;
}): void {
  const evalData = args.evaluation?.available ? args.evaluation.evaluation : null;
  const replayEntries = args.replay?.available ? args.replay.replay.entries : [];
  const dateStr = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });

  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    alert("Please allow popups to export the PDF transcript.");
    return;
  }

  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Oxford Tutorial Summary - ${args.sessionId}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", serif;
      line-height: 1.5;
      color: #1a1a1a;
      max-width: 800px;
      margin: 30px auto;
      padding: 0 20px;
    }
    header {
      border-bottom: 2px solid #002147;
      padding-bottom: 12px;
      margin-bottom: 24px;
    }
    h1 { margin: 0 0 6px 0; font-size: 24px; color: #002147; }
    .meta { font-size: 13px; color: #666; display: flex; justify-content: space-between; }
    .eval-box {
      border: 1px solid #002147;
      border-radius: 4px;
      background: #f8f9fa;
      padding: 16px;
      margin-bottom: 28px;
    }
    .eval-box h2 { margin: 0 0 10px 0; font-size: 16px; color: #002147; }
    .transcript-entry {
      border-left: 3px solid #ccc;
      padding: 8px 12px;
      margin-bottom: 14px;
      background: #fff;
    }
    .interviewer { border-left-color: #002147; background: #f0f4fa; }
    .student { border-left-color: #b48228; background: #faf8f4; }
    .whiteboard { border-left-color: #888; background: #f9f9f9; font-family: monospace; }
    .entry-head { font-size: 11px; font-weight: 700; color: #555; margin-bottom: 4px; display: flex; justify-content: space-between; }
    .entry-body { font-size: 13px; white-space: pre-wrap; }
    @media print {
      body { margin: 0; max-width: 100%; }
      @page { margin: 1.5cm; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Oxford Tutorial Summary & Transcript</h1>
    <div class="meta">
      <span><strong>Topic:</strong> ${args.problemTitle ?? "Oxford Mathematics"}</span>
      <span><strong>Session:</strong> ${args.sessionId}</span>
      <span><strong>Date:</strong> ${dateStr}</span>
    </div>
  </header>
`;

  if (evalData !== null) {
    html += `
  <section class="eval-box">
    <h2>Tutorial Evaluation: ${evalData.composite.score !== null ? evalData.composite.score + " / 100" : "Completed"}</h2>
    <p><strong>Tutor Assessment:</strong> ${evalData.summaryAssessment}</p>
    ${evalData.keyStrengths.length > 0 ? `<p><strong>Key Strengths:</strong> ${evalData.keyStrengths.join("; ")}</p>` : ""}
    ${evalData.areasForImprovement.length > 0 ? `<p><strong>Areas for Improvement:</strong> ${evalData.areasForImprovement.join("; ")}</p>` : ""}
  </section>
`;
  }

  html += `
  <section>
    <h2>Dialogue & Whiteboard Transcript</h2>
`;

  for (const entry of replayEntries) {
    const time = new Date(entry.occurredAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    const cls = entry.category === "INTERVIEWER_DELIVERY"
      ? "interviewer"
      : entry.category === "STUDENT"
        ? "student"
        : entry.category === "WHITEBOARD"
          ? "whiteboard"
          : "";
    const label = entry.category === "INTERVIEWER_DELIVERY"
      ? "Tutor"
      : entry.category === "STUDENT"
        ? "Candidate"
        : entry.category === "WHITEBOARD"
          ? "Whiteboard Snapshot"
          : entry.summary;
    const body = entry.text?.text ?? entry.delivery?.boardAction?.content?.text ?? entry.summary;

    html += `
    <div class="transcript-entry ${cls}">
      <div class="entry-head"><span>${label}</span><span>${time}</span></div>
      <div class="entry-body">${body}</div>
    </div>
`;
  }

  html += `
  </section>
  <script>
    window.onload = function() {
      setTimeout(function() { window.print(); }, 200);
    };
  </script>
</body>
</html>`;

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}
