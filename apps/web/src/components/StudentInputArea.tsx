import React, {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { MathText } from "./MathText.js";
import styles from "./StudentInputArea.module.css";

export interface StudentInputAreaProps {
  readonly onSubmit: (text: string) => Promise<void> | void;
  readonly disabled?: boolean;
  readonly isSubmitting?: boolean;
  readonly placeholder?: string;
  readonly className?: string;
}

const MAX_INPUT_CHARS = 20_000;
const CHARACTER_WARNING_THRESHOLD = MAX_INPUT_CHARS * 0.8;
const MAX_TEXTAREA_HEIGHT_PX = 220;

export const StudentInputArea: React.FC<StudentInputAreaProps> = ({
  onSubmit,
  disabled = false,
  isSubmitting = false,
  placeholder = "Explain your reasoning…",
  className = ""
}) => {
  const [draftText, setDraftText] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const charCount = draftText.length;
  const isTooLong = charCount > MAX_INPUT_CHARS;
  const isEmpty = draftText.trim().length === 0;
  const canSubmit = !isEmpty && !isTooLong && !disabled && !isSubmitting;
  const shouldShowCharacterCount =
    charCount >= CHARACTER_WARNING_THRESHOLD || isTooLong;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    const textToSend = draftText.trim();
    setDraftText("");
    try {
      await onSubmit(textToSend);
    } catch {
      setDraftText(textToSend);
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
    if (textarea === null) return;
    textarea.style.height = "auto";
    textarea.style.height =
      `${String(Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX))}px`;
  }, [draftText]);

  return (
    <section
      className={`${styles.composer ?? ""} ${className}`}
      data-testid="student-input-area"
      aria-label="Reasoning composer"
    >
      <label htmlFor="student-reasoning-input" className={styles.srOnly}>
        Your mathematical reasoning
      </label>

      <textarea
        id="student-reasoning-input"
        ref={textareaRef}
        value={draftText}
        onChange={(event) => setDraftText(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled || isSubmitting}
        placeholder={placeholder}
        rows={2}
        maxLength={MAX_INPUT_CHARS}
        className={styles.textarea}
        data-testid="reasoning-textarea"
      />

      {showPreview && draftText.trim().length > 0 && (
        <div className={styles.preview} data-testid="live-math-preview">
          <div className={styles.previewLabel}>Math preview</div>
          <div className={styles.previewContent}>
            <MathText text={draftText} />
          </div>
        </div>
      )}

      <footer className={styles.toolbar}>
        <div className={styles.secondaryActions}>
          <button
            type="button"
            onClick={() => setShowPreview((current) => !current)}
            className={styles.textButton}
            data-testid="toggle-math-preview"
          >
            {showPreview ? "Hide preview" : "Preview"}
          </button>
          <span className={styles.shortcut}>
            <kbd>Ctrl</kbd><span aria-hidden="true">+</span><kbd>Enter</kbd>
          </span>
          <span
            className={`${styles.characterCount ?? ""} ${isTooLong ? (styles.characterCountDanger ?? "") : ""}`}
            data-testid="char-counter"
            aria-live="polite"
          >
            {shouldShowCharacterCount
              ? `${charCount.toLocaleString()} / ${MAX_INPUT_CHARS.toLocaleString()}`
              : ""}
          </span>
        </div>

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          className={styles.submitButton}
          data-testid="submit-reasoning-btn"
        >
          {isSubmitting ? "Sending…" : "Send"}
          {!isSubmitting && <span className={styles.submitHint} aria-hidden="true">↵</span>}
        </button>
      </footer>
    </section>
  );
};
