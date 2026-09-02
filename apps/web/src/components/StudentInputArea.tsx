import React, { useState, useCallback, useRef, useEffect } from "react";
import { MathText } from "./MathText.js";
import "./StudentInputArea.css";

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
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const submissionPendingRef = useRef(false);

  const charCount = draftText.length;
  const isTooLong = charCount > MAX_INPUT_CHARS;
  const isEmpty = draftText.trim().length === 0;
  const submissionLocked = isSubmitting || localSubmitting;
  const canSubmit =
    !isEmpty && !isTooLong && !disabled && !submissionLocked;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || submissionPendingRef.current) return;

    const textToSend = draftText.trim();
    submissionPendingRef.current = true;
    setLocalSubmitting(true);
    setDraftText("");

    try {
      await onSubmit(textToSend);
    } catch {
      setDraftText((current) => current.length === 0 ? textToSend : current);
    } finally {
      submissionPendingRef.current = false;
      setLocalSubmitting(false);
    }
  }, [canSubmit, draftText, onSubmit]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit]
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea !== null) {
      textarea.style.height = "auto";
      textarea.style.height = `${String(Math.min(textarea.scrollHeight, 210))}px`;
    }
  }, [draftText]);

  return (
    <div
      className={`reasoning-composer student-input-area ${className}`}
      data-testid="student-input-area"
    >
      <div className="reasoning-composer__head">
        <label htmlFor="student-reasoning-input">
          <span>Your Mathematical Reasoning</span>
          <small>LaTeX supported · $...$ or $$...$$</small>
        </label>

        <button
          type="button"
          onClick={() => setShowPreview((previous) => !previous)}
          data-testid="toggle-math-preview"
        >
          {showPreview ? "Hide Math Preview" : "Show Math Preview"}
        </button>
      </div>

      <textarea
        id="student-reasoning-input"
        ref={textareaRef}
        value={draftText}
        onChange={(event) => setDraftText(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled || submissionLocked}
        placeholder={placeholder}
        rows={3}
        className="reasoning-composer__textarea"
        data-testid="reasoning-textarea"
      />

      {showPreview && draftText.trim().length > 0 && (
        <div
          className="reasoning-composer__preview live-math-preview"
          data-testid="live-math-preview"
        >
          <span>Preview</span>
          <div className="preview-content">
            <MathText text={draftText} />
          </div>
        </div>
      )}

      <div className="reasoning-composer__foot">
        <div className="reasoning-composer__meta">
          <span
            data-testid="char-counter"
            data-warning={String(charCount > MAX_INPUT_CHARS * 0.9)}
            data-error={String(isTooLong)}
          >
            {charCount.toLocaleString()} / {MAX_INPUT_CHARS.toLocaleString()} chars
          </span>
          <span>
            Press <kbd>Ctrl+Enter</kbd> to submit
          </span>
        </div>

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          className={
            canSubmit
              ? "reasoning-composer__submit"
              : "reasoning-composer__submit cursor-not-allowed"
          }
          data-testid="submit-reasoning-btn"
        >
          {submissionLocked ? "Sending..." : "Submit Reasoning"}
        </button>
      </div>
    </div>
  );
};
