/**
 * Where an integration (JIRA / TestRail) may send its credentials. The address the browser actually calls - the proxy when one is
 * configured, otherwise the instance itself - must be https://. Plain http:// is accepted only for a service on this computer
 * (localhost, 127.0.0.1, [::1]) so local development keeps working. One rule for Settings, the stored-connection loader and the clients.
 */

const HTTP_URL = /^https?:\/\/[^\s/]+/i;
const LOCAL_HTTP = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

export function isHttpUrl(value: string): boolean {
  return HTTP_URL.test(value.trim());
}

/** True for a plain-http address that is not on this computer (credentials would cross the network unencrypted). */
export function isInsecureRemoteUrl(value: string): boolean {
  const v = value.trim();
  return /^http:\/\//i.test(v) && !LOCAL_HTTP.test(v);
}

/** An address credentials may be sent to: https:// anywhere, or http:// on this computer only. */
export function isSecureIntegrationUrl(value: string): boolean {
  return isHttpUrl(value) && !isInsecureRemoteUrl(value);
}
