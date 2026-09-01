"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "interview-desktop:get-bootstrap";
const AUTH_HEADER_VALUE = "desktop-managed-v1";

function isExactLoopbackOrigin(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:"
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.pathname === "/"
      && parsed.search.length === 0
      && parsed.hash.length === 0;
  } catch {
    return false;
  }
}

function hasExactKeys(value, expectedKeys) {
  if (typeof value !== "object" || value === null) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validateBootstrap(value) {
  if (typeof value !== "object" || value === null) throw new Error("Desktop bootstrap is unavailable");
  if (
    !hasExactKeys(value, [
      "protocolVersion",
      "commandBaseUrl",
      "rendererStreamUrl",
      "authentication",
      "appVersion",
      "platform"
    ])
    || !hasExactKeys(value.authentication, ["mode", "headerValue"])
    ||
    value.protocolVersion !== 1
    || !isExactLoopbackOrigin(value.commandBaseUrl)
    || typeof value.rendererStreamUrl !== "string"
    || typeof value.authentication !== "object"
    || value.authentication === null
    || value.authentication.mode !== "DESKTOP_MANAGED"
    || value.authentication.headerValue !== AUTH_HEADER_VALUE
    || typeof value.appVersion !== "string"
    || value.appVersion.trim().length === 0
    || typeof value.platform !== "string"
    || value.platform.trim().length === 0
  ) {
    throw new Error("Desktop bootstrap is malformed");
  }
  const stream = new URL(value.rendererStreamUrl);
  if (
    stream.protocol !== "http:"
    || (stream.hostname !== "127.0.0.1" && stream.hostname !== "[::1]")
    || stream.username.length !== 0
    || stream.password.length !== 0
    || stream.pathname !== "/v1/renderer-stream"
    || stream.search.length !== 0
    || stream.hash.length !== 0
  ) {
    throw new Error("Desktop bootstrap is malformed");
  }
  return Object.freeze({
    protocolVersion: 1,
    commandBaseUrl: value.commandBaseUrl,
    rendererStreamUrl: value.rendererStreamUrl,
    authentication: Object.freeze({
      mode: "DESKTOP_MANAGED",
      headerValue: AUTH_HEADER_VALUE
    }),
    appVersion: value.appVersion,
    platform: value.platform
  });
}

const bootstrap = validateBootstrap(ipcRenderer.sendSync(CHANNEL));
contextBridge.exposeInMainWorld("interviewDesktop", Object.freeze({
  getBootstrap: () => ({
    ...bootstrap,
    authentication: { ...bootstrap.authentication }
  })
}));
