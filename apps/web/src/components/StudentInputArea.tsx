import React, { useState, useCallback, useRef, useEffect } from "react";
import { MathText } from "./MathText.js";

export interface StudentInputAreaProps {
  readonly onSubmit: (text: string) => Promise<void> | void;
  readonly disabled?: boolean;
  readonly isSubmitting?: boolean;
  readonly placeholder?: string;
  readonly className?: string;
}

const MAX_INPUT_CHARS = 20_000;

export const StudentInputArea: React.FC<StudentInputAreaProps> = ({
  onSubmit,
  disabled = false,
  isSubmitting = false,
  placeholder = "Type your mathematical reasoning (LaTeX math supported: $v \\in V$, $R(3,3)=6$)...",
  className = ""
}) => {
  const [draftText, setDraftText] = useState("");
  const [showPreview, setShowPreview] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const charCount = draftText.length;
  const isTooLong = charCount > MAX_INPUT_CHARS;
  const isEmpty = draftText.trim().length === 0;
  const canSubmit = !isEmpty && !isTooLong && !disabled && !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    const textToSend = draftText.trim();
    setDraftText("");
    try {
      await onSubmit(textToSend);
    } catch {
      // Restore draft text if submission fails
      setDraftText(textToSend);
    }
  }, [canSubmit, draftText, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Hotkey: Ctrl+Enter or Cmd+Enter to submit immediately
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit]
  );

  // Auto-resize textarea height as user types
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea !== null) {
      textarea.style.height = "auto";
      textarea.style.height = `${String(Math.min(textarea.scrollHeight, 240))}px`;
    }
  }, [draftText]);

  return (
    <div
      className={`student-input-area bg-white border border-slate-200 rounded-lg p-4 shadow-sm flex flex-col gap-3 ${className}`}
      data-testid="student-input-area"
    >
      <div className="flex items-center justify-between">
        <label
          htmlFor="student-reasoning-input"
          className="text-xs font-semibold uppercase tracking-wider text-slate-700 flex items-center gap-1.5"
        >
          <span>Your Mathematical Reasoning</span>
          <span className="text-slate-400 text-[11px] font-normal lowercase">
            (Supports LaTeX math: $...$ or $$...$$)
          </span>
        </label>
        <button
          type="button"
          onClick={() => setShowPreview((prev) => !prev)}
          className="text-xs text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
          data-testid="toggle-math-preview"
        >
          {showPreview ? "Hide Math Preview" : "Show Math Preview"}
        </button>
      </div>

      <div className="relative">
        <textarea
          id="student-reasoning-input"
          ref={textareaRef}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || isSubmitting}
          placeholder={placeholder}
          rows={3}
          className="w-full px-3 py-2 text-sm text-slate-900 border border-slate-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 focus:outline-none resize-none font-sans leading-relaxed disabled:bg-slate-100 disabled:text-slate-500 transition-shadow"
          data-testid="reasoning-textarea"
        />
      </div>

      {showPreview && draftText.trim().length > 0 && (
        <div
          className="live-math-preview bg-slate-50 border border-slate-200/80 rounded-md p-3 text-sm text-slate-800 max-h-36 overflow-y-auto"
          data-testid="live-math-preview"
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
            Live Math Preview
          </div>
          <div className="preview-content font-serif leading-relaxed">
            <MathText text={draftText} />
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-slate-100">
        <div className="flex items-center gap-2">
          <span
            className={`text-xs font-mono ${
              isTooLong
                ? "text-rose-600 font-semibold"
                : charCount > MAX_INPUT_CHARS * 0.9
                ? "text-amber-600"
                : "text-slate-400"
            }`}
            data-testid="char-counter"
          >
            {charCount.toLocaleString()} / {MAX_INPUT_CHARS.toLocaleString()} chars
          </span>
          <span className="text-[11px] text-slate-400 hidden sm:inline">
            • Press <kbd className="px-1 py-0.5 bg-slate-100 rounded border text-slate-600">Ctrl+Enter</kbd> to submit
          </span>
        </div>

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          className={`inline-flex items-center justify-center px-4 py-2 text-sm font-medium rounded-md shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 ${
            canSubmit
              ? "bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer"
              : "bg-slate-200 text-slate-400 cursor-not-allowed"
          }`}
          data-testid="submit-reasoning-btn"
        >
          {isSubmitting ? (
            <span className="inline-flex items-center gap-2">
              <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              <span>Sending...</span>
            </span>
          ) : (
            <span>Submit Reasoning</span>
          )}
        </button>
      </div>
    </div>
  );
};
