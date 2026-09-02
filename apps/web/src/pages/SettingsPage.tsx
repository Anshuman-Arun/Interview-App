import React, { useEffect, useState } from "react";
import { ThemeControl } from "../components/ThemeControl.js";
import styles from "./SettingsPage.module.css";

export interface SettingsPageProps {
  readonly baseUrl: string;
  readonly isTransportManaged: boolean;
  readonly connectionLocked: boolean;
  readonly onSaveBaseUrl: (baseUrl: string) => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  baseUrl,
  isTransportManaged,
  connectionLocked,
  onSaveBaseUrl
}) => {
  const [draftBaseUrl, setDraftBaseUrl] = useState(baseUrl);

  useEffect(() => {
    setDraftBaseUrl(baseUrl);
  }, [baseUrl]);

  const handleSubmit = (event: React.SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (isTransportManaged || connectionLocked) return;
    onSaveBaseUrl(draftBaseUrl.trim());
  };

  return (
    <div className={styles.settings ?? ""}>
      <section className={styles.section}>
        <div className={styles.sectionCopy}>
          <h2>Appearance</h2>
          <p>Choose a local interface theme. This preference is not part of interview state.</p>
        </div>
        <div className={styles.sectionControl}>
          <ThemeControl />
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionCopy}>
          <h2>Connection</h2>
          <p>
            {isTransportManaged
              ? "The trusted desktop runtime manages the local command connection."
              : connectionLocked
                ? "Connection changes are locked while an interview is active."
                : "Configure the browser-mode loopback command origin."}
          </p>
        </div>

        <div className={styles.sectionControl}>
          {isTransportManaged ? (
            <div className={styles.managedConnection}>
              <span className={styles.managedDot} aria-hidden="true" />
              <div>
                <strong>Desktop managed</strong>
                <code>{baseUrl}</code>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className={styles.connectionForm}>
              <label htmlFor="settings-command-url">Loopback command URL</label>
              <div>
                <input
                  id="settings-command-url"
                  type="url"
                  value={draftBaseUrl}
                  onChange={(event) => setDraftBaseUrl(event.target.value)}
                  placeholder="http://127.0.0.1:43123"
                  disabled={connectionLocked}
                />
                <button
                  type="submit"
                  disabled={connectionLocked || draftBaseUrl.trim().length === 0}
                >
                  Save
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>
  );
};
