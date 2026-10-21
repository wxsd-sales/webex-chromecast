/**
 * Shared configuration for the Webex Chromecast client web app.
 */

/**
 * The published Cast application id for the custom Web Receiver in /receiver.
 * Register your receiver in the Google Cast Developer Console and replace this
 * value with your own application id. The receiver must be hosted over HTTPS.
 */
export const CHROMECAST_RECEIVER_APPLICATION_ID = "4103BEBF";

/** Google's Default Media Receiver. Any Chromecast on the LAN can use it. */
const DEFAULT_MEDIA_RECEIVER_APP_ID = "CC1AD845";

/**
 * Receiver application id to use for discovery. For debugging, add
 * `?castApp=default` (Default Media Receiver) or `?castApp=<APPID>` to the URL.
 *
 * With the default receiver every Chromecast on the network is listed. If
 * devices show up with it but not with the custom id, the custom receiver (or
 * the device registration in the Cast Developer Console) is the problem; if no
 * devices show up with either, it's discovery (network/browser/profile).
 */
export function resolveReceiverApplicationId() {
  const override = new URLSearchParams(window.location.search).get("castApp");

  if (override === "default") {
    return DEFAULT_MEDIA_RECEIVER_APP_ID;
  }

  if (override && /^[0-9A-F]{8}$/i.test(override)) {
    return override.toUpperCase();
  }

  return CHROMECAST_RECEIVER_APPLICATION_ID;
}

/**
 * Custom Cast message namespace used to exchange meeting-join instructions and
 * status updates between this sender app and the custom receiver. Cast requires
 * custom namespaces to start with "urn:x-cast:".
 */
export const CAST_NAMESPACE = "urn:x-cast:com.cisco.wxsd.webex-chromecast";

/**
 * Message types exchanged over CAST_NAMESPACE.
 */
export const CAST_MESSAGE_TYPES = {
  /** Sender -> receiver: join a meeting and display its media. */
  JOIN_MEETING: "JOIN_MEETING",
  /** Sender -> receiver: leave the current meeting. */
  LEAVE_MEETING: "LEAVE_MEETING",
  /** Receiver -> sender: status/lifecycle updates. */
  STATUS: "STATUS",
};
